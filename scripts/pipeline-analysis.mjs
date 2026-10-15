import { join } from 'node:path';
import { makeCuts, parseWords, POLICY_VERSION, sha256, validateReview } from './youtube-core.mjs';
import { validateCandidates } from './clips-core.mjs';
import { revalidateCandidatesAgainstCuts, CUT_MARGIN } from './clips-cut-validation.mjs';
import { readJson, saveJson } from './pipeline-runtime.mjs';
import { callCodex } from './pipeline-codex.mjs';

export const DISCOVERY_VERSION = 1;
export const SELECTION_RULES_VERSION = 1;
const MAX_PROMPT_SEGMENT_CHARS = 28_000;

export function splitSegmentWindows(segments, maxChars = MAX_PROMPT_SEGMENT_CHARS, overlapSeconds = 45) {
  if (!segments.length) return [];
  if (JSON.stringify(segments).length <= maxChars) return [{ start: segments[0][0], end: segments.at(-1)[1], segments }];
  const windows = [];
  let first = 0;
  while (first < segments.length) {
    let last = first;
    while (last + 1 < segments.length && JSON.stringify(segments.slice(first, last + 2)).length <= maxChars) last++;
    if (last === first && JSON.stringify([segments[first]]).length > maxChars) throw new Error('Segmento de transcripción excesivamente largo.');
    windows.push({ start: segments[first][0], end: segments[last][1], segments: segments.slice(first, last + 1) });
    if (last === segments.length - 1) break;
    const target = segments[last][1] - overlapSeconds;
    let next = first + 1;
    while (next < last && segments[next][0] < target) next++;
    first = next;
  }
  return windows;
}

function reviewPrompt(segments, duration) {
  return `Revisa idoneidad publicitaria de YouTube en español. Responde JSON conforme al esquema. Marca high para conversación sexual explícita prolongada (actos, genitales, contacto, insinuaciones fuertes) o lenguaje extremadamente vulgar repetido; medium solo ante duda real. Usa contexto, no palabras aisladas. high debe abarcar el intercambio completo. No marques bromas normales, cerveza, likes, monetización ni insultos moderados aislados. No inventes tiempos ni texto. Duración ${duration.toFixed(2)} s. Segmentos [inicio,fin,texto] del video original:\n${JSON.stringify(segments)}`;
}

export async function getYoutubeReview(context, transcriptData, options = {}) {
  const { dir, metadata } = context;
  const reviewPath = join(dir, 'youtube-review.json');
  const cutsPath = join(dir, 'cuts.json');
  const key = sha256(JSON.stringify({ transcriptHash: transcriptData.transcriptHash, policy: POLICY_VERSION, promptVersion: 1 }));
  const cached = readJson(reviewPath);
  if (cached?.cacheKey === key && Array.isArray(readJson(cutsPath))) return { segments: validateReview(cached, metadata.duration), cuts: readJson(cutsPath), cached: true };
  const legacyDir = join(context.root, 'work', 'cache', context.sourceSha256);
  const legacyMarker = readJson(join(legacyDir, 'review-cache.json'));
  const legacyReview = readJson(join(legacyDir, 'youtube-review.json'));
  if (legacyMarker?.transcriptHash === transcriptData.transcriptHash && legacyMarker.policyVersion === POLICY_VERSION && legacyReview) {
    const segments = validateReview(legacyReview, metadata.duration);
    const cuts = makeCuts(segments, metadata.duration);
    saveJson(reviewPath, { cacheKey: key, segments });
    saveJson(cutsPath, cuts);
    return { segments, cuts, cached: true };
  }
  const windows = splitSegmentWindows(transcriptData.segments);
  const found = [];
  for (const [index, window] of windows.entries()) {
    const name = `youtube-review-${String(index + 1).padStart(2, '0')}`;
    const prompt = reviewPrompt(window.segments, metadata.duration);
    const windowKey = sha256(`${key}:${prompt}`);
    const path = join(dir, `${name}.json`);
    let response = readJson(path);
    if (response?.cacheKey !== windowKey) {
      response = (await callCodex(context, prompt, 'youtube-review.schema.json', name, options)).response;
      saveJson(path, { ...response, cacheKey: windowKey });
    }
    found.push(...validateReview(response, metadata.duration));
  }
  found.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const item of found) {
    const previous = merged.at(-1);
    if (previous && previous.severity === item.severity && item.start < previous.end) {
      previous.end = Math.max(previous.end, item.end);
      if (!previous.text.includes(item.text)) previous.text += ` … ${item.text}`;
    } else merged.push({ ...item });
  }
  const cuts = makeCuts(merged, metadata.duration);
  saveJson(reviewPath, { cacheKey: key, segments: merged });
  saveJson(cutsPath, cuts);
  return { segments: merged, cuts, cached: false };
}

