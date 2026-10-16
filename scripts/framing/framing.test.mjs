import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { analysisTransform, sampleTimes } from './frame-sampler.mjs';
import { decodeFaces } from './face-detector.mjs';
import { groupFaces, groupPeople, detectActiveRegion, detectVideoRegion, estimatePersonBox, analyzeVisual } from './visual-analyzer.mjs';
import { classifyContent, CONTENT_TYPES } from './content-classifier.mjs';
import { fitCrop, framingCandidates, decideFraming, selectPreviewSample } from './framing-engine.mjs';
import { effectiveContentAspect, subjectCoverage } from './framing-score.mjs';
import { smartVerticalFilter } from './ffmpeg-filter.mjs';
import { framingCacheKey, framingForClip, visualAnalysisCacheKey } from './framing-cache.mjs';
import { previewFraming } from './preview.mjs';
import { SMART_FRAMING_VERSION } from './version.mjs';

const source = { width: 1920, height: 1080 };
const face = (x, y = 260, width = 150, height = 160) => ({ x, y, width, height, confidence: 0.94 });
const subject = (x, id = 0) => {
  const box = face(x);
  return { id, face: box, person: estimatePersonBox(box, source), confidence: 0.94, persistence: 1 };
};
const analysis = (subjects = [], options = {}) => ({ version: 2, detector: 'YuNet', source, subjects,
  decorative: { cropFraction: options.sidebar ?? null, reason: 'fixture' },
  timings: { extractionMs: 5, visualAnalysisMs: 10 } });
const temporary = (fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), 'framing-v2-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('muestra cinco puntos del clip y conserva la proporción en el tensor de análisis', () => {
  assert.deepEqual(sampleTimes(20, 10), [21, 23, 25, 27, 29]);
  assert.equal(sampleTimes(0, 0.1).length, 5);
  assert.deepEqual(analysisTransform(1920, 1080), { scaleX: 1 / 3, scaleY: 1 / 3,
    x: 0, y: 140, width: 640, height: 360 });
});

test('YuNet decodifica una cara real de las salidas ONNX sin inventar sujetos', () => {
  const outputs = {};
  for (const stride of [8, 16, 32]) {
    const count = (640 / stride) ** 2;
    outputs[`cls_${stride}`] = { data: new Float32Array(count) };
    outputs[`obj_${stride}`] = { data: new Float32Array(count) };
    outputs[`bbox_${stride}`] = { data: new Float32Array(count * 4) };
  }
  const index = 20 * 80 + 30;
  outputs.cls_8.data[index] = 0.9;
  outputs.obj_8.data[index] = 0.9;
  outputs.bbox_8.data[index * 4 + 2] = Math.log(10);
  outputs.bbox_8.data[index * 4 + 3] = Math.log(10);
  const result = decodeFaces(outputs, analysisTransform(1920, 1080), source);
  assert.equal(result.length, 1);
  assert.ok(result[0].width > 200);
  assert.equal(decodeFaces(Object.fromEntries(Object.entries(outputs).map(([key, value]) =>
    [key, { data: new Float32Array(value.data.length) }])), analysisTransform(1920, 1080), source).length, 0);
});

test('agrupa detecciones persistentes y conserva una persona cerca del borde', () => {
  const grouped = groupFaces([[face(8)], [face(10)], [face(9)], [], []], source);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].persistence, 0.6);
  assert.equal(grouped[0].person.x, 0);
});

test('tres rostros, incluido uno intermitente, permanecen separados aunque el detector vea un solo cuerpo', () => {
  const detections = [[face(320), face(1330, 380, 110, 140), face(1710, 450, 100, 110)],
    [face(340), face(1340, 380, 110, 140)],
    [face(330), face(1335, 380, 110, 140), face(1610, 450, 100, 110)],
    [face(350), face(1345, 380, 110, 140)],
    [face(340), face(1340, 380, 110, 140), face(1680, 450, 100, 110)]];
  const bodies = detections.map(() => [{ x: 1200, y: 300, width: 600, height: 500, confidence: 0.8 }]);
  const subjects = groupPeople(bodies, groupFaces(detections, source), source);
  assert.equal(subjects.filter((item) => item.faceObserved).length, 3);
  assert.equal(subjects.length, 3);
  const data = analysis(subjects);
  assert.ok(framingCandidates(data, classifyContent(data)).some((item) => item.strategy === 'recomposed-split'));
});

