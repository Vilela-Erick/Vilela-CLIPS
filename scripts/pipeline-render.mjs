import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createClipGraphics } from './clips-graphics.mjs';
import { verticalFilter, safeHook, uniqueName } from './clips-core.mjs';
import { detectLayoutFromVideo } from './layout-detection.mjs';
import { smartVerticalFilter } from './framing/ffmpeg-filter.mjs';
import { SMART_FRAMING_VERSION } from './framing/version.mjs';
import { FRAMING_SCORE_REVISION } from './framing/framing-score.mjs';
import { sha256 } from './youtube-core.mjs';
import { readJson, runProcess, saveJson } from './pipeline-runtime.mjs';

export const LAYOUT_VERSION = 3;
export const RENDER_VERSION = 2;

export function renderKey(videoId, candidate, layout, settings) {
  return sha256(JSON.stringify({ videoId, start: candidate.start, end: candidate.end, hook: candidate.hook,
    framing: { strategy: layout.strategy ?? layout.layout, crop: layout.crop ?? null, regions: layout.regions ?? null },
    framingVersion: SMART_FRAMING_VERSION, framingScoreRevision: FRAMING_SCORE_REVISION,
    renderVersion: RENDER_VERSION, settings }));
}

export function renderArgs(context, candidate, graphics, layout, encoder, destination) {
  const { metadata } = context;
  const filter = smartVerticalFilter(layout, graphics.hookY, graphics.brandY, metadata.videoStreamIndex);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y',
    '-ss', String(candidate.start), '-i', metadata.source,
    '-loop', '1', '-framerate', '30', '-i', graphics.hookPath,
    '-loop', '1', '-framerate', '30', '-i', graphics.brandPath,
    '-t', String(candidate.duration), '-filter_complex', filter, '-map', '[v]', '-map', `0:${metadata.audioStreamIndex}`,
    '-sn', '-dn', '-map_metadata', '-1', '-pix_fmt', 'yuv420p'];
  if (encoder === 'libx264') args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
  else if (encoder === 'h264_amf') args.push('-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '20');
  else if (encoder === 'h264_nvenc') args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '20', '-b:v', '0');
  else throw new Error(`Encoder no soportado: ${encoder}`);
  args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', destination);
  return args;
}

async function ffmpegVersion(run, root) {
  return (await run('ffmpeg', ['-version'], { cwd: root, timeoutMs: 10_000 })).stdout.split(/\r?\n/)[0];
}

export async function chooseEncoder(context, requested = 'auto', { run = runProcess, logger = console.log } = {}) {
  if (requested !== 'auto') {
    if (!['libx264', 'h264_amf', 'h264_nvenc'].includes(requested)) throw new Error('--encoder debe ser auto, libx264, h264_amf o h264_nvenc.');
    return requested;
  }
  const version = await ffmpegVersion(run, context.root);
  const cachePath = join(context.root, 'cache', 'encoder-choice.json');
  const cached = readJson(cachePath);
  if (cached?.ffmpegVersion === version && cached?.encoder) {
    logger(`  Encoder en caché: ${cached.encoder}.`);
    return cached.encoder;
  }
  const listed = (await run('ffmpeg', ['-hide_banner', '-encoders'], { cwd: context.root, timeoutMs: 15_000 })).stdout;
  const available = ['libx264', 'h264_amf', 'h264_nvenc'].filter((encoder) => new RegExp(`^\\s*V[^\\n]*\\s${encoder}\\s`, 'm').test(listed));
  const times = {}, sizes = {};
  const benchDir = join(context.root, 'cache', 'benchmark');
  mkdirSync(benchDir, { recursive: true });
  for (const encoder of available) {
    const sample = join(benchDir, `${encoder}-real-5s.mp4`);
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(30, context.metadata.duration * 0.1)),
      '-i', context.metadata.source, '-t', '5', '-map', `0:${context.metadata.videoStreamIndex}`, '-an', '-sn', '-dn', '-map_metadata', '-1',
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black', '-pix_fmt', 'yuv420p'];
    if (encoder === 'libx264') args.push('-c:v', encoder, '-preset', 'veryfast', '-crf', '20');
    else if (encoder === 'h264_amf') args.push('-c:v', encoder, '-quality', 'speed', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '20');
    else args.push('-c:v', encoder, '-preset', 'p4', '-cq', '20', '-b:v', '0');
    args.push(sample);
    try {
      const result = await run('ffmpeg', args, { cwd: context.root, timeoutMs: 60_000, stderrPath: join(benchDir, `${encoder}.stderr.txt`) });
      times[encoder] = result.elapsedSeconds;
      sizes[encoder] = statSync(sample).size;
    } catch (error) { logger(`  ${encoder} no pasó la prueba: ${error.message.split('\n')[0]}`); }
  }
  if (!Number.isFinite(times.libx264)) throw new Error('libx264 no está disponible para renderizar.');
  const fastest = Object.entries(times).sort((a, b) => a[1] - b[1])[0];
  const encoder = fastest[0] !== 'libx264' && fastest[1] < times.libx264 * 0.8 && sizes[fastest[0]] <= sizes.libx264 * 1.3 ? fastest[0] : 'libx264';
  saveJson(cachePath, { ffmpegVersion: version, encoder, times, sizes, testedAt: new Date().toISOString() });
  logger(`  Encoder auto: ${encoder}; prueba real 5 s ${JSON.stringify(times)}; tamaños ${JSON.stringify(sizes)}.`);
  return encoder;
}

