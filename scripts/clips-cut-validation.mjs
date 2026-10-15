import { intersectsCut } from './clips-core.mjs';

export const CUT_MARGIN = 0.30;

const naturalEnd = (word) => /[.!?…]["'”’)]*$/u.test(word.text);
const normalized = (text) => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const significant = (text) => normalized(text).split(/\s+/u).filter((part) => part.length >= 4);
const reasonSupports = (reason, words, edge = 'end') => {
  const tokens = significant(words.map((word) => word.text).join(' '));
  const evidence = new Set(significant(reason));
  const pair = edge === 'start' ? tokens.slice(0, 2) : tokens.slice(-2);
  return pair.length === 2 && pair.every((token) => evidence.has(token));
};

function endingBefore(candidate, limit, words) {
  const inside = words.filter((word) => word.start >= candidate.start - 0.25 && word.end <= limit + 0.001);
  for (let index = inside.length - 1; index >= 0; index--) {
    const word = inside[index];
    if (word.end - candidate.start < 30) break;
    if (naturalEnd(word) && reasonSupports(candidate.reason, inside.slice(Math.max(0, index - 5), index + 1))) {
      return { ...candidate, end: +word.end.toFixed(3), duration: +(word.end - candidate.start).toFixed(3) };
    }
  }
  return null;
}

function startingAfter(candidate, limit, words) {
  const inside = words.filter((word) => word.start >= limit - 0.001 && word.end <= candidate.end + 0.25);
  for (let index = 0; index < inside.length; index++) {
    const word = inside[index];
    if (candidate.end - word.start < 30) break;
    const previous = words.findLast((item) => item.end <= word.start + 0.001);
    if (previous && naturalEnd(previous) && reasonSupports(candidate.reason, inside.slice(index, index + 6), 'start')) {
      return { ...candidate, start: +word.start.toFixed(3), duration: +(candidate.end - word.start).toFixed(3) };
    }
  }
  return null;
}

export function revalidateCandidatesAgainstCuts(candidates, cuts, words, margin = CUT_MARGIN) {
  const sortedWords = [...words].sort((a, b) => a.start - b.start);
  const sortedCuts = [...cuts].sort((a, b) => a.start - b.start);
  return candidates.map((original) => {
    let candidate = { ...original };
    if (!candidate.selected) return candidate;
    for (const cut of sortedCuts) {
      if (!intersectsCut(candidate.start, candidate.end, [cut], margin)) continue;
      const left = endingBefore(candidate, cut.start - margin, sortedWords);
      const right = startingAfter(candidate, cut.end + margin, sortedWords);
      const options = [left, right].filter(Boolean)
        .filter((option) => !intersectsCut(option.start, option.end, [cut], margin));
      if (!options.length) {
        candidate.selected = false;
        candidate.exclusionReason = `Interseca un corte de idoneidad ${cut.start}–${cut.end} s; no hay un recorte completo de al menos 30 s.`;
        break;
      }
      candidate = options.sort((a, b) => b.duration - a.duration)[0];
      candidate.reason = `${original.reason} [Recortado para excluir ${cut.start}–${cut.end} s.]`;
    }
    if (candidate.selected && intersectsCut(candidate.start, candidate.end, sortedCuts, margin)) {
      candidate.selected = false;
      candidate.exclusionReason = 'Interseca un corte de idoneidad tras la validación final.';
    }
    return candidate;
  });
}
