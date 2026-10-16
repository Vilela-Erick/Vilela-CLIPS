import { PERSON_CENTRIC } from './content-classifier.mjs';

export const FRAMING_SCORE_REVISION = 9;
const AREA = 1080 * 1350;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const intersection = (a, b) => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y);
};
const intersectBox = (a, b) => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
};

function panels(candidate, source) {
  if (candidate.strategy === 'recomposed-split') return candidate.regions.map((crop) => ({ crop, width: 1080, height: 675 }));
  if (candidate.strategy === 'content-with-subject') return candidate.regions.map((crop, index) =>
    ({ crop, width: 1080, height: index ? 450 : 900 }));
  return [{ crop: candidate.crop || { x: 0, y: 0, width: source.width, height: source.height }, width: 1080, height: 1350 }];
}

export function effectiveContentAspect(candidate, analysis) {
  const useful = analysis.videoRegion || analysis.activeRegion;
  const parts = panels(candidate, analysis.source);
  const projected = parts.map((panel, index) => {
    const visible = useful ? intersectBox(panel.crop, useful) : panel.crop;
    if (!visible.width || !visible.height) return null;
    const scale = Math.min(panel.width / panel.crop.width, panel.height / panel.crop.height);
    return { x: (panel.width - panel.crop.width * scale) / 2 + (visible.x - panel.crop.x) * scale,
      y: index * panel.height + (panel.height - panel.crop.height * scale) / 2 + (visible.y - panel.crop.y) * scale,
      width: visible.width * scale, height: visible.height * scale };
  }).filter(Boolean);
  if (!projected.length) return 0;
  const left = Math.min(...projected.map((box) => box.x));
  const top = Math.min(...projected.map((box) => box.y));
  const right = Math.max(...projected.map((box) => box.x + box.width));
  const bottom = Math.max(...projected.map((box) => box.y + box.height));
  return +((right - left) / (bottom - top)).toFixed(3);
}

export function subjectCoverage(candidate, subjects, source) {
  if (!subjects.length) return 0;
  const parts = panels(candidate, source);
  const projected = [];
  for (const subject of subjects) {
    let best = null, top = 0;
    for (const panel of parts) {
      const scale = Math.min(panel.width / panel.crop.width, panel.height / panel.crop.height);
      const visible = intersectBox(subject.person, panel.crop);
      const area = visible.width * visible.height * scale * scale;
      if (!best || area > best.area) best = { area,
        x: (panel.width - panel.crop.width * scale) / 2 + (visible.x - panel.crop.x) * scale,
        y: top + (panel.height - panel.crop.height * scale) / 2 + (visible.y - panel.crop.y) * scale,
        width: visible.width * scale, height: visible.height * scale };
      top += panel.height;
    }
    if (best?.area) projected.push(best);
  }
  const edges = [...new Set(projected.flatMap((box) => [box.x, box.x + box.width]))].sort((a, b) => a - b);
  let occupied = 0;
  for (let i = 1; i < edges.length; i++) {
    const active = projected.filter((box) => box.x < edges[i] && box.x + box.width > edges[i - 1])
      .map((box) => [box.y, box.y + box.height]).sort((a, b) => a[0] - b[0]);
    let length = 0, end = -Infinity;
    for (const [start, bottom] of active) {
      length += Math.max(0, bottom - Math.max(start, end));
      end = Math.max(end, bottom);
    }
    occupied += (edges[i] - edges[i - 1]) * length;
  }
  return +clamp(occupied / AREA).toFixed(3);
}

export function scoreCandidate(candidate, analysis, classification, config = {}) {
  const subjects = analysis.subjects || [];
  const parts = panels(candidate, analysis.source);
  const facePreservation = subjects.length ? subjects.reduce((sum, subject) => sum +
    Math.max(...parts.map((panel) => intersection(subject.face, panel.crop))) /
      Math.max(1, subject.face.width * subject.face.height), 0) / subjects.length : 1;
  const personPreservation = subjects.length ? subjects.reduce((sum, subject) => sum +
    Math.max(...parts.map((panel) => intersection(subject.person, panel.crop))) /
      Math.max(1, subject.person.width * subject.person.height), 0) / subjects.length : 1;
  const coverage = subjectCoverage(candidate, subjects, analysis.source);
  const used = parts.reduce((sum, panel) => {
    const scale = Math.min(panel.width / panel.crop.width, panel.height / panel.crop.height);
    const usefulRegion = analysis.videoRegion || analysis.activeRegion;
    const liveArea = usefulRegion ? intersection(panel.crop, usefulRegion) : panel.crop.width * panel.crop.height;
    return sum + liveArea * scale * scale;
  }, 0);
  const wastedSpace = +clamp(1 - used / AREA).toFixed(3);
  const aspect = effectiveContentAspect(candidate, analysis);
  const personCentric = PERSON_CENTRIC.has(classification.contentType);
  const minCoverage = config.minSubjectCoverage ?? 0.19;
  const portrait = personCentric ? clamp((1.25 - aspect) / 0.45) : 0;
  const cropRisk = clamp(1 - facePreservation) * 0.8 + clamp(1 - personPreservation) * 0.2;
  let score = personCentric
    ? 28 * facePreservation + 27 * personPreservation + 18 * clamp(coverage / Math.max(0.01, minCoverage * 2)) +
      15 * portrait + 12 * (1 - wastedSpace) - 35 * cropRisk
    : 70 * facePreservation + 30 * (1 - wastedSpace) - 35 * cropRisk;
  if (personCentric && candidate.strategy === 'full-frame' && aspect > 0.8) score -= 14;
  if (classification.contentType === 'native-vertical' && candidate.strategy !== 'full-frame') score -= 60;
  if (!personCentric && candidate.strategy === 'recomposed-split') score -= 50;
  return { ...candidate, metrics: { subjectCoverage: coverage, facePreservation: +facePreservation.toFixed(3),
    personPreservation: +personPreservation.toFixed(3), effectiveContentAspect: aspect, wastedSpace,
    cropRisk: +cropRisk.toFixed(3), score: +Math.max(0, score).toFixed(1) } };
}
