import { createHash } from 'node:crypto';

export const POLICY_VERSION = 1;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function parseWords(transcript) {
  if (!Array.isArray(transcript)) throw new Error('La transcripción no es una lista de palabras.');
  return transcript.map((word) => ({
    start: Number(word.start), end: Number(word.end), text: String(word.text ?? '').trim(),
  })).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start && word.text);
}

export function validateReview(review, duration) {
  if (!review || !Array.isArray(review.segments)) throw new Error('Codex no devolvió segments[].');
  return review.segments.map((s, i) => {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start || s.end > duration + 0.5 ||
        !['high', 'medium'].includes(s.severity) || typeof s.reason !== 'string' || typeof s.text !== 'string') {
      throw new Error(`Segmento inválido de Codex: ${i + 1}.`);
    }
    return { start: Math.max(0, s.start), end: Math.min(duration, s.end), severity: s.severity, reason: s.reason.trim(), text: s.text.trim() };
  }).sort((a, b) => a.start - b.start);
}

export function makeCuts(segments, duration) {
  const high = segments.filter((s) => s.severity === 'high').map((s) => ({
    start: Math.max(0, s.start - 0.3), end: Math.min(duration, s.end + 0.3),
    reasons: [s.reason], texts: [s.text],
  })).sort((a, b) => a.start - b.start);
  const cuts = [];
  for (const cut of high) {
    const last = cuts.at(-1);
    if (last && cut.start <= last.end + 0.5) {
      last.end = Math.max(last.end, cut.end);
      last.reasons.push(...cut.reasons);
      last.texts.push(...cut.texts);
    } else cuts.push(cut);
  }
  return cuts.map((c) => ({ ...c, start: +c.start.toFixed(3), end: +c.end.toFixed(3) }));
}

export function keptRanges(cuts, duration) {
  const kept = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start - cursor >= 0.001) kept.push([cursor, cut.start]);
    cursor = Math.max(cursor, cut.end);
  }
  if (duration - cursor >= 0.001) kept.push([cursor, duration]);
  return kept;
}

export function timestamp(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

export function report(videoName, duration, segments, cuts) {
  const lines = [`VIDEO:\n${videoName}`, `DURACIÓN:\n${timestamp(duration)}`, `SEGMENTOS DETECTADOS:\n${segments.length}`, `CORTES PROPUESTOS:\n${cuts.length}`];
  cuts.forEach((cut, i) => lines.push(`CORTE ${i + 1}\n${timestamp(cut.start)} --> ${timestamp(cut.end)}\nMotivo: ${[...new Set(cut.reasons)].join('; ')}\nTexto: ${cut.texts.join(' … ')}`));
  lines.push(`TIEMPO TOTAL ELIMINADO:\n${timestamp(cuts.reduce((n, cut) => n + cut.end - cut.start, 0))}`);
  if (segments.some((s) => s.severity === 'medium')) lines.push(`SEGMENTOS MEDIOS (sin corte automático):\n${segments.filter((s) => s.severity === 'medium').map((s) => `${timestamp(s.start)} --> ${timestamp(s.end)} | ${s.reason} | ${s.text}`).join('\n')}`);
  return `${lines.join('\n\n')}\n`;
}
