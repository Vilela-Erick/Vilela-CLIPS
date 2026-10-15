import { spawn } from 'node:child_process';

const WIDTH = 320;
const HEIGHT = 180;
const POINTS = [0.1, 0.3, 0.5, 0.7, 0.9];

const mean = (values, start, end) => {
  let total = 0;
  for (let x = start; x < end; x++) total += values[x];
  return total / Math.max(1, end - start);
};

function profile(frames, width, height) {
  const motion = new Float64Array(width);
  const edge = new Float64Array(width);
  const darkness = new Float64Array(width);
  for (let i = 0; i < frames.length; i++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 3;
        const red = frames[i][offset], green = frames[i][offset + 1], blue = frames[i][offset + 2];
        if (i) motion[x] += (Math.abs(red - frames[i - 1][offset]) + Math.abs(green - frames[i - 1][offset + 1]) + Math.abs(blue - frames[i - 1][offset + 2])) / 3;
        if (x) edge[x] += (Math.abs(red - frames[i][offset - 3]) + Math.abs(green - frames[i][offset - 2]) + Math.abs(blue - frames[i][offset - 1])) / 3;
        if (0.2126 * red + 0.7152 * green + 0.0722 * blue < 52) darkness[x]++;
      }
    }
  }
  for (let x = 0; x < width; x++) {
    motion[x] /= height * (frames.length - 1);
    edge[x] /= height * frames.length;
    darkness[x] /= height * frames.length;
  }
  return { motion, edge, darkness };
}

function findSidebar(profileData, width, side, centerMotion) {
  const { motion, edge, darkness } = profileData;
  let best = null;
  for (let boundary = Math.ceil(width * 0.08); boundary <= Math.floor(width * 0.3); boundary++) {
    const x = side === 'left' ? boundary : width - boundary;
    const outerStart = side === 'left' ? 0 : x + 4;
    const outerEnd = side === 'left' ? x - 4 : width;
    const innerStart = side === 'left' ? x + 4 : x - Math.ceil(width * 0.09);
    const innerEnd = side === 'left' ? x + Math.ceil(width * 0.09) : x - 4;
    const outerMotion = mean(motion, outerStart, outerEnd);
    const innerMotion = mean(motion, innerStart, innerEnd);
    const dark = mean(darkness, outerStart, outerEnd);
    let peakX = x;
    for (let nearby = x - 2; nearby <= x + 2; nearby++) {
      if (edge[nearby] > edge[peakX]) peakX = nearby;
    }
    const boundaryEdge = edge[peakX];
    // Un panel debe ser oscuro, casi inmóvil y separado de contenido activo.
    if (outerMotion > 4 || outerMotion > centerMotion * 0.33 ||
        innerMotion < Math.max(5, outerMotion * 2.4) || dark < 0.48 || boundaryEdge < 10) continue;
    const score = boundaryEdge + Math.min(innerMotion - outerMotion, 20) * 0.4;
    if (!best || score > best.score) best = { x: peakX, score };
  }
  return best;
}

export function detectDecorativeSidebars(frames, width = WIDTH, height = HEIGHT) {
  const fallback = { cropFraction: null, reason: 'No hay suficiente evidencia para retirar paneles laterales.' };
  if (frames.length < 5 || frames.some((frame) => frame.length !== width * height * 3)) return fallback;
  const data = profile(frames, width, height);
  const centerMotion = mean(data.motion, Math.ceil(width * 0.35), Math.floor(width * 0.65));
  if (centerMotion < 7) return fallback;
  const left = findSidebar(data, width, 'left', centerMotion);
  const right = findSidebar(data, width, 'right', centerMotion);
  if (!left && !right) return fallback;
  const x1 = left ? left.x : 0;
  const x2 = right ? right.x : width;
  if ((x2 - x1) / width < 0.45) return fallback;
  return {
    cropFraction: { left: +(x1 / width).toFixed(5), right: +((width - x2) / width).toFixed(5) },
    reason: `Paneles oscuros y estáticos detectados en ${left && right ? 'ambos lados' : left ? 'la izquierda' : 'la derecha'}; se preserva la zona activa central.`,
  };
}

function sampleFrame(videoPath, time) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', videoPath,
      '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${WIDTH}:${HEIGHT}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const parts = [];
    let bytes = 0;
    child.stdout.on('data', (chunk) => { if (bytes < WIDTH * HEIGHT * 4) parts.push(chunk); bytes += chunk.length; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 30_000);
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', (code) => { clearTimeout(timer); resolve(code === 0 && bytes === WIDTH * HEIGHT * 3 ? Buffer.concat(parts) : null); });
  });
}

export async function detectLayoutFromVideo(videoPath, start, duration, width, height) {
  const fallback = { crop: null, reason: 'Frame completo: no se detectó un recorte lateral seguro.' };
  if (!width || !height || width / height < 1.3) return fallback;
  const frames = [];
  for (const point of POINTS) {
    const frame = await sampleFrame(videoPath, Math.max(0, start + duration * point));
    if (!frame) return fallback;
    frames.push(frame);
  }
  const result = detectDecorativeSidebars(frames);
  if (!result.cropFraction) return { ...fallback, reason: result.reason };
  const x = 2 * Math.round(width * result.cropFraction.left / 2);
  const right = 2 * Math.round(width * result.cropFraction.right / 2);
  return { layout: 'people_crop', crop: { x, y: 0, width: width - x - right, height }, reason: result.reason };
}
