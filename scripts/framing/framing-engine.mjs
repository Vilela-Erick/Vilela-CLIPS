import { classifyContent, PERSON_CENTRIC } from './content-classifier.mjs';
import { scoreCandidate } from './framing-score.mjs';
import { SMART_FRAMING_VERSION } from './version.mjs';
import { subjectClusters } from './visual-analyzer.mjs';

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

function regionsForSplit(clusters, source, padding, decorative) {
  if (clusters.length !== 2) return null;
  const [left, right] = clusters;
  const midpoint = even((left.face.x + left.face.width + right.face.x) / 2);
  if (midpoint < source.width * 0.25 || midpoint > source.width * 0.75) return null;
  const liveLeft = decorative ? even(source.width * decorative.left) : 0;
  const liveRight = decorative ? even(source.width * (1 - decorative.right)) : source.width;
  if (midpoint <= liveLeft || midpoint >= liveRight) return null;
  const limits = [
    { x: liveLeft, y: 0, width: midpoint - liveLeft, height: source.height },
    { x: midpoint, y: 0, width: liveRight - midpoint, height: source.height },
  ];
  const crops = clusters.map((cluster, index) => {
    const face = cluster.face;
    const crop = fitCrop(face, 1.6, limits[index], Math.min(padding, 0.06));
    if (!crop || face.x < crop.x || face.x + face.width > crop.x + crop.width ||
      face.y < crop.y || face.y + face.height > crop.y + crop.height) return null;
    return crop;
  });
  return crops.every(Boolean) ? crops : null;
}

function contentWithSubjectRegions(subjects, source) {
  const corner = subjects.filter((item) => item.faceObserved !== false && item.face.y < source.height * 0.23 &&
    item.face.width * item.face.height / (source.width * source.height) < 0.012 &&
    (item.face.x + item.face.width / 2 < source.width * 0.28 || item.face.x + item.face.width / 2 > source.width * 0.72));
  if (!corner.length) return null;
  const rightSide = corner[0].face.x > source.width / 2;
  const selected = corner.filter((item) => (item.face.x > source.width / 2) === rightSide);
  const face = union(selected.map((item) => item.face));
  const secondaryBounds = selected.length === 1 ? { x: face.x - face.width * 0.5,
    y: face.y - face.height * 0.15, width: face.width * 2, height: face.height * 2 } : face;
  const secondary = fitCrop(secondaryBounds, 2.4, { x: 0, y: 0, ...source }, selected.length === 1 ? 0.1 : 0.2);
  if (!secondary) return null;
  const hasOtherFaces = subjects.some((item) => item.faceObserved !== false && !selected.includes(item));
  const contentFaces = subjects.filter((item) => item.faceObserved !== false && !selected.includes(item));
  const primary = hasOtherFaces ? (() => {
    const content = union(contentFaces.map((item) => item.face));
    const width = even(Math.min(source.width, Math.max(source.width * 0.46, content.width * 4.5)));
    const height = even(Math.min(source.height, Math.max(source.height * 0.75, content.height * 5)));
    return { x: even(clamp(content.x - content.width * 1.4, 0, source.width - width)),
      y: even(clamp(content.y - content.height * 1.8, 0, source.height - height)), width, height };
  })() : { x: 0, y: 0, ...source };
  return [primary, secondary];
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
  const clusters = analysis.subjectClusters?.length ? analysis.subjectClusters : subjectClusters(subjects, source);
  if (clusters.length === 2 && union(clusters.map((item) => item.face)).width /
      Math.max(1, union(clusters.map((item) => item.face)).height) > 1.6) {
    const regions = regionsForSplit(clusters, source, padding, analysis.decorative?.cropFraction);
    if (regions) candidates.push({ strategy: 'recomposed-split', regions,
      reason: 'Clusters espaciales persistentes se apilan sin deformación.' });
  }
  if (classification.contentType === 'screen-content-with-subject' || classification.contentType === 'gameplay-facecam') {
    const regions = contentWithSubjectRegions(subjects, source);
    if (regions) candidates.push({ strategy: 'content-with-subject', regions,
      reason: 'Contenido principal y rostros del borde ocupan paneles de distinto tamaño.' });
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
  const previewSample = selectPreviewSample(analysis);
  return { version: SMART_FRAMING_VERSION, contentType: classification.contentType,
    strategy: chosen.strategy, confidence: +Math.min(classification.confidence, chosen.metrics.facePreservation).toFixed(3),
    source: { ...analysis.source, aspect: +(analysis.source.width / analysis.source.height).toFixed(3) },
    subjects: analysis.subjects, regions: chosen.regions || (chosen.crop ? [chosen.crop] : []),
    crop: chosen.crop || null, metrics: { ...chosen.metrics, subjectCoverageBefore: before.subjectCoverage,
      subjectCoverageAfter: chosen.metrics.subjectCoverage },
    candidates: candidates.map(({ strategy, variant, metrics, reason }) => ({ strategy, ...(variant ? { variant } : {}), metrics, reason })),
    reason: `${classification.reason} ${chosen.reason}`,
    detector: analysis.detector, decorative: analysis.decorative, previewSample,
    timings: { ...analysis.timings, classificationAndDecisionMs: Math.round(performance.now() - began) } };
}

export function selectPreviewSample(analysis) {
  const samples = analysis.samples || [];
  if (!samples.length) return { timestamp: analysis.sampleTimes?.[2] ?? null, sampleIndex: analysis.sampleTimes?.length ? 2 : null };
  const expectedFaces = analysis.subjects?.filter((item) => item.faceObserved !== false) || [];
  const expected = expectedFaces.length;
  const ranked = samples.map((sample, sampleIndex) => ({ sample, sampleIndex,
    count: Math.min(expected + 1, sample.faces?.length || 0),
    layoutDistance: expected ? expectedFaces.reduce((sum, subject) => {
      const center = subject.face.x + subject.face.width / 2;
      return sum + Math.min(1, ...(sample.faces || []).map((face) =>
        Math.abs(center - face.x - face.width / 2) / analysis.source.width));
    }, 0) / expected : 0,
    confidence: (sample.faces || []).reduce((sum, face) => sum + (face.confidence || 0), 0),
    centerDistance: Math.abs(sampleIndex - (samples.length - 1) / 2) }));
  ranked.sort((a, b) => b.count - a.count || a.layoutDistance - b.layoutDistance ||
    a.centerDistance - b.centerDistance || b.confidence - a.confidence);
  return { timestamp: ranked[0].sample.time, sampleIndex: ranked[0].sampleIndex };
}
