import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ANALYSIS_SIZE } from './frame-sampler.mjs';

export const MODEL_PATH = resolve(fileURLToPath(new URL('../../models/face_detection_yunet_2023mar.onnx', import.meta.url)));
const STRIDES = [8, 16, 32];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function rgbToBgrTensor(rgb) {
  const pixels = ANALYSIS_SIZE * ANALYSIS_SIZE;
  if (rgb.length !== pixels * 3) throw new Error('Muestra RGB inválida para YuNet.');
  const data = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    data[i] = rgb[i * 3 + 2];
    data[pixels + i] = rgb[i * 3 + 1];
    data[pixels * 2 + i] = rgb[i * 3];
  }
  return data;
}

function iou(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x);
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y);
  const intersection = w * h;
  return intersection / Math.max(1, a.width * a.height + b.width * b.height - intersection);
}

// Decodificación de YuNet basada en FaceDetectorYN de OpenCV (MIT).
export function decodeFaces(output, transform, source, threshold = 0.65) {
  const faces = [];
  for (const stride of STRIDES) {
    const cls = output[`cls_${stride}`]?.data;
    const obj = output[`obj_${stride}`]?.data;
    const bbox = output[`bbox_${stride}`]?.data;
    if (!cls || !obj || !bbox) throw new Error(`Salidas YuNet incompletas para stride ${stride}.`);
    const cols = ANALYSIS_SIZE / stride;
    for (let i = 0; i < cls.length; i++) {
      const confidence = Math.sqrt(clamp(cls[i], 0, 1) * clamp(obj[i], 0, 1));
      if (confidence < threshold) continue;
      const centerX = ((i % cols) + bbox[i * 4]) * stride;
      const centerY = (Math.floor(i / cols) + bbox[i * 4 + 1]) * stride;
      const faceWidth = Math.exp(bbox[i * 4 + 2]) * stride;
      const faceHeight = Math.exp(bbox[i * 4 + 3]) * stride;
      const x1 = clamp((centerX - faceWidth / 2 - transform.x) / transform.scaleX, 0, source.width);
      const y1 = clamp((centerY - faceHeight / 2 - transform.y) / transform.scaleY, 0, source.height);
      const x2 = clamp((centerX + faceWidth / 2 - transform.x) / transform.scaleX, 0, source.width);
      const y2 = clamp((centerY + faceHeight / 2 - transform.y) / transform.scaleY, 0, source.height);
      if (x2 - x1 >= 8 && y2 - y1 >= 8) faces.push({ x: x1, y: y1, width: x2 - x1, height: y2 - y1, confidence });
    }
  }
  const kept = [];
  for (const face of faces.sort((a, b) => b.confidence - a.confidence)) {
    if (kept.every((other) => iou(face, other) < 0.3)) kept.push(face);
    if (kept.length === 12) break;
  }
  return kept.map((face) => Object.fromEntries(Object.entries(face).map(([key, value]) => [key, +value.toFixed(3)])));
}

export async function createFaceDetector({ modelPath = MODEL_PATH, runtime } = {}) {
  const ort = runtime || await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], intraOpNumThreads: 2 });
  return {
    model: 'YuNet 2023mar',
    async detectSubjects(frame, transform, source) {
      const tensor = new ort.Tensor('float32', rgbToBgrTensor(frame.rgb), [1, 3, ANALYSIS_SIZE, ANALYSIS_SIZE]);
      return decodeFaces(await session.run({ input: tensor }), transform, source);
    },
  };
}
