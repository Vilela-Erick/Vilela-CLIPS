import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const MODEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../models/person_detection_mediapipe_2023mar.onnx');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function anchors() {
  const points = [];
  for (const [grid, count] of [[28, 2], [14, 2], [7, 6]]) {
    for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) {
      for (let k = 0; k < count; k++) points.push([(x + 0.5) / grid, (y + 0.5) / grid]);
    }
  }
  return points;
}

const ANCHORS = anchors();
const overlap = (a, b) => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const area = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y);
  return area / Math.max(1, a.width * a.height + b.width * b.height - area);
};

export async function createPersonDetector() {
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(MODEL, { executionProviders: ['cpu'] });
  return {
    model: 'OpenCV MediaPipe Pose 2023mar',
    async detect(frame, transform, source) {
      const rgb = await sharp(frame.rgb, { raw: { width: 640, height: 640, channels: 3 } })
        .resize(224, 224).raw().toBuffer();
      const pixels = 224 * 224, tensor = new Float32Array(pixels * 3);
      for (let i = 0; i < pixels; i++) for (let channel = 0; channel < 3; channel++) {
        tensor[channel * pixels + i] = rgb[i * 3 + channel] / 127.5 - 1;
      }
      const result = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, 224, 224]) });
      const scores = result['Identity_1:0'].data, boxes = result['Identity:0'].data;
      const found = [];
      for (let i = 0; i < ANCHORS.length; i++) {
        const confidence = 1 / (1 + Math.exp(-clamp(scores[i], -100, 100)));
        if (confidence < 0.5) continue;
        const base = i * 12, anchor = ANCHORS[i];
        const cx = (boxes[base] / 224 + anchor[0]) * 640;
        const cy = (boxes[base + 1] / 224 + anchor[1]) * 640;
        const width = boxes[base + 2] / 224 * 640;
        const height = boxes[base + 3] / 224 * 640;
        const x1 = clamp((cx - width / 2 - transform.x) / transform.scaleX, 0, source.width);
        const y1 = clamp((cy - height / 2 - transform.y) / transform.scaleY, 0, source.height);
        const x2 = clamp((cx + width / 2 - transform.x) / transform.scaleX, 0, source.width);
        const y2 = clamp((cy + height / 2 - transform.y) / transform.scaleY, 0, source.height);
        if (x2 - x1 < 20 || y2 - y1 < 20) continue;
        found.push({ x: x1, y: y1, width: x2 - x1, height: y2 - y1, confidence });
      }
      found.sort((a, b) => b.confidence - a.confidence);
      const kept = [];
      for (const item of found) if (kept.every((other) => overlap(item, other) < 0.3)) kept.push(item);
      return kept.slice(0, 8);
    },
  };
}
