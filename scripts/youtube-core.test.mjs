import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCuts, keptRanges, report, validateReview } from './youtube-core.mjs';

test('cortes high con margen, fusión y límites; medium queda sin corte', () => {
  const review = validateReview({ segments: [
    { start: 0.1, end: 1, severity: 'high', reason: 'sexual', text: 'frase uno' },
    { start: 1.7, end: 2, severity: 'high', reason: 'sexual', text: 'frase dos' },
    { start: 8, end: 9.9, severity: 'high', reason: 'sexual', text: 'frase tres' },
    { start: 4, end: 5, severity: 'medium', reason: 'duda', text: 'broma' },
  ] }, 10);
  const cuts = makeCuts(review, 10);
  assert.deepEqual(cuts.map((c) => [c.start, c.end]), [[0, 2.3], [7.7, 10]]);
  assert.deepEqual(keptRanges(cuts, 10), [[2.3, 7.7]]);
  assert.match(report('video.mp4', 10, review, cuts), /SEGMENTOS DETECTADOS:\n4/);
});

test('la revisión rechaza tiempos fuera del video', () => {
  assert.throws(() => validateReview({ segments: [{ start: -1, end: 2, severity: 'high', reason: 'x', text: 'x' }] }, 10));
});