test('contenido con avatar y webcam en esquina no se clasifica como llamada', () => {
  const avatar = { ...subject(600), faceObserved: false };
  const webcam = { ...subject(1570, 1), face: face(1570, 135, 60, 80), faceObserved: true };
  const data = analysis([avatar, webcam]);
  assert.equal(classifyContent(data).contentType, 'screen-content-with-subject');
  assert.ok(framingCandidates(data, classifyContent(data)).some((item) => item.strategy === 'content-with-subject'));
});

test('reacción separa el contenido observado de tres rostros pequeños de la webcam', () => {
  const viewed = { ...subject(500), face: face(500, 440, 120, 140), faceObserved: true };
  const reactors = [1390, 1580, 1800].map((x, index) => ({ ...subject(x, index + 1),
    face: face(x, 140 + index * 35, 55, 65), faceObserved: true }));
  const data = analysis([viewed, ...reactors]);
  const candidate = framingCandidates(data, classifyContent(data)).find((item) => item.strategy === 'content-with-subject');
  assert.ok(candidate);
  assert.equal(candidate.regions.length, 2);
  assert.ok(candidate.regions[0].x < viewed.face.x && candidate.regions[0].x + candidate.regions[0].width > viewed.face.x);
  assert.ok(candidate.regions[0].width < source.width);
  assert.ok(candidate.regions[1].x <= reactors[0].face.x);
  assert.match(smartVerticalFilter({ version: 2, ...candidate }), /force_original_aspect_ratio=decrease/);
});

test('stream de tres personas no recompone incluyendo una franja lateral decorativa', () => {
  const people = [
    { ...subject(425), face: face(425, 300, 165, 245) },
    { ...subject(667, 1), face: face(667, 437, 312, 400) },
    { ...subject(1133, 2), face: face(1133, 429, 270, 297) },
  ];
  const data = analysis(people, { sidebar: { left: 0.18438, right: 0.18438 } });
  assert.ok(framingCandidates(data, classifyContent(data)).some((item) => item.strategy === 'enhanced-landscape'));
  assert.ok(!framingCandidates(data, classifyContent(data)).some((item) => item.strategy === 'recomposed-split'));
});

test('preview prefiere la muestra con todos los rostros y evita el segundo inicial', () => {
  const data = { ...analysis([subject(300), subject(1300, 1)]), samples: [
    { time: 5, faces: [face(300)] }, { time: 15, faces: [face(300), face(1300)] },
    { time: 25, faces: [face(300)] }, { time: 35, faces: [face(300), face(1300)] },
    { time: 45, faces: [] }] };
  assert.deepEqual(selectPreviewSample(data), { timestamp: 15, sampleIndex: 1 });
  assert.deepEqual(decideFraming(data).previewSample, { timestamp: 15, sampleIndex: 1 });
});

test('el análisis no elimina un lateral donde se detectó un rostro', async () => {
  const blank = Buffer.alloc(640 * 640 * 3);
  const result = await analyzeVisual({ metadata: { source: 'fixture', ...source } }, { start: 0, duration: 30 }, {
    sample: async () => ({ frames: Array.from({ length: 5 }, (_, i) => ({ time: i, rgb: blank })),
      transform: analysisTransform(1920, 1080), extractionMs: 1 }),
    detector: { model: 'fixture', detectSubjects: async () => [face(20)] },
    personDetector: { model: 'fixture', detect: async () => [] },
  });
  assert.equal(result.subjects.length, 1);
  assert.equal(result.decorative.cropFraction, null);
});

test('distingue un video horizontal incrustado del branding en un origen vertical', () => {
  const transform = analysisTransform(1080, 1920);
  const frame = Buffer.alloc(640 * 640 * 3);
  for (let y = 220; y < 420; y++) for (let x = transform.x; x < transform.x + transform.width; x++) {
    const i = (y * 640 + x) * 3;
    if (y < 245 || y >= 365) frame.fill(230, i, i + 3);
    else { frame[i] = 30; frame[i + 1] = 95; frame[i + 2] = x < 320 ? 180 : 85; }
  }
  for (let y = 510; y < 555; y++) for (let x = transform.x; x < transform.x + transform.width; x++) {
    const i = (y * 640 + x) * 3; frame[i] = 230; frame[i + 1] = 40;
  }
  const samples = Array.from({ length: 5 }, () => ({ rgb: frame }));
  const band = detectActiveRegion(samples, transform, { width: 1080, height: 1920 });
  assert.ok(band, 'debe localizar la franja horizontal');
  const video = detectVideoRegion(samples, transform, band, { width: 1080, height: 1920 });
  assert.ok(video, 'debe localizar los paneles de video');
  assert.ok(band.y < video.y && video.y + video.height < band.y + band.height);
  assert.ok(video.height < 400);
});

