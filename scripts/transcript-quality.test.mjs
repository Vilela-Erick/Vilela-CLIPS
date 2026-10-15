import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatedPhraseIssue } from './transcript-quality.mjs';

test('detecta una alucinación repetida durante minutos', () => {
  const transcript = Array.from({ length: 90 }, (_, index) => ({
    start: index * 5, end: index * 5 + 1, text: ['¿cuál', 'es', 'Juanito?'][index % 3],
  }));
  assert.equal(repeatedPhraseIssue(transcript)?.repeats, 30);
});

test('una repetición breve en una conversación no invalida la transcripción', () => {
  const transcript = Array.from({ length: 12 }, (_, index) => ({
    start: index, end: index + 0.5, text: ['dale', 'dale', 'dale'][index % 3],
  }));
  assert.equal(repeatedPhraseIssue(transcript), null);
});
