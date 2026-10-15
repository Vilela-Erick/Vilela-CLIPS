#!/usr/bin/env node
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVideoContext, getSharedTranscript, PROJECT_ROOT } from './pipeline-cache.mjs';
import { getYoutubeReview } from './pipeline-analysis.mjs';
import { keptRanges, report, sha256 } from './youtube-core.mjs';
import { readJson, runProcess, saveJson } from './pipeline-runtime.mjs';

const command = process.argv[2];
const source = process.argv[3] ? resolve(process.argv[3]) : null;
const work = join(PROJECT_ROOT, 'work');
const output = join(PROJECT_ROOT, 'output');

function uniqueOutput(sourcePath) {
  const stem = basename(sourcePath, extname(sourcePath));
  for (let n = 1; ; n++) {
    const path = join(output, `${stem}-limpio${n === 1 ? '' : `-${n}`}.mp4`);
    try { closeSync(openSync(path, 'wx')); return path; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

export async function renderClean(context, cuts, destination) {
  const { metadata, dir } = context;
  const kept = keptRanges(cuts, metadata.duration);
  if (!kept.length) throw new Error('Los cortes eliminan todo el video. Revisa cuts.json.');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', '-i', metadata.source];
  if (cuts.length) {
    const filter = kept.flatMap(([start, end], index) => [
      `[0:${metadata.videoStreamIndex}]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`,
      `[0:${metadata.audioStreamIndex}]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`,
    ]);
    filter.push(`${kept.map((_, index) => `[v${index}][a${index}]`).join('')}concat=n=${kept.length}:v=1:a=1[v][a]`);
    args.push('-filter_complex', filter.join(';'), '-map', '[v]', '-map', '[a]');
  } else args.push('-map', `0:${metadata.videoStreamIndex}`, '-map', `0:${metadata.audioStreamIndex}`);
  args.push('-sn', '-dn', '-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', destination);
  await runProcess('ffmpeg', args, { cwd: PROJECT_ROOT, timeoutMs: 6 * 60 * 60_000, stderrPath: join(dir, 'clean-render.stderr.txt') });
}

async function main() {
  const transcriptOnly = command === 'analizar' && process.argv[3] === '--desde-transcript';
  if (!['analizar', 'limpiar'].includes(command) || (!source && !transcriptOnly)) {
    throw new Error('Uso: npm.cmd run analizar-youtube -- "ruta\\video.mp4", npm.cmd run analizar-youtube -- --desde-transcript, o npm.cmd run limpiar-youtube -- "ruta\\video.mp4"');
  }
  mkdirSync(work, { recursive: true });
  mkdirSync(output, { recursive: true });
  let context, transcriptData;
  if (transcriptOnly) {
    const metadata = readJson(join(work, 'metadata.json'));
    if (!metadata?.sourceSha256 || !Number.isFinite(metadata.duration)) throw new Error('Falta metadata.json válido en work/.');
    const dir = join(PROJECT_ROOT, 'cache', metadata.sourceSha256);
    const transcript = readJson(join(dir, 'transcript.json'));
    const publicTranscript = readJson(join(work, 'transcript.json'));
    if (!Array.isArray(transcript) || JSON.stringify(transcript) !== JSON.stringify(publicTranscript)) throw new Error('work/transcript.json no coincide con la caché canónica.');
    context = { root: PROJECT_ROOT, dir, metadata, sourceSha256: metadata.sourceSha256 };
    transcriptData = { transcript, segments: readJson(join(dir, 'transcript-segments.json')), transcriptHash: sha256(JSON.stringify(transcript)) };
    if (!Array.isArray(transcriptData.segments)) throw new Error('Falta transcript-segments.json.');
    console.log('[1/6] Metadatos y transcripción canónicos en caché.');
  } else {
    console.log('[1/6] Preparando video...');
    context = await getVideoContext(source);
    console.log('[2/6] Comprobando transcripción compartida...');
    transcriptData = await getSharedTranscript(context);
  }
  console.log('[3/6] Analizando idoneidad...');
  const review = await getYoutubeReview(context, transcriptData);
  console.log(`[4/6] ${review.segments.length} segmentos revisados; ${review.cuts.length} cortes.`);
  saveJson(join(work, 'metadata.json'), context.metadata);
  copyFileSync(join(context.dir, 'transcript.json'), join(work, 'transcript.json'));
  copyFileSync(join(context.dir, 'youtube-review.json'), join(work, 'youtube-review.json'));
  copyFileSync(join(context.dir, 'cuts.json'), join(work, 'cuts.json'));
  writeFileSync(join(work, 'reporte.txt'), report(basename(context.metadata.source), context.metadata.duration, review.segments, review.cuts), 'utf8');
  if (command === 'limpiar') {
    console.log('[5/6] Renderizando video limpio...');
    const destination = uniqueOutput(context.metadata.source);
    try { await renderClean(context, review.cuts, destination); }
    catch (error) { if (existsSync(destination)) unlinkSync(destination); throw error; }
    console.log(`[6/6] Listo.\nVideo limpio: ${destination}`);
  } else console.log('[5/6] Reporte guardado.\n[6/6] Listo; no se generó video.');
  console.log(`Reporte: ${join(work, 'reporte.txt')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}