test('un cuerpo persistente complementa el rostro oculto en llamada incrustada', () => {
  const vertical = { width: 1080, height: 1920 };
  const faces = [{ face: { x: 100, y: 850, width: 200, height: 180 },
    person: { x: 0, y: 750, width: 500, height: 350 }, persistence: 0.6, confidence: 0.8 }];
  const bodies = Array.from({ length: 5 }, () => [{ x: 600, y: 780, width: 320, height: 320, confidence: 0.8 }]);
  const subjects = groupPeople(bodies, faces, vertical);
  assert.equal(subjects.length, 2);
  assert.equal(subjects[0].faceObserved, true);
  assert.equal(subjects[1].faceObserved, false);
  const data = { ...analysis(subjects), source: vertical,
    activeRegion: { x: 0, y: 650, width: 1080, height: 620 },
    videoRegion: { x: 0, y: 720, width: 1080, height: 380 } };
  const decision = decideFraming(data);
  assert.equal(decision.contentType, 'video-call');
  assert.equal(decision.strategy, 'recomposed-split');
  assert.ok(decision.metrics.subjectCoverageAfter > decision.metrics.subjectCoverageBefore);
});

test('effectiveContentAspect mide la región útil incrustada, no el canvas 9:16', () => {
  const vertical = { source: { width: 1080, height: 1920 },
    activeRegion: { x: 0, y: 650, width: 1080, height: 608 } };
  assert.equal(effectiveContentAspect({ strategy: 'full-frame' }, vertical), 1.776);
  assert.equal(effectiveContentAspect({ strategy: 'full-frame' }, {
    ...vertical, videoRegion: { x: 0, y: 725, width: 1080, height: 370 },
  }), 2.919);
});

test('effectiveContentAspect mide 4:5 y la región de dos paneles recompuestos', () => {
  const horizontal = { source: { width: 1600, height: 1200 } };
  assert.equal(effectiveContentAspect({ strategy: 'people-region',
    crop: { x: 400, y: 0, width: 800, height: 1000 } }, horizontal), 0.8);
  assert.equal(effectiveContentAspect({ strategy: 'recomposed-split', regions: [
    { x: 0, y: 100, width: 800, height: 500 }, { x: 800, y: 100, width: 800, height: 500 },
  ] }, horizontal), 0.8);
});

test('effectiveContentAspect conserva la proporción de un vertical nativo', () => {
  assert.equal(effectiveContentAspect({ strategy: 'full-frame' },
    { source: { width: 1080, height: 1920 } }), 0.563);
});

test('clasifica fuentes verticales, persona central, llamada, varias personas y baja confianza', () => {
  assert.equal(classifyContent({ ...analysis(), source: { width: 1080, height: 1920 } }).contentType, 'native-vertical');
  assert.equal(classifyContent(analysis([subject(830)])).contentType, 'single-person');
  assert.equal(classifyContent(analysis([subject(300), subject(1350, 1)])).contentType, 'video-call');
  assert.equal(classifyContent(analysis([subject(300), subject(850, 1), subject(1400, 2)])).contentType, 'multi-person');
  assert.equal(classifyContent(analysis()).contentType, 'unknown');
  assert.ok(CONTENT_TYPES.includes('gameplay') && CONTENT_TYPES.includes('screen-content') && CONTENT_TYPES.includes('presentation'));
});

test('gameplay con facecam pequeña no fuerza 4:5 y sin rostros mantiene full-frame', () => {
  const tiny = subject(25);
  tiny.face = face(25, 60, 30, 30);
  tiny.person = estimatePersonBox(tiny.face, source);
  const data = analysis([tiny]);
  assert.equal(classifyContent(data).contentType, 'gameplay-facecam');
  assert.equal(decideFraming(data).strategy, 'content-with-subject');
  assert.equal(decideFraming(analysis()).strategy, 'full-frame');
});