export async function validMp4(path, duration, { run = runProcess } = {}) {
  if (!existsSync(path) || statSync(path).size < 100_000) return false;
  try {
    const result = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', path], { timeoutMs: 30_000 });
    const data = JSON.parse(result.stdout);
    return data.streams?.[0]?.codec_name === 'h264' && data.streams[0].width === 1080 && data.streams[0].height === 1920 && Math.abs(Number(data.format?.duration) - duration) <= 0.4;
  } catch { return false; }
}

export async function framingForCandidate(context, candidate, detectSidebars = true) {
  if (!detectSidebars) return { crop: null, layout: 'full_black', reason: 'Frame completo sobre fondo negro.' };
  const result = await detectLayoutFromVideo(context.metadata.source, candidate.start, candidate.duration, context.metadata.width, context.metadata.height);
  return { ...result, layout: result.crop ? 'people_crop' : 'full_black' };
}

export async function renderSelected(context, candidates, framing, { encoder = 'auto', debug = false, logger = console.log, run = runProcess } = {}) {
  const clipsDir = join(context.root, 'clips');
  mkdirSync(clipsDir, { recursive: true });
  const statePath = join(context.dir, 'render-state.json');
  const state = readJson(statePath, { renderVersion: RENDER_VERSION, entries: {} });
  if (!state.entries || typeof state.entries !== 'object') state.entries = {};
  const occupied = new Set(readdirSync(clipsDir).map((name) => name.toLocaleLowerCase()));
  let currentEncoder = await chooseEncoder(context, encoder, { run, logger });
  const results = [];
  for (const [index, candidate] of candidates.entries()) {
    const layout = framing.clips.find((item) => item.start === candidate.start && item.end === candidate.end) || await framingForCandidate(context, candidate);
    const settings = { encoder: currentEncoder, crf: 20, audioKbps: 192 };
    let key = renderKey(context.sourceSha256, candidate, layout, settings);
    let prior = state.entries[key];
    if (prior && await validMp4(prior.path, candidate.duration, { run })) {
      logger(`[SKIP] Ya renderizado: ${prior.path}`);
      results.push(prior.path);
      continue;
    }
    const graphics = await createClipGraphics(candidate.hook, context.dir, key.slice(0, 12));
    const destination = join(clipsDir, uniqueName(safeHook(candidate.hook), occupied));
    const temp = join(context.dir, `render-${key.slice(0, 16)}.part.mp4`);
    const stderrPath = join(context.dir, `render-${key.slice(0, 16)}.stderr.txt`);
    logger(`Render ${index + 1}/${candidates.length}: "${candidate.hook}" (${candidate.duration.toFixed(1)} s)`);
    let completed;
    for (const attempt of [currentEncoder, ...(currentEncoder !== 'libx264' ? ['libx264'] : [])]) {
      if (existsSync(temp)) unlinkSync(temp);
      try {
        const result = await run('ffmpeg', renderArgs(context, candidate, graphics, layout, attempt, temp),
          { cwd: context.root, timeoutMs: Math.max(5 * 60_000, candidate.duration * 30_000), stderrPath,
            ...(debug ? { onProgress: (line) => { if (line.startsWith('out_time=')) logger(`  ${line}`); } } : {}) });
        if (!await validMp4(temp, candidate.duration, { run })) throw new Error(`FFmpeg produjo un MP4 inválido. Registro: ${stderrPath}`);
        completed = { encoder: attempt, elapsedSeconds: result.elapsedSeconds };
        break;
      } catch (error) {
        if (existsSync(temp)) unlinkSync(temp);
        if (attempt === 'libx264') throw error;
        logger(`  ${attempt} falló; reintentando este clip con libx264. Registro: ${stderrPath}`);
        currentEncoder = 'libx264';
        key = renderKey(context.sourceSha256, candidate, layout, { encoder: currentEncoder, crf: 20, audioKbps: 192 });
      }
    }
    renameSync(temp, destination);
    state.entries[key] = { path: resolve(destination), duration: candidate.duration, encoder: completed.encoder,
      size: statSync(destination).size, completedAt: new Date().toISOString() };
    saveJson(statePath, state);
    logger(`  Completado en ${completed.elapsedSeconds} s: ${destination}`);
    results.push(destination);
  }
  return results;
}
