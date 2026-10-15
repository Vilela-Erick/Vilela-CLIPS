import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWords, sha256 } from './youtube-core.mjs';
import { repeatedPhraseIssue } from './transcript-quality.mjs';
import { hashFile, readJson, runProcess, saveJson } from './pipeline-runtime.mjs';

export const CACHE_VERSION = 1;
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_ROOT = join(PROJECT_ROOT, 'cache');
const hfBin = join(PROJECT_ROOT, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');

export function statSignature(source, stat = statSync(source)) {
  return { path: resolve(source), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
export function sameSignature(a, b) {
  return !!a && a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export async function getVideoContext(source, { root = PROJECT_ROOT, run = runProcess, hash = hashFile, logger = console.log } = {}) {
  source = resolve(source);
  if (!existsSync(source)) throw new Error(`No existe el video: ${source}`);
  const cacheRoot = join(root, 'cache');
  mkdirSync(cacheRoot, { recursive: true });
  const indexPath = join(cacheRoot, 'video-index.json');
  const signature = statSignature(source);
  const index = readJson(indexPath, {});
  const known = index[source.toLocaleLowerCase()];
  const sourceSha256 = sameSignature(known, signature) && /^[0-9a-f]{64}$/.test(known.sourceSha256)
    ? known.sourceSha256 : await hash(source);
  if (known?.sourceSha256 === sourceSha256) logger('  Huella del video en caché.');
  else logger('  Huella SHA-256 calculada.');
  if (!sameSignature(known, signature) || known.sourceSha256 !== sourceSha256) {
    index[source.toLocaleLowerCase()] = { ...signature, sourceSha256, cacheVersion: CACHE_VERSION };
    saveJson(indexPath, index);
  }
  const dir = join(cacheRoot, sourceSha256);
  mkdirSync(dir, { recursive: true });
  const metaPath = join(dir, 'metadata.json');
  let metadata = readJson(metaPath);
  if (!metadata || metadata.sourceSha256 !== sourceSha256 || !Number.isFinite(metadata.duration) || !Number.isSafeInteger(metadata.videoStreamIndex) || !Number.isSafeInteger(metadata.audioStreamIndex)) {
    const result = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', source], { cwd: root, timeoutMs: 60_000 });
    const data = JSON.parse(result.stdout);
    const video = data.streams?.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const audio = data.streams?.find((stream) => stream.codec_type === 'audio');
    const duration = Number(data.format?.duration);
    if (!video || !audio || !Number.isFinite(duration) || duration <= 0) throw new Error('El archivo requiere video, audio y duración válida.');
    metadata = { source, sourceSha256, duration, width: video.width, height: video.height,
      fps: video.avg_frame_rate || video.r_frame_rate, videoCodec: video.codec_name, audioCodec: audio.codec_name };
    metadata.videoStreamIndex = video.index;
    metadata.audioStreamIndex = audio.index;
    saveJson(metaPath, metadata);
  }
  if (metadata.source !== source) {
    metadata.source = source;
    saveJson(metaPath, metadata);
  }
  return { root, dir, metadata, sourceSha256, signature };
}

export function transcriptIsUsable(transcript) {
  try { return parseWords(transcript).length > 0 && !repeatedPhraseIssue(transcript); } catch { return false; }
}

export function compactTranscript(transcript, { maxSeconds = 12, maxCharacters = 170 } = {}) {
  const words = parseWords(transcript).sort((a, b) => a.start - b.start);
  const result = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    result.push([+group[0].start.toFixed(3), +group.at(-1).end.toFixed(3), group.map((word) => word.text).join(' ').replace(/\s+([,.;!?])/gu, '$1')]);
    group = [];
  };
  for (const word of words) {
    if (group.length && (word.start - group.at(-1).end > 1.2 || word.end - group[0].start > maxSeconds ||
      group.reduce((n, item) => n + item.text.length + 1, 0) + word.text.length > maxCharacters)) flush();
    group.push(word);
    if (/[.!?…]["'”’)]*$/u.test(word.text) && group.length >= 5) flush();
  }
  flush();
  return result;
}

function legacyTranscript(context) {
  const { root, dir, sourceSha256, metadata } = context;
  const paths = [
    join(root, 'work-clips', `${basename(metadata.source).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40)}-${sourceSha256.slice(0, 12)}`, 'transcript.json'),
    join(root, 'work', 'cache', sourceSha256, 'transcript.json'),
  ];
  const publicMeta = readJson(join(root, 'work', 'metadata.json'));
  if (publicMeta?.sourceSha256 === sourceSha256) paths.push(join(root, 'work', 'transcript.json'));
  return paths.find((path) => transcriptIsUsable(readJson(path)));
}

async function transcribeAudio(audio, dir, context, run) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'transcript.json');
  if (Array.isArray(readJson(path))) return readJson(path);
  const result = await run(process.execPath, [hfBin, 'transcribe', audio, '--dir', dir, '--engine', 'whisper', '--model', 'small', '--language', 'es', '--json'],
    { cwd: context.root, timeoutMs: 60 * 60_000, stderrPath: join(dir, 'whisper.stderr.txt') });
  const status = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  if (!status.ok || !Array.isArray(readJson(path))) throw new Error(`Whisper no completó ${audio}.`);
  return readJson(path);
}

async function chunkTranscript(context, audio, run, size, start, end) {
  const { dir, metadata, root } = context;
  const extractionStart = Math.max(0, start - (start ? 10 : 0));
  const length = Math.min(metadata.duration - extractionStart, end - extractionStart);
  const partDir = join(dir, 'transcript-parts', `${size}-${String(Math.round(start)).padStart(5, '0')}`);
  mkdirSync(partDir, { recursive: true });
  const wav = join(partDir, 'audio.wav');
  const transcriptPath = join(partDir, 'transcript.json');
  if (!Array.isArray(readJson(transcriptPath))) {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(extractionStart), '-t', String(length), '-i', audio,
      '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { cwd: root, timeoutMs: 120_000, stderrPath: join(partDir, 'extract.stderr.txt') });
  }
  const words = await transcribeAudio(wav, partDir, context, run);
  return { issue: repeatedPhraseIssue(words), words: parseWords(words).map((word) => ({
    text: word.text, start: +(word.start + extractionStart).toFixed(3), end: +(word.end + extractionStart).toFixed(3),
  })).filter((word) => word.start >= start - 0.02 && word.start < end && word.end > word.start) };
}

async function repairTranscript(context, audio, run, logger) {
  const { metadata, dir } = context;
  const combined = [];
  for (let start = 0; start < metadata.duration; start += 300) {
    const end = Math.min(metadata.duration, start + 300);
    logger(`  Whisper tramo ${Math.floor(start / 300) + 1}/${Math.ceil(metadata.duration / 300)} (${Math.round(start)}–${Math.round(end)} s).`);
    const part = await chunkTranscript(context, audio, run, 300, start, end);
    if (!part.issue) combined.push(...part.words);
    else {
      logger(`  Repetición en tramo largo; dividiendo solo ${Math.round(start)}–${Math.round(end)} s.`);
      for (let smallStart = start; smallStart < end; smallStart += 60) {
        const smaller = await chunkTranscript(context, audio, run, 60, smallStart, Math.min(end, smallStart + 60));
        if (smaller.issue) throw new Error(`Whisper repite una frase incluso en el tramo ${smallStart}–${smallStart + 60} s.`);
        combined.push(...smaller.words);
      }
    }
  }
  combined.sort((a, b) => a.start - b.start);
  const result = combined.map((word, index) => ({ ...word, id: `w${index}` }));
  if (!transcriptIsUsable(result)) throw new Error('La transcripción reparada no pasó la validación.');
  saveJson(join(dir, 'transcript.json'), result);
  return result;
}

export async function getSharedTranscript(context, { run = runProcess, logger = console.log } = {}) {
  const { root, dir, metadata } = context;
  const path = join(dir, 'transcript.json');
  let transcript = readJson(path);
  if (!transcriptIsUsable(transcript)) {
    const legacy = legacyTranscript(context);
    if (legacy) {
      copyFileSync(legacy, path);
      transcript = readJson(path);
      logger('  Transcripción válida importada a la caché canónica.');
    }
  }
  if (!transcriptIsUsable(transcript)) {
    if (!existsSync(hfBin)) throw new Error('HyperFrames no está instalado. Ejecuta npm install.');
    const audio = join(dir, 'audio.wav');
    if (!existsSync(audio)) {
      logger('  Extrayendo audio PCM mono 16 kHz una vez.');
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', metadata.source, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio],
        { cwd: root, timeoutMs: 30 * 60_000, stderrPath: join(dir, 'audio-extract.stderr.txt') });
    }
    const fullDir = join(dir, 'transcript-full');
    transcript = await transcribeAudio(audio, fullDir, context, run);
    if (!transcriptIsUsable(transcript)) {
      logger('  Transcripción completa con repetición larga; probando tramos de 5 minutos.');
      transcript = await repairTranscript(context, audio, run, logger);
    } else saveJson(path, transcript);
  } else logger('  Transcripción compartida en caché.');
  const segmentsPath = join(dir, 'transcript-segments.json');
  const markerPath = join(dir, 'transcript-segments-key.json');
  const key = sha256(JSON.stringify(transcript));
  if (readJson(markerPath)?.transcriptHash !== key || !Array.isArray(readJson(segmentsPath))) {
    saveJson(segmentsPath, compactTranscript(transcript));
    saveJson(markerPath, { transcriptHash: key, cacheVersion: CACHE_VERSION });
  }
  return { transcript, segments: readJson(segmentsPath), transcriptHash: key };
}
