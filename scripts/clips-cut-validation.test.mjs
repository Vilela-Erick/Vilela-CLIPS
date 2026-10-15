import test from 'node:test';
import assert from 'node:assert/strict';
import { revalidateCandidatesAgainstCuts, CUT_MARGIN } from './clips-cut-validation.mjs';
import { intersectsCut } from './clips-core.mjs';

const base = {
  start: 48, end: 80, duration: 32, selected: true,
  reason: 'La discusión remata con «¿Estás borracho o estás borrado?».',
};
const words = [
  { start: 48, end: 48.5, text: '¿Agua' },
  { start: 76.38, end: 76.89, text: 'borracho' },
  { start: 76.89, end: 76.9, text: 'o' },
  { start: 77.01, end: 77.29, text: 'estás' },
  { start: 77.29, end: 78, text: 'borrado?' },
  { start: 78, end: 80, text: 'No.' },
];

test('48–80 se recorta al remate natural de 78 antes del corte 78.7–85.3', () => {
  const cuts = [{ start: 78.7, end: 85.3 }];
  const raw = { ...base, hook: 'AGUA DE NOVENTA Y NUEVE', viralScore: 8, contextScore: 8, hookScore: 8, standaloneScore: 8 };
  const [candidate] = revalidateCandidatesAgainstCuts([raw], cuts, words);
  assert.equal(candidate.selected, true);
  assert.equal(candidate.start, 48);
  assert.equal(candidate.end, 78);
  assert.equal(candidate.duration, 30);
  assert.equal(intersectsCut(candidate.start, candidate.end, cuts, CUT_MARGIN), false);
});

test('descarta un recorte corto o sin final natural, y no parte un corte central', () => {
  const [tooShort] = revalidateCandidatesAgainstCuts([{ ...base, start: 49, duration: 31 }], [{ start: 78.7, end: 85.3 }], words);
  assert.equal(tooShort.selected, false);
  const [middle] = revalidateCandidatesAgainstCuts([{ ...base, end: 110, duration: 62 }], [{ start: 70, end: 90 }], words);
  assert.equal(middle.selected, false);
});
