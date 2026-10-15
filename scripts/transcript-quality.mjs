import { parseWords } from './youtube-core.mjs';

// Whisper can repeat one phrase for many minutes after losing the audio context.
// Flag a sustained exact three-word cycle; ordinary repeated words are not enough.
export function repeatedPhraseIssue(transcript) {
  const words = parseWords(transcript);
  const text = words.map((word) => word.text.toLocaleLowerCase('es'));
  let best = null;
  for (let start = 0; start + 6 < text.length; start++) {
    if (start >= 3 && text[start] === text[start - 3] && text[start + 1] === text[start - 2] && text[start + 2] === text[start - 1]) continue;
    let end = start + 3;
    while (end < text.length && text[end] === text[end - 3]) end++;
    const repeats = Math.floor((end - start) / 3);
    const span = words[end - 1].end - words[start].start;
    if (repeats >= 20 && span >= 120 && (!best || span > best.span)) {
      best = { start: words[start].start, end: words[end - 1].end, span, repeats,
        phrase: words.slice(start, start + 3).map((word) => word.text).join(' ') };
    }
  }
  return best;
}
