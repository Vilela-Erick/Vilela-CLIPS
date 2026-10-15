import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getVideoContext, getSharedTranscript, compactTranscript } from './pipeline-cache.mjs';
import { splitSegmentWindows, selectCandidates, getDiscovery, getYoutubeReview, DISCOVERY_VERSION } from './pipeline-analysis.mjs';
import { POLICY_VERSION, sha256 } from './youtube-core.mjs';
import { renderArgs, renderKey, renderSelected } from './pipeline-render.mjs';
import { runProcess, saveJson } from './pipeline-runtime.mjs';
import { parseClipOptions } from './sacar-clips.mjs';

const temporary = (fn) => async () => {
  const root = mkdtempSync(join(tmpdir(), 'primer-video-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const word = (text, start) => ({ text, start, end: start + 0.5 });
const context = (root, duration = 100) => ({ root, dir: join(root, 'cache', 'abc'), sourceSha256: 'a'.repeat(64),
  metadata: { source: join(root, 'video.mp4'), sourceSha256: 'a'.repeat(64), duration, width: 1920, height: 1080,
    videoStreamIndex: 2, audioStreamIndex: 4 } });
const candidate = (start, end, viralScore = 8) => ({ start, end, duration: end - start,
  hook: `MOMENTO SORPRENDENTE EN ${start}`, viralScore, contextScore: 8, hookScore: 8,
  standaloneScore: 8, reason: 'Historia completa', selected: true });

test('una firma sin cambios reutiliza SHA-256 y ffprobe', temporary(async (root) => {
  const source = join(root, 'video.mp4');
  writeFileSync(source, 'contenido');
  let hashes = 0, probes = 0;
  const run = async () => { probes++; return { stdout: JSON.stringify({ format: { duration: '100' }, streams: [
    { index: 2, codec_type: 'video', width: 1920, height: 1080 }, { index: 4, codec_type: 'audio' },
  ] }) }; };
  const hash = async () => { hashes++; return 'a'.repeat(64); };
  await getVideoContext(source, { root, run, hash, logger: () => {} });
  const again = await getVideoContext(source, { root, run, hash, logger: () => {} });
  assert.equal(hashes, 1);
  assert.equal(probes, 1);
  assert.equal(again.metadata.audioStreamIndex, 4);
}));

test('transcripción compartida en caché crea segmentos sin volver a llamar a Whisper', temporary(async (root) => {
  const ctx = context(root);
  mkdirSync(ctx.dir, { recursive: true });
  saveJson(join(ctx.dir, 'transcript.json'), [word('Hola', 0), word('Bella.', 0.6), word('Respuesta', 2), word('inesperada.', 2.6)]);
  const result = await getSharedTranscript(ctx, { run: () => { throw new Error('No debe transcribir.'); }, logger: () => {} });
  assert.equal(result.transcript.length, 4);
  assert.ok(result.segments.length > 0);
  assert.ok(JSON.stringify(result.segments).length < JSON.stringify(result.transcript).length);
}));

test('fallback de Whisper usa primero tramos de cinco minutos y los cachea', temporary(async (root) => {
  const ctx = context(root, 301);
  mkdirSync(join(ctx.dir, 'transcript-full'), { recursive: true });
  writeFileSync(join(ctx.dir, 'audio.wav'), 'wav');
  saveJson(join(ctx.dir, 'transcript-full', 'transcript.json'), Array.from({ length: 90 }, (_, i) => word(['¿cuál', 'es', 'Juanito?'][i % 3], i * 4)));
  let whisperCalls = 0;
  const run = async (bin, args) => {
    if (bin === 'ffmpeg') { writeFileSync(args.at(-1), 'wav'); return { stdout: '' }; }
    whisperCalls++;
    const dir = args[args.indexOf('--dir') + 1];
    saveJson(join(dir, 'transcript.json'), Array.from({ length: 20 }, (_, i) => word(`palabra${i}`, i * 2)));
    return { stdout: '{"ok":true}\n' };
  };
  const result = await getSharedTranscript(ctx, { run, logger: () => {} });
  assert.equal(whisperCalls, 2);
  assert.ok(result.transcript.length > 20);
  assert.ok(existsSync(join(ctx.dir, 'transcript-parts', '300-00000', 'transcript.json')));
  await getSharedTranscript(ctx, { run: () => { throw new Error('No debe repetir Whisper.'); }, logger: () => {} });
}));

test('ventanas adaptativas y selección por cantidad, score y cortes', () => {
  const small = [[0, 5, 'Una frase.'], [5, 12, 'Otra frase.']];
  assert.equal(splitSegmentWindows(small).length, 1);
  assert.ok(splitSegmentWindows(Array.from({ length: 50 }, (_, i) => [i * 10, i * 10 + 9, 'texto '.repeat(10)]), 800, 20).length > 1);
  const discovered = [candidate(0, 40, 9), candidate(50, 90, 8), candidate(100, 140, 7), candidate(150, 190, 9.2)];
  const transcript = Array.from({ length: 200 }, (_, i) => word('palabra.', i));
  const result = selectCandidates(discovered, [{ start: 160, end: 170 }], transcript, { cantidad: 1, minScore: 8 });
  assert.deepEqual(result.filter((item) => item.selected).map((item) => item.start), [0]);
  assert.equal(parseClipOptions(['--cantidad', '2', '--min-score', '7', '--encoder', 'auto']).cantidad, 2);
  assert.throws(() => parseClipOptions(['--cantidad', '0']));
});

test('revisión y descubrimiento en caché no vuelven a llamar a Codex', temporary(async (root) => {
  const ctx = context(root);
  mkdirSync(ctx.dir, { recursive: true });
  const data = { transcript: [word('Hola.', 0)], segments: [[0, 1, 'Hola.']], transcriptHash: 'texto-hash' };
  const reviewKey = sha256(JSON.stringify({ transcriptHash: data.transcriptHash, policy: POLICY_VERSION, promptVersion: 1 }));
  saveJson(join(ctx.dir, 'youtube-review.json'), { cacheKey: reviewKey, segments: [] });
  saveJson(join(ctx.dir, 'cuts.json'), []);
  assert.equal((await getYoutubeReview(ctx, data, { run: () => { throw new Error('Codex no debe ejecutarse.'); } })).cached, true);
  const discoveryKey = sha256(JSON.stringify({ transcriptHash: data.transcriptHash, cuts: [], version: DISCOVERY_VERSION }));
  saveJson(join(ctx.dir, 'discovery.json'), { cacheKey: discoveryKey, candidates: [candidate(0, 40)] });
  const found = await getDiscovery(ctx, data, [], { run: () => { throw new Error('Codex no debe ejecutarse.'); } });
  assert.equal(found.cached, true);
  assert.equal(found.candidates.length, 1);
}));

test('render-key, seek y streams principales son explícitos; el filtro no desenfoca', () => {
  const ctx = context('C:/test');
  const item = candidate(40, 80);
  const layout = { sideCropFraction: 0, layout: 'full_black' };
  const first = renderKey(ctx.sourceSha256, item, layout, { encoder: 'libx264' });
  assert.equal(first, renderKey(ctx.sourceSha256, item, layout, { encoder: 'libx264' }));
  assert.notEqual(first, renderKey(ctx.sourceSha256, { ...item, hook: 'OTRO HOOK REAL' }, layout, { encoder: 'libx264' }));
  const cropLayout = { layout: 'people_crop', crop: { x: 354, y: 0, width: 1212, height: 1080 } };
  assert.notEqual(first, renderKey(ctx.sourceSha256, item, cropLayout, { encoder: 'libx264' }));
  assert.notEqual(renderKey(ctx.sourceSha256, item, cropLayout, { encoder: 'libx264' }),
    renderKey(ctx.sourceSha256, item, { ...cropLayout, crop: { ...cropLayout.crop, x: 360, width: 1206 } }, { encoder: 'libx264' }));
  const args = renderArgs(ctx, item, { hookPath: 'hook.png', brandPath: 'brand.png', hookY: 188, brandY: 1480 }, layout, 'libx264', 'out.mp4');
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'));
  assert.equal(args[args.indexOf('-ss') + 1], '40');
  assert.match(args[args.indexOf('-filter_complex') + 1], /^\[0:2\].*pad=1080:1920/);
  assert.ok(args.includes('0:4'));
  assert.ok(args.includes('-sn') && args.includes('-dn') && args.includes('-map_metadata'));
  assert.ok(!args.some((arg) => /boxblur|gblur|filter_complex_script/.test(arg)));
});

test('estado de render salta MP4 válidos y permite reanudar', temporary(async (root) => {
  const ctx = context(root);
  mkdirSync(ctx.dir, { recursive: true });
  const selected = [candidate(0, 40), candidate(50, 90)];
  const layout = { sideCropFraction: 0, layout: 'full_black', reason: 'Completo.' };
  const framing = { clips: selected.map((item) => ({ start: item.start, end: item.end, ...layout })) };
  const entries = {};
  for (const item of selected) {
    const path = join(root, `${item.start}.mp4`);
    writeFileSync(path, Buffer.alloc(101_000));
    entries[renderKey(ctx.sourceSha256, item, layout, { encoder: 'libx264', crf: 20, audioKbps: 192 })] = { path, duration: item.duration };
  }
  saveJson(join(ctx.dir, 'render-state.json'), { entries });
  const run = async (bin) => {
    assert.equal(bin, 'ffprobe');
    return { stdout: JSON.stringify({ streams: [{ codec_name: 'h264', width: 1080, height: 1920 }], format: { duration: 40 } }) };
  };
  const result = await renderSelected(ctx, selected, framing, { encoder: 'libx264', run, logger: () => {} });
  assert.equal(result.length, 2);
}));

test('timeout termina el proceso hijo antes de devolver el error', temporary(async (root) => {
  const marker = join(root, 'marker.txt');
  await assert.rejects(runProcess(process.execPath, ['-e', `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'late'),500);setInterval(()=>{},1000)`],
    { timeoutMs: 80 }), /superó/);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(existsSync(marker), false);
}));

test('un fallo de certificado aborta Codex sin esperar todo el timeout', temporary(async (root) => {
  const marker = join(root, 'late.txt');
  const started = performance.now();
  await assert.rejects(runProcess(process.execPath, ['-e', `console.error('invalid peer certificate: UnknownIssuer');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'late'),1000);setInterval(()=>{},1000)`],
    { timeoutMs: 5000, abortOnStderr: /invalid peer certificate: UnknownIssuer/ }), /certificado TLS/);
  assert.ok(performance.now() - started < 3000);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(existsSync(marker), false);
}));
