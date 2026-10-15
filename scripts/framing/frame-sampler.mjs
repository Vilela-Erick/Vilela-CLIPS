import { spawn } from 'node:child_process';

export const ANALYSIS_SIZE = 640;
export const SAMPLE_POINTS = [0.1, 0.3, 0.5, 0.7, 0.9];

export function sampleTimes(start, duration) {
  if (!(duration > 0)) throw new Error('Duración de clip inválida para framing.');
  return SAMPLE_POINTS.map((point) => +(start + Math.min(duration - 0.001, Math.max(0.001, duration * point))).toFixed(3));
}

export function analysisTransform(width, height) {
  const scale = Math.min(ANALYSIS_SIZE / width, ANALYSIS_SIZE / height);
  const scaledWidth = Math.max(2, 2 * Math.floor(width * scale / 2));
  const scaledHeight = Math.max(2, 2 * Math.floor(height * scale / 2));
  return { scaleX: scaledWidth / width, scaleY: scaledHeight / height,
    x: Math.floor((ANALYSIS_SIZE - scaledWidth) / 2), y: Math.floor((ANALYSIS_SIZE - scaledHeight) / 2),
    width: scaledWidth, height: scaledHeight };
}

function extractFrame(videoPath, time) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', videoPath,
      '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${ANALYSIS_SIZE}:${ANALYSIS_SIZE}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${ANALYSIS_SIZE}:${ANALYSIS_SIZE}:(ow-iw)/2:(oh-ih)/2:black`,
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const errors = [];
    let bytes = 0;
    child.stdout.on('data', (chunk) => { chunks.push(chunk); bytes += chunk.length; });
    child.stderr.on('data', (chunk) => { if (errors.length < 8) errors.push(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code || bytes !== ANALYSIS_SIZE * ANALYSIS_SIZE * 3) reject(new Error(`FFmpeg no pudo extraer muestra en ${time}s: ${Buffer.concat(errors).toString('utf8').slice(0, 300)}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

export async function sampleFrames(videoPath, start, duration, width, height, { extract = extractFrame } = {}) {
  const began = performance.now();
  const times = sampleTimes(start, duration);
  const frames = [];
  for (const time of times) frames.push({ time, rgb: await extract(videoPath, time) });
  return { frames, transform: analysisTransform(width, height), extractionMs: Math.round(performance.now() - began) };
}