export function discoveryPrompt(window, duration, cuts) {
  const nearbyCuts = cuts.filter((cut) => cut.end >= window.start && cut.start <= window.end).map(({ start, end }) => ({ start, end }));
  return `Encuentra momentos POTENCIALMENTE útiles para clips verticales en esta conversación. Devuelve JSON conforme al esquema, con candidates[]. Es descubrimiento: incluye momentos prometedores aunque luego no todos se exporten; no fuerces una cuota. Cada candidato debe entenderse solo, tener inicio, desarrollo y remate; busca humor, conflicto, confesión, respuesta inesperada, coqueteo, historia corta o curiosidad. Propón límites naturales entre 30 y 90 s, timestamps ABSOLUTOS del original. Hook breve, fiel, 3–9 palabras en mayúsculas. Puntúa viralScore, contextScore, hookScore y standaloneScore de 0 a 10; selected=true para toda propuesta. No inventes hechos visuales. Duración total ${duration.toFixed(2)} s. Evita estos cortes con margen ${CUT_MARGIN} s: ${JSON.stringify(nearbyCuts)}. Segmentos [inicio,fin,texto]:\n${JSON.stringify(window.segments)}`;
}

export async function getDiscovery(context, transcriptData, cuts, options = {}) {
  const { dir, metadata } = context;
  const key = sha256(JSON.stringify({ transcriptHash: transcriptData.transcriptHash, cuts, version: DISCOVERY_VERSION }));
  const path = join(dir, 'discovery.json');
  const cached = readJson(path);
  if (cached?.cacheKey === key && Array.isArray(cached.candidates)) return { candidates: cached.candidates, cacheKey: key, cached: true };
  const windows = splitSegmentWindows(transcriptData.segments);
  const all = [];
  for (const [index, window] of windows.entries()) {
    const name = `discovery-${String(index + 1).padStart(2, '0')}`;
    const prompt = discoveryPrompt(window, metadata.duration, cuts);
    const windowKey = sha256(`${key}:${prompt}`);
    const windowPath = join(dir, `${name}.json`);
    let response = readJson(windowPath);
    if (response?.cacheKey !== windowKey) {
      response = (await callCodex(context, prompt, 'clips-review.schema.json', name, options)).response;
      saveJson(windowPath, { ...response, cacheKey: windowKey });
    }
    const candidates = validateCandidates({ candidates: response.candidates.map((item) => ({ ...item, selected: true })) }, metadata.duration, []);
    all.push(...candidates.filter((candidate) => candidate.start >= window.start - 0.5 && candidate.end <= window.end + 0.5));
  }
  const ranked = all.sort((a, b) => b.viralScore - a.viralScore);
  const unique = [];
  for (const candidate of ranked) {
    if (!unique.some((other) => Math.max(0, Math.min(candidate.end, other.end) - Math.max(candidate.start, other.start)) / Math.min(candidate.duration, other.duration) > 0.65)) unique.push(candidate);
  }
  saveJson(path, { cacheKey: key, discoveryVersion: DISCOVERY_VERSION, candidates: unique });
  return { candidates: unique, cacheKey: key, cached: false };
}

export function selectCandidates(discovery, cuts, transcript, { cantidad = Infinity, minScore = 7.5 } = {}) {
  if (!(cantidad === Infinity || Number.isSafeInteger(cantidad) && cantidad > 0)) throw new Error('--cantidad debe ser un entero positivo.');
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 10) throw new Error('--min-score debe estar entre 0 y 10.');
  const candidates = revalidateCandidatesAgainstCuts(discovery.map((item) => ({ ...item,
    selected: !item.exclusionReason?.includes('hook'),
  })), cuts, parseWords(transcript));
  const ranked = candidates.sort((a, b) => b.viralScore - a.viralScore || b.standaloneScore - a.standaloneScore || b.contextScore - a.contextScore);
  const selected = [];
  for (const candidate of ranked) {
    const reason = !candidate.selected ? candidate.exclusionReason :
      candidate.viralScore < minScore ? `Viral score ${candidate.viralScore} menor que ${minScore}.` :
      candidate.contextScore < 6 || candidate.standaloneScore < 6 ? 'Contexto o autonomía insuficiente.' :
      selected.some((other) => candidate.start < other.end && candidate.end > other.start) ? 'Se solapa con otro momento mejor puntuado.' :
      selected.length >= cantidad ? `Límite de ${cantidad} clips.` : null;
    candidate.selected = !reason;
    if (reason) candidate.exclusionReason = reason;
    if (candidate.selected) selected.push(candidate);
  }
  return ranked.sort((a, b) => a.start - b.start);
}
