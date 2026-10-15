import sharp from 'sharp';
import { detectDecorativeSidebars } from '../layout-detection.mjs';
import { sampleFrames } from './frame-sampler.mjs';
import { createFaceDetector } from './face-detector.mjs';
import { createPersonDetector } from './person-detector.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const roundBox = (box) => Object.fromEntries(Object.entries(box).map(([key, value]) => [key, +value.toFixed(2)]));

export function estimatePersonBox(face, source, padding = 0.08) {
  const centerX = face.x + face.width / 2;
  const x1 = clamp(centerX - face.width * (1.65 + padding), 0, source.width);
  const x2 = clamp(centerX + face.width * (1.65 + padding), 0, source.width);
  const y1 = clamp(face.y - face.height * (0.65 + padding), 0, source.height);
  const y2 = clamp(face.y + face.height * (4.5 + padding), 0, source.height);
  return roundBox({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
}

export function groupFaces(samples, source) {
  const groups = [];
  for (const [sampleIndex, faces] of samples.entries()) {
    for (const face of faces) {
      const centerX = face.x + face.width / 2;
      const centerY = face.y + face.height / 2;
      let group = groups.find((item) => !item.samples.has(sampleIndex) &&
        Math.abs(item.centerX - centerX) < Math.max(source.width * 0.12, face.width * 1.5) &&
        Math.abs(item.centerY - centerY) < Math.max(source.height * 0.2, face.height * 2));
      if (!group) {
        group = { faces: [], samples: new Set(), centerX, centerY };
        groups.push(group);
      }
      group.faces.push(face);
      group.samples.add(sampleIndex);
      group.centerX = group.faces.reduce((sum, item) => sum + item.x + item.width / 2, 0) / group.faces.length;
      group.centerY = group.faces.reduce((sum, item) => sum + item.y + item.height / 2, 0) / group.faces.length;
    }
  }
  return groups.filter((group) => group.samples.size >= 2 || group.faces.some((face) => face.confidence >= 0.9))
    .map((group, id) => {
      const x = Math.min(...group.faces.map((face) => face.x));
      const y = Math.min(...group.faces.map((face) => face.y));
      const right = Math.max(...group.faces.map((face) => face.x + face.width));
      const bottom = Math.max(...group.faces.map((face) => face.y + face.height));
      const face = roundBox({ x, y, width: right - x, height: bottom - y });
      return { id, face, person: estimatePersonBox(face, source), persistence: +(group.samples.size / samples.length).toFixed(2),
        confidence: +(group.faces.reduce((sum, item) => sum + item.confidence, 0) / group.faces.length).toFixed(3) };
    }).sort((a, b) => a.face.x - b.face.x);
}

export function groupPeople(samples, faces, source) {
  const groups = [];
  for (const [sampleIndex, boxes] of samples.entries()) for (const box of boxes) {
    const centerX = box.x + box.width / 2, centerY = box.y + box.height / 2;
    let group = groups.find((item) => !item.samples.has(sampleIndex) &&
      Math.abs(item.centerX - centerX) < source.width * 0.16 &&
      Math.abs(item.centerY - centerY) < source.height * 0.18);
    if (!group) { group = { boxes: [], samples: new Set(), centerX, centerY }; groups.push(group); }
    group.boxes.push(box); group.samples.add(sampleIndex);
    group.centerX = group.boxes.reduce((sum, item) => sum + item.x + item.width / 2, 0) / group.boxes.length;
    group.centerY = group.boxes.reduce((sum, item) => sum + item.y + item.height / 2, 0) / group.boxes.length;
  }
  const subjects = groups.filter((group) => group.samples.size >= 2).map((group) => {
    const x = Math.min(...group.boxes.map((box) => box.x));
    const y = Math.min(...group.boxes.map((box) => box.y));
    const right = Math.max(...group.boxes.map((box) => box.x + box.width));
    const bottom = Math.max(...group.boxes.map((box) => box.y + box.height));
    const person = roundBox({ x, y, width: right - x, height: bottom - y });
    const face = faces.find((item) => Math.abs(item.face.x + item.face.width / 2 - group.centerX) < person.width * 0.5);
    const head = face?.face || roundBox({ x: x + person.width * 0.3, y, width: person.width * 0.4, height: person.height * 0.45 });
    return { id: 0, face: head, faceObserved: Boolean(face), person,
      persistence: +(group.samples.size / samples.length).toFixed(2),
      confidence: +(group.boxes.reduce((sum, item) => sum + item.confidence, 0) / group.boxes.length).toFixed(3) };
  });
  for (const face of faces) if (!subjects.some((item) => Math.abs(item.face.x + item.face.width / 2 - face.face.x - face.face.width / 2) < source.width * 0.18)) {
    subjects.push({ ...face, faceObserved: true });
  }
  return subjects.sort((a, b) => a.face.x - b.face.x).map((item, id) => ({ ...item, id }));
}

export function detectActiveRegion(frames, transform, source) {
  if (source.width / source.height > 0.8) return null;
  const active = new Array(transform.height).fill(0);
  for (const frame of frames) for (let row = 0; row < transform.height; row++) {
    let lit = 0;
    const y = row + transform.y;
    for (let x = transform.x; x < transform.x + transform.width; x += 4) {
      const index = (y * 640 + x) * 3;
      if (Math.max(frame.rgb[index], frame.rgb[index + 1], frame.rgb[index + 2]) > 30) lit++;
    }
    if (lit / Math.ceil(transform.width / 4) > 0.25) active[row]++;
  }
  const runs = [];
  let start = -1;
  for (let y = 0; y <= active.length; y++) {
    if (y < active.length && active[y] >= Math.ceil(frames.length * 0.6)) { if (start < 0) start = y; }
    else if (start >= 0) { if (y - start >= 20) runs.push({ start, end: y }); start = -1; }
  }
  runs.sort((a, b) => b.end - b.start - (a.end - a.start));
  const largest = runs[0];
  if (!largest || largest.end - largest.start > transform.height * 0.65) return null;
  const y = Math.max(0, Math.round(largest.start / transform.scaleY));
  const height = Math.min(source.height - y, Math.round((largest.end - largest.start) / transform.scaleY));
  if (source.width / height < 1.15) return null;
  return { x: 0, y, width: source.width, height };
}

export function detectVideoRegion(frames, transform, activeRegion, source) {
  if (!activeRegion) return null;
  const top = Math.max(0, Math.round(activeRegion.y * transform.scaleY));
  const bottom = Math.min(transform.height, Math.round((activeRegion.y + activeRegion.height) * transform.scaleY));
  const rows = [];
  for (let row = top; row < bottom; row++) {
    let matches = 0;
    for (const frame of frames) {
      let bright = 0, colored = 0, dark = 0, count = 0;
      for (let x = transform.x; x < transform.x + transform.width; x += 4) {
        const i = ((row + transform.y) * 640 + x) * 3;
        const r = frame.rgb[i], g = frame.rgb[i + 1], b = frame.rgb[i + 2];
        if (Math.min(r, g, b) > 200) bright++;
        if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colored++;
        if (Math.max(r, g, b) < 120) dark++;
        count++;
      }
      if (bright / count < 0.55 && colored / count > 0.1 && dark / count > 0.1) matches++;
    }
    rows.push(matches >= Math.ceil(frames.length * 0.6));
  }
  let best = null, start = -1;
  for (let i = 0; i <= rows.length; i++) {
    if (i < rows.length && rows[i]) { if (start < 0) start = i; }
    else if (start >= 0) {
      if (!best || i - start > best.end - best.start) best = { start, end: i };
      start = -1;
    }
  }
  if (!best || best.end - best.start < (bottom - top) * 0.3) return null;
  const y = Math.round((top + best.start) / transform.scaleY);
  return { x: 0, y, width: source.width,
    height: Math.min(source.height - y, Math.round((best.end - best.start) / transform.scaleY)) };
}

async function sidebarSamples(frames, transform) {
  const result = [];
  for (const frame of frames) {
    const rgb = await sharp(frame.rgb, { raw: { width: 640, height: 640, channels: 3 } })
      .extract({ left: transform.x, top: transform.y, width: transform.width, height: transform.height })
      .resize(320, 180).raw().toBuffer();
    result.push(rgb);
  }
  return result;
}

export async function analyzeVisual(context, candidate, { detector, personDetector, sample = sampleFrames } = {}) {
  const source = { width: context.metadata.width, height: context.metadata.height };
  const sampling = await sample(context.metadata.source, candidate.start, candidate.duration, source.width, source.height);
  const started = performance.now();
  const faceDetector = detector || await createFaceDetector();
  const bodyDetector = personDetector || await createPersonDetector();
  const detections = [];
  const people = [];
  for (const frame of sampling.frames) {
    detections.push(await faceDetector.detectSubjects(frame, sampling.transform, source));
    people.push(await bodyDetector.detect(frame, sampling.transform, source));
  }
  const subjects = groupPeople(people, groupFaces(detections, source), source);
  const activeRegion = detectActiveRegion(sampling.frames, sampling.transform, source);
  const videoRegion = detectVideoRegion(sampling.frames, sampling.transform, activeRegion, source);
  if (activeRegion && subjects.length === 2) {
    const midpoint = (subjects[0].face.x + subjects[0].face.width + subjects[1].face.x) / 2;
    for (const [index, subject] of subjects.entries()) {
      const panelLeft = index ? midpoint : 0, panelRight = index ? source.width : midpoint;
      const region = videoRegion || activeRegion;
      const x = Math.max(panelLeft, subject.person.x), y = Math.max(region.y, subject.person.y);
      const right = Math.min(panelRight, subject.person.x + subject.person.width);
      const bottom = Math.min(region.y + region.height, subject.person.y + subject.person.height);
      if (right > x && bottom > y) subject.person = roundBox({ x, y, width: right - x, height: bottom - y });
      if (videoRegion) {
        const headY = Math.max(videoRegion.y, subject.face.y);
        const headBottom = Math.min(videoRegion.y + videoRegion.height, subject.face.y + subject.face.height);
        if (headBottom > headY) subject.face = roundBox({ ...subject.face, y: headY, height: headBottom - headY });
      }
    }
  }
  const sidebars = source.width / source.height >= 1.3
    ? detectDecorativeSidebars(await sidebarSamples(sampling.frames, sampling.transform))
    : { cropFraction: null, reason: 'Fuente vertical o casi cuadrada.' };
  // Una cara observada en una franja impide descartarla, aunque esa franja sea estática.
  if (sidebars.cropFraction) {
    const left = sidebars.cropFraction.left * source.width;
    const right = source.width * (1 - sidebars.cropFraction.right);
    if (subjects.some((subject) => subject.face.x < left || subject.face.x + subject.face.width > right)) {
      sidebars.cropFraction = null;
      sidebars.reason = 'Una persona aparece en una zona lateral; se conserva.';
    }
  }
  return { version: 2, detector: `${faceDetector.model || 'injected'} + ${bodyDetector.model || 'injected'}`, source,
    sampleTimes: sampling.frames.map((frame) => frame.time), activeRegion, videoRegion, subjects, decorative: sidebars,
    timings: { extractionMs: sampling.extractionMs,
      visualAnalysisMs: Math.round(performance.now() - started) } };
}