test('un sujeto central produce crop 4:5 o más vertical, padding y límites seguros', () => {
  const decision = decideFraming(analysis([subject(830)]));
  assert.ok(['people-region', 'safe-portrait'].includes(decision.strategy));
  assert.ok(decision.metrics.effectiveContentAspect <= 0.81);
  assert.ok(decision.crop.x <= 830 && decision.crop.x + decision.crop.width >= 980);
  assert.ok(decision.crop.x >= 0 && decision.crop.y >= 0);
  assert.ok(decision.crop.x + decision.crop.width <= 1922 && decision.crop.y + decision.crop.height <= 1082);
  assert.ok(decision.metrics.subjectCoverageAfter > decision.metrics.subjectCoverageBefore);
  assert.equal(fitCrop({ x: 0, y: 0, width: 1920, height: 1080 }, 0.8, { x: 0, y: 0, ...source }), null);
});

test('dos personas centrales tienen decisión estable y mejor cobertura', () => {
  const decision = decideFraming(analysis([subject(650), subject(1100, 1)]));
  assert.equal(decision.version, SMART_FRAMING_VERSION);
  assert.equal(decision.subjects.length, 2);
  assert.ok(decision.metrics.subjectCoverageAfter >= decision.metrics.subjectCoverageBefore);
  const again = decideFraming(analysis([subject(650), subject(1100, 1)]));
  assert.deepEqual({ strategy: decision.strategy, regions: decision.regions, metrics: decision.metrics },
    { strategy: again.strategy, regions: again.regions, metrics: again.metrics });
});

test('llamada tipo OmeTV evalúa recomposición aunque exista recorte lateral', () => {
  const data = analysis([subject(320), subject(1440, 1)], { sidebar: { left: 0.1, right: 0.1 } });
  const decision = decideFraming(data);
  assert.equal(decision.contentType, 'video-call');
  assert.ok(decision.candidates.some((item) => item.strategy === 'recomposed-split'));
  const split = decision.candidates.find((item) => item.strategy === 'recomposed-split');
  assert.equal(split.metrics.facePreservation, 1);
  assert.ok(split.metrics.subjectCoverage > decision.metrics.subjectCoverageBefore);
});

test('panel izquierdo, derecho o ambos puede generar enhanced landscape; vertical nativo no se recorta', () => {
  for (const sidebar of [{ left: 0.2, right: 0 }, { left: 0, right: 0.2 }, { left: 0.2, right: 0.2 }]) {
    assert.ok(framingCandidates(analysis([], { sidebar }), classifyContent(analysis())).some((item) => item.strategy === 'enhanced-landscape'));
  }
  const vertical = analysis([], { sidebar: { left: 0.2, right: 0.2 } });
  vertical.source = { width: 1080, height: 1920 };
  assert.equal(decideFraming(vertical).strategy, 'full-frame');
});

test('subjectCoverage aumenta al agrandar sujeto y las métricas penalizan pérdidas', () => {
  const people = [subject(830)];
  const full = subjectCoverage({ strategy: 'full-frame' }, people, source);
  const crop = subjectCoverage({ strategy: 'people-region', crop: { x: 500, y: 100, width: 850, height: 900 } }, people, source);
  assert.ok(crop > full);
  const decision = decideFraming(analysis(people));
  assert.ok(decision.metrics.facePreservation >= 0.99);
  assert.ok(decision.metrics.cropRisk <= 0.2);
});

test('FFmpeg recompone dos regiones y recalcula scale después de cada crop sin stretching', () => {
  const decision = decideFraming(analysis([subject(320), subject(1440, 1)]));
  const filter = smartVerticalFilter(decision);
  assert.match(filter, /split=2/);
  assert.equal((filter.match(/force_original_aspect_ratio=decrease/g) || []).length, 2);
  assert.match(filter, /vstack=inputs=2/);
  assert.match(filter, /pad=1080:1920:0:285:black/);
  assert.match(filter, /overlay=.*enable=lt/);
  assert.match(filter, /1480\[v\]$/);
});

test('cambio de versión altera solo la clave de framing y render, no identidad editorial', temporary(async (dir) => {
  const context = { dir, sourceSha256: 'a'.repeat(64), metadata: { source: 'fixture', ...source } };
  const clip = { start: 10, end: 45, duration: 35 };
  const key = framingCacheKey(context, clip);
  assert.notEqual(key, framingCacheKey(context, { ...clip, start: 11 }));
  assert.notEqual(key, framingCacheKey(context, clip, { padding: 0.1 }));
  assert.notEqual(key, framingCacheKey(context, clip, {}, SMART_FRAMING_VERSION + 1));
  assert.equal(visualAnalysisCacheKey(context, clip), visualAnalysisCacheKey(context, clip));
  let calls = 0;
  const analyze = async () => { calls++; return analysis([subject(830)]); };
  await framingForClip(context, clip, { analyze });
  await framingForClip(context, clip, { analyze });
  await framingForClip(context, clip, { analyze, config: { padding: 0.1 } });
  assert.equal(calls, 1);
  const data = JSON.parse(readFileSync(join(dir, 'framing', visualAnalysisCacheKey(context, clip).slice(0, 16),
    `decision-${key.slice(0, 16)}.json`)));
  assert.equal(data.version, 2);
  assert.equal(context.sourceSha256, 'a'.repeat(64));
}));

