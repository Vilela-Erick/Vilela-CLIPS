import { classifyContent, PERSON_CENTRIC } from './content-classifier.mjs';
import { scoreCandidate } from './framing-score.mjs';
import { SMART_FRAMING_VERSION } from './version.mjs';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const even = (value) => Math.max(2, 2 * Math.round(value / 2));

function union(boxes) {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return { x, y, width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - y };
}

export function fitCrop(bounds, aspect, limits, padding = 0.08) {
  const wanted = { x: bounds.x - bounds.width * padding, y: bounds.y - bounds.height * padding,
    width: bounds.width * (1 + 2 * padding), height: bounds.height * (1 + 2 * padding) };
  const width = Math.max(wanted.width, wanted.height * aspect);
  const height = width / aspect;
  if (width > limits.width + 0.5 || height > limits.height + 0.5) return null;
  const x = clamp(wanted.x + wanted.width / 2 - width / 2, limits.x, limits.x + limits.width - width);
  const y = clamp(wanted.y + wanted.height / 2 - height / 2, limits.y, limits.y + limits.height - height);
  const crop = { x: even(x), y: even(y), width: even(width), height: even(height) };
  if (crop.x < limits.x || crop.y < limits.y || crop.x + crop.width > limits.x + limits.width + 2 ||
      crop.y + crop.height > limits.y + limits.height + 2) return null;
  return crop;
}

function regionsForSplit(subjects, source, padding) {
  if (subjects.length !== 2) return null;
  const [left, right] = subjects;
  const midpoint = even((left.face.x + left.face.width + right.face.x) / 2);
  if (midpoint < source.width * 0.25 || midpoint > source.width * 0.75) return null;
  const limits = [
    { x: 0, y: 0, width: midpoint, height: source.height },
    { x: midpoint, y: 0, width: source.width - midpoint, height: source.height },
  ];
  const crops = subjects.map((subject, index) => {
    // El panel encuadra rostro y torso superior; la parte inferior del cuerpo no siempre es necesaria en una llamada.
    const face = subject.face;
    const upperBody = { x: face.x - face.width * 1.1, y: face.y - face.height * 0.5,
      width: face.width * 3.2, height: face.height * 3 };
    const crop = fitCrop(upperBody, 1.6, limits[index], padding);
    if (!crop || face.x < crop.x || face.x + face.width > crop.x + crop.width ||
      face.y < crop.y || face.y + face.height > crop.y + crop.height) return null;
    return crop;
  });
  return crops.every(Boolean) ? crops : null;
}

export function framingCandidates(analysis, classification, config = {}) {
  const source = analysis.source;
  const subjects = analysis.subjects || [];
  const padding = config.padding ?? 0.08;
  const candidates = [{ strategy: 'full-frame', crop: null, reason: 'Se conserva el origen completo.' }];
  if (analysis.activeRegion && subjects.length === 2) {
    const band = analysis.videoRegion || analysis.activeRegion;
    const midpoint = even((subjects[0].face.x + subjects[0].face.width + subjects[1].face.x) / 2);
    if (midpoint > source.width * 0.3 && midpoint < source.width * 0.7) {
      candidates.push({ strategy: 'recomposed-split', variant: 'embedded-landscape',
        regions: [{ x: 0, y: even(band.y), width: midpoint, height: even(band.height) },
          { x: midpoint, y: even(band.y), width: source.width - midpoint, height: even(band.height) }],
        reason: 'Se apilan ambos participantes de la franja horizontal incrustada.' });
    }
  }
  if (!PERSON_CENTRIC.has(classification.contentType) || !subjects.length) {
    if (analysis.decorative?.cropFraction && classification.contentType !== 'native-vertical') {
      const left = even(source.width * analysis.decorative.cropFraction.left);
      const right = even(source.width * analysis.decorative.cropFraction.right);
      candidates.push({ strategy: 'enhanced-landscape', crop: { x: left, y: 0, width: source.width - left - right, height: source.height },
        reason: 'Se retiran paneles laterales decorativos.' });
    }
    return candidates;
  }
  const bounds = union(subjects.map((subject) => subject.person));
  for (const [name, aspect] of [['people-region-9:16', 9 / 16], ['people-region-4:5', 4 / 5]]) {
    const crop = fitCrop(bounds, aspect, { x: 0, y: 0, ...source }, padding);
    if (crop) candidates.push({ strategy: 'people-region', variant: name, crop,
      reason: 'Región estable alrededor de los participantes con margen de seguridad.' });
  }
  if (subjects.length === 2) {
    const regions = regionsForSplit(subjects, source, padding);
    if (regions) candidates.push({ strategy: 'recomposed-split', regions,
      reason: 'Dos regiones de participantes se extraen y apilan sin deformación.' });
  }
  const portrait = fitCrop(union(subjects.map((subject) => subject.face)), 4 / 5,
    { x: 0, y: 0, ...source }, padding * 1.5);
  if (portrait) candidates.push({ strategy: 'safe-portrait', crop: portrait,
    reason: 'Recorte vertical seguro para los rostros; puede perder parte del cuerpo.' });
  const sidebar = analysis.decorative?.cropFraction;
  if (sidebar) {
    const left = even(source.width * sidebar.left), right = even(source.width * sidebar.right);
    candidates.push({ strategy: 'enhanced-landscape', crop: { x: left, y: 0, width: source.width - left - right, height: source.height },
      reason: 'Se elimina UI lateral prescindible manteniendo la escena.' });
  }
  return candidates;
}

export function decideFraming(analysis, config = {}) {
  const began = performance.now();
  const classification = classifyContent(analysis);
  const candidates = framingCandidates(analysis, classification, config)
    .map((candidate) => scoreCandidate(candidate, analysis, classification, config))
    .sort((a, b) => b.metrics.score - a.metrics.score);
  const chosen = candidates[0];
  const before = candidates.find((candidate) => candidate.strategy === 'full-frame').metrics;
  return { version: SMART_FRAMING_VERSION, contentType: classification.contentType,
    strategy: chosen.strategy, confidence: +Math.min(classification.confidence, chosen.metrics.facePreservation).toFixed(3),
    source: { ...analysis.source, aspect: +(analysis.source.width / analysis.source.height).toFixed(3) },
    subjects: analysis.subjects, regions: chosen.regions || (chosen.crop ? [chosen.crop] : []),
    crop: chosen.crop || null, metrics: { ...chosen.metrics, subjectCoverageBefore: before.subjectCoverage,
      subjectCoverageAfter: chosen.metrics.subjectCoverage },
    candidates: candidates.map(({ strategy, variant, metrics, reason }) => ({ strategy, ...(variant ? { variant } : {}), metrics, reason })),
    reason: `${classification.reason} ${chosen.reason}`,
    detector: analysis.detector, decorative: analysis.decorative,
    timings: { ...analysis.timings, classificationAndDecisionMs: Math.round(performance.now() - began) } };
}
