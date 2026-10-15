import test from 'node:test';
import assert from 'node:assert/strict';
import { safeHook, uniqueName, intersectsCut, validateCandidates, verticalFilter } from './clips-core.mjs';
import { selectCandidates } from './pipeline-analysis.mjs';

const base = { start: 20, end: 62, hook: 'BELLA NO SE QUEDÓ CALLADA 😳', viralScore: 9, contextScore: 8, hookScore: 9, standaloneScore: 8, reason: 'Respuesta completa', selected: true };

test('nombres conservan Unicode, limpian caracteres de Windows y no se repiten', () => {
  assert.equal(safeHook(' BELLA: NO / SE QUEDÓ CALLADA 😳. '), 'BELLA NO SE QUEDÓ CALLADA 😳');
  const occupied = new Set(['bella no se quedó callada 😳.mp4']);
  assert.equal(uniqueName(base.hook, occupied), 'BELLA NO SE QUEDÓ CALLADA 😳 (2).mp4');
  assert.equal(uniqueName(base.hook, occupied), 'BELLA NO SE QUEDÓ CALLADA 😳 (3).mp4');
  assert.throws(() => safeHook('CON'));
});

test('los cortes con margen excluyen candidatos y el borde exterior es válido', () => {
  const cuts = [{ start: 62.4, end: 75 }];
  assert.equal(intersectsCut(20, 62, cuts), true);
  assert.equal(intersectsCut(20, 61.8, cuts), false);
  assert.equal(validateCandidates({ candidates: [base] }, 100, cuts)[0].selected, false);
});

test('duración 30–90 segundos y selección de calidad; deduplicación', () => {
  assert.deepEqual(validateCandidates({ candidates: [{ ...base, end: 48 }] }, 100, []), []);
  assert.deepEqual(validateCandidates({ candidates: [{ ...base, end: 112 }] }, 150, []), []);
  assert.deepEqual(validateCandidates({ candidates: [{ ...base, end: 48 }, base, { ...base, end: 112 }] }, 150, []).map(({ start, end }) => ({ start, end })), [{ start: 20, end: 62 }]);
  const pair = validateCandidates({ candidates: [base, { ...base, start: 22, end: 63, viralScore: 8 }] }, 100, []);
  assert.equal(selectCandidates(pair, [], [], { cantidad: 2 }).filter((candidate) => candidate.selected).length, 1);
});

test('filtro vertical conserva el video y coloca las graficas en zonas seguras', () => {
  const filter = verticalFilter(0.2, 188, 1480);
  assert.match(filter, /crop=iw-2\*trunc\(iw\*0\.2\/2\)\*2:ih/);
  assert.match(filter, /scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920/);
  assert.doesNotMatch(filter, /boxblur|gblur|split=2/);
  assert.match(filter, /\[base\]\[1:v\]overlay=\(W-w\)\/2:188:enable=lt\(t\\,7\)/);
  assert.match(filter, /\[withHook\]\[2:v\]overlay=\(W-w\)\/2:1480\[v\]/);
  assert.doesNotMatch(filter, /drawtext=|drawbox=/);
});