test('preview usa un frame y no lanza render de MP4', temporary(async (dir) => {
  const context = { root: dir, dir, metadata: { source: 'source.mp4', ...source, videoStreamIndex: 0 } };
  const candidate = { start: 10, duration: 30, hook: 'UN MOMENTO DE PRUEBA' };
  const decision = { ...decideFraming(analysis([subject(830)])), cacheKey: 'b'.repeat(64),
    previewSample: { timestamp: 19, sampleIndex: 2 } };
  let command;
  const path = await previewFraming(context, candidate, decision, {
    graphics: async () => ({ hookPath: 'hook.png', brandPath: 'brand.png', hookY: 188, brandY: 1480 }),
    run: async (bin, args) => { command = { bin, args }; writeFileSync(args.at(-1), 'png'); },
  });
  assert.equal(command.bin, 'ffmpeg');
  assert.equal(command.args[command.args.indexOf('-frames:v') + 1], '1');
  assert.equal(command.args[command.args.indexOf('-ss') + 1], '19');
  assert.ok(path.endsWith('.png'));
}));

test('si falla la detección, full-frame todavía genera un preview válido',
  { skip: spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0 }, temporary(async (dir) => {
    const video = join(dir, 'source.mp4');
    const created = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      'color=c=blue:s=320x180:r=2', '-t', '2', '-c:v', 'mpeg4', video], { windowsHide: true });
    assert.equal(created.status, 0, String(created.stderr));
    const context = { root: dir, dir, sourceSha256: 'f'.repeat(64),
      metadata: { source: video, width: 320, height: 180, videoStreamIndex: 0 } };
    const candidate = { start: 0, end: 2, duration: 2, hook: 'FALLBACK' };
    const decision = await framingForClip(context, candidate, { analyze: async () => { throw new Error('detector unavailable'); } });
    assert.equal(decision.strategy, 'full-frame');
    assert.match(decision.analysisError, /detector unavailable/);
    const hook = join(dir, 'hook.png'), brand = join(dir, 'brand.png');
    await sharp({ create: { width: 200, height: 50, channels: 4, background: '#ffffff' } }).png().toFile(hook);
    await sharp({ create: { width: 200, height: 50, channels: 4, background: '#ff0000' } }).png().toFile(brand);
    const preview = await previewFraming(context, candidate, decision,
      { graphics: async () => ({ hookPath: hook, brandPath: brand, hookY: 188, brandY: 1480 }) });
    const image = await sharp(preview).metadata();
    assert.deepEqual([image.width, image.height], [1080, 1920]);
  }));

test('FFmpeg crea una imagen 1080x1920 con recomposed split sobre video sintético',
  { skip: spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0 }, temporary(async (dir) => {
    const video = join(dir, 'synthetic.mp4');
    const created = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      'color=c=black:s=1920x1080:r=2', '-t', '2', '-c:v', 'mpeg4', video], { windowsHide: true });
    assert.equal(created.status, 0, String(created.stderr));
    const hook = join(dir, 'hook.png'), brand = join(dir, 'brand.png');
    await sharp({ create: { width: 200, height: 50, channels: 4, background: '#ffffff' } }).png().toFile(hook);
    await sharp({ create: { width: 200, height: 50, channels: 4, background: '#ff0000' } }).png().toFile(brand);
    const decision = { ...decideFraming(analysis([subject(320), subject(1440, 1)])), cacheKey: 'c'.repeat(64) };
    assert.equal(decision.strategy, 'recomposed-split');
    const path = await previewFraming({ root: dir, dir, metadata: { source: video, ...source, videoStreamIndex: 0 } },
      { start: 0, duration: 2, hook: 'PREVIEW SINTÉTICO' }, decision,
      { graphics: async () => ({ hookPath: hook, brandPath: brand, hookY: 188, brandY: 1480 }) });
    const dimensions = await sharp(path).metadata();
    assert.deepEqual([dimensions.width, dimensions.height], [1080, 1920]);
  }));
