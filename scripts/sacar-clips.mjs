#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { getVideoContext, getSharedTranscript, PROJECT_ROOT } from './pipeline-cache.mjs';
import { getYoutubeReview, getDiscovery, selectCandidates, SELECTION_RULES_VERSION } from './pipeline-analysis.mjs';
import { framingForCandidate, LAYOUT_VERSION, renderSelected } from './pipeline-render.mjs';
import { timestamp, sha256 } from './youtube-core.mjs';
import { readJson, saveJson } from './pipeline-runtime.mjs';

export function parseClipOptions(args) {
  const options = { cantidad: Infinity, minScore: 7.5, encoder: 'auto', debug: false, detectSidebars: true };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--debug') options.debug = true;
    else if (arg === '--detect-sidebars') options.detectSidebars = true;
    else if (['--cantidad', '--min-score', '--encoder'].includes(arg)) {
      if (!args[index + 1]) throw new Error(`Falta el valor de ${arg}.`);
      const value = args[++index];
      if (arg === '--cantidad') options.cantidad = Number(value);
      if (arg === '--min-score') options.minScore = Number(value);
      if (arg === '--encoder') options.encoder = value;
    } else throw new Error(`Opción desconocida: ${arg}`);
  }
  if (!(options.cantidad === Infinity || Number.isSafeInteger(options.cantidad) && options.cantidad > 0)) throw new Error('--cantidad debe ser un entero positivo.');
  if (!Number.isFinite(options.minScore) || options.minScore < 0 || options.minScore > 10) throw new Error('--min-score debe estar entre 0 y 10.');
  if (!['auto', 'libx264', 'h264_amf', 'h264_nvenc'].includes(options.encoder)) throw new Error('--encoder debe ser auto, libx264, h264_amf o h264_nvenc.');
  return options;
}

async function framing(context, candidates, detectSidebars) {
  const path = join(context.dir, 'framing.json');
  const key = sha256(JSON.stringify({ candidates: candidates.filter((item) => item.selected).map((item) => [item.start, item.end]),
    layoutVersion: LAYOUT_VERSION, detectSidebars }));
  const cached = readJson(path);
  if (cached?.cacheKey === key && Array.isArray(cached.clips)) return cached;
  const clips = [];
  for (const item of candidates.filter((candidate) => candidate.selected)) {
    clips.push({ hook: item.hook, start: item.start, end: item.end, ...await framingForCandidate(context, item, detectSidebars) });
  }
  const result = { cacheKey: key, layoutVersion: LAYOUT_VERSION, clips };
  saveJson(path, result);
  return result;
}

function report(context, candidates, exported) {
  const lines = [`VIDEO:\n${basename(context.metadata.source)}`, `DURACIÓN:\n${timestamp(context.metadata.duration)}`,
    `CANDIDATOS:\n${candidates.length}`, `SELECCIONADOS:\n${candidates.filter((item) => item.selected).length}`,
    `MP4 GENERADOS O REUTILIZADOS:\n${exported.length}`];
  candidates.forEach((item, index) => lines.push(`${index + 1}. ${item.hook}\n${timestamp(item.start)} -> ${timestamp(item.end)}\nDuración: ${item.duration} s\nViral: ${item.viralScore}\nSeleccionado: ${item.selected ? 'sí' : 'no'}\nMotivo: ${item.exclusionReason || item.reason}`));
  if (exported.length) lines.push(`ARCHIVOS:\n${exported.join('\n')}`);
  writeFileSync(join(context.dir, 'reporte-clips.txt'), lines.join('\n\n') + '\n', 'utf8');
}

async function main() {
  const mode = process.argv[2];
  const source = process.argv[3] ? resolve(process.argv[3]) : null;
  if (!['analizar', 'sacar'].includes(mode) || !source) throw new Error('Uso: npm.cmd run analizar-clips -- "ruta\\video.mp4" o npm.cmd run sacar-clips -- "ruta\\video.mp4" [--cantidad N] [--min-score 7] [--encoder auto] [--debug]');
  const options = parseClipOptions(process.argv.slice(4));
  console.log('[1/7] Preparando video...');
  const context = await getVideoContext(source);
  console.log('[2/7] Transcripción compartida...');
  const transcriptData = await getSharedTranscript(context);
  console.log('[3/7] Comprobando cortes de idoneidad...');
  const review = await getYoutubeReview(context, transcriptData);
  console.log(`  ${review.cuts.length} corte(s) ${review.cached ? 'en caché' : 'calculados'}.`);
  console.log('[4/7] Descubriendo momentos...');
  const discovery = await getDiscovery(context, transcriptData, review.cuts);
  console.log(`  ${discovery.candidates.length} candidato(s) ${discovery.cached ? 'en caché' : 'encontrados'}.`);
  console.log('[5/7] Seleccionando clips...');
  const selectionKey = sha256(JSON.stringify({ discoveryKey: discovery.cacheKey, cuts: review.cuts,
    cantidad: options.cantidad === Infinity ? null : options.cantidad, minScore: options.minScore, version: SELECTION_RULES_VERSION }));
  const candidatesPath = join(context.dir, 'candidates.json');
  const cached = readJson(candidatesPath);
  const candidates = cached?.selectionKey === selectionKey ? cached.candidates :
    selectCandidates(discovery.candidates, review.cuts, transcriptData.transcript, options);
  if (cached?.selectionKey !== selectionKey) saveJson(candidatesPath, { selectionKey, candidates });
  const selected = candidates.filter((item) => item.selected);
  console.log(`  ${selected.length} seleccionado(s), máximo ${options.cantidad === Infinity ? 'sin límite' : options.cantidad}, mínimo viral ${options.minScore}.`);
  const layout = await framing(context, candidates, options.detectSidebars);
  let exported = [];
  if (mode === 'sacar' && selected.length) {
    console.log('[6/7] Renderizando secuencialmente...');
    exported = await renderSelected(context, selected, layout, options);
  } else console.log('[6/7] No se renderizaron MP4.');
  report(context, candidates, exported);
  console.log(`[7/7] Listo. ${selected.length} seleccionado(s), ${exported.length} MP4 generados o reutilizados.`);
  console.log(`Reporte: ${join(context.dir, 'reporte-clips.txt')}`);
  if (exported.length) console.log(exported.join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(PROJECT_ROOT, 'scripts', 'sacar-clips.mjs')) {
  main().catch((error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}
