import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDecorativeSidebars } from './layout-detection.mjs';
import { verticalFilter } from './clips-core.mjs';

const width = 120;
const height = 60;

function sampleFrames({ panels = true, edgePerson = false, uncertain = false } = {}) {
  return Array.from({ length: 5 }, (_, frameIndex) => {
    const frame = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 3;
        const left = x < 24;
        const right = x >= 96;
        const personOne = x >= 28 && x <= 57 && y > 8 && y < 54;
        const personTwo = x >= 63 && x <= 92 && y > 7 && y < 55;
        const side = panels && (left || right);
        const moving = personOne || personTwo || edgePerson && left && x >= 4 && x <= 19;
        const sideValue = (x % 13 < 2 || y % 17 < 2) ? 75 : 8;
        const value = side
          ? sideValue + (uncertain || moving ? frameIndex * 13 : 0)
          : moving || !panels ? (x * 4 + y * 2 + frameIndex * 35) % 220 : 175;
        frame[offset] = value;
        frame[offset + 1] = value;
        frame[offset + 2] = value;
      }
    }
    return frame;
  });
}

test('panel decorativo izquierdo y derecho con dos personas centrales', () => {
  const result = detectDecorativeSidebars(sampleFrames(), width, height);
  assert.ok(result.cropFraction, JSON.stringify(result));
  assert.ok(result.cropFraction.left > 0.17 && result.cropFraction.left < 0.23);
  assert.ok(result.cropFraction.right > 0.17 && result.cropFraction.right < 0.23);
  const crop = { x: 384, y: 0, width: 1152, height: 1080 };
  assert.match(verticalFilter(crop), /^\[0:0\]crop=1152:1080:384:0,scale=/);
  assert.match(verticalFilter(crop), /pad=1080:1920:.*:black/);
});

test('video normal sin paneles mantiene el frame completo', () => {
  const result = detectDecorativeSidebars(sampleFrames({ panels: false }), width, height);
  assert.equal(result.cropFraction, null);
  assert.match(verticalFilter(null), /^\[0:0\]scale=/);
});

test('persona cerca del borde impide recortar ese lado', () => {
  const result = detectDecorativeSidebars(sampleFrames({ edgePerson: true }), width, height);
  assert.equal(result.cropFraction?.left ?? 0, 0);
});

test('si los laterales cambian, no hay recorte agresivo', () => {
  const result = detectDecorativeSidebars(sampleFrames({ uncertain: true }), width, height);
  assert.equal(result.cropFraction, null);
  assert.equal(detectDecorativeSidebars(sampleFrames().slice(0, 3), width, height).cropFraction, null);
});

test('la detección usa píxeles y no recibe nombre ni hash del archivo', () => {
  const first = detectDecorativeSidebars(sampleFrames(), width, height);
  const second = detectDecorativeSidebars(sampleFrames(), width, height);
  assert.deepEqual(first, second);
  assert.equal(detectDecorativeSidebars.length, 1);
});
