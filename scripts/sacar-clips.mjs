#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { getVideoContext, getSharedTranscript, PROJECT_ROOT } from './pipeline-cache.mjs';
import { getYoutubeReview, getDiscovery, selectCandidates, SELECTION_RULES_VERSION } from './pipeline-analysis.mjs';
import { renderSelected } from './pipeline-render.mjs';
import { framingForClip } from './framing/framing-cache.mjs';
import { previewFraming } from './framing/preview.mjs';
import { SMART_FRAMING_VERSION } from './framing/version.mjs';
import { FRAMING_SCORE_REVISION } from './framing/framing-score.mjs';
import { timestamp, sha256 } from './youtube-core.mjs';
import { readJson, saveJson } from './pipeline-runtime.mjs';

export function parseClipOptions(args) {
  const options = { cantidad: Infinity, minScore: 7.5, encoder: 'auto', debug: false,
    detectSidebars: true, previewFraming: false, debugFraming: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--debug') options.debug = true;
    else if (arg === '--preview-framing') options.previewFraming = true;
    else if (arg === '--debug-framing') options.debugFraming = true;
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

async function framing(context, candidates, options) {
  const path = join(context.dir, 'framing.json');
  const key = sha256(JSON.stringify({ candidates: candidates.filter((item) => item.selected).map((item) => [item.start, item.end]),
    smartFramingVersion: SMART_FRAMING_VERSION, scoreRevision: FRAMING_SCORE_REVISION,
    detectSidebars: options.detectSidebars,
    preview: options.previewFraming }));
  const cached = readJson(path);
  if (cached?.cacheKey === key && Array.isArray(cached.clips) && !cached.clips.some((clip) => clip.analysisError)) return cached;
  const clips = [];
  const selected = candidates.filter((candidate) => candidate.selected);
  for (const item of options.previewFraming ? selected.slice(0, 1) : selected) {
    const decision = await framingForClip(context, item, { logger: console.log });
    clips.push({ hook: item.hook, start: item.start, end: item.end, ...decision });
  }
  const result = { cacheKey: key, smartFramingVersion: SMART_FRAMING_VERSION, clips };
  if (!clips.some((clip) => clip.analysisError)) saveJson(path, result);
  return result;
}

export function formatFramingDebug(decision) {
  const lines = [`[SMART FRAMING v${decision.version}]`, `contentType: ${decision.contentType}`,
    `source: ${decision.source.width}x${decision.source.height} (${decision.source.aspect})`,
    `subjects: ${decision.subjects.length}`];
  for (const candidate of decision.candidates) lines.push(`candidate: ${candidate.strategy}${candidate.variant ? ` (${candidate.variant})` : ''} | aspect ${candidate.metrics.effectiveContentAspect} | coverage ${Math.round(candidate.metrics.subjectCoverage * 100)}% | wasted ${Math.round(candidate.metrics.wastedSpace * 100)}% | score ${candidate.metrics.score}`);
  lines.push(`selected: ${decision.strategy}`, `reason: ${decision.reason}`,
    `time: extraction ${decision.timings.extractionMs} ms, analysis ${decision.timings.visualAnalysisMs} ms, decision ${decision.timings.classificationAndDecisionMs} ms`);
  return lines.join('\n');
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
  const layout = await framing(context, candidates, options);
  if (options.debugFraming) for (const decision of layout.clips) console.log(formatFramingDebug(decision));
  let exported = [];
  if (options.previewFraming && selected.length) {
    const previewStarted = performance.now();
    const path = await previewFraming(context, selected[0], layout.clips[0]);
    console.log(`Preview de framing: ${path} (${Math.round(performance.now() - previewStarted)} ms)`);
  } else if (mode === 'sacar' && selected.length) {
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
