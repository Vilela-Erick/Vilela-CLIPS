import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createClipGraphics, layoutHook, HOOK_SECONDS, RED_TEXT, GREEN_TEXT, BRAND_FONT_SIZE } from './clips-graphics.mjs';

test('hook dinamico y branding exacto se ajustan al canvas vertical', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clips-graphics-'));
  try {
    const short = await layoutHook('AGUA DE 99 CENTAVOS');
    const long = await layoutHook('EN EL PISO PAREJO HAY NIVELES');
    assert.ok(short.lines.length <= long.lines.length);
    assert.deepEqual(long.lines, ['EN EL PISO PAREJO', 'HAY NIVELES']);
    const result = await createClipGraphics('EN EL PISO PAREJO HAY NIVELES', dir, 'test');
    assert.equal(HOOK_SECONDS, 7);
    assert.equal(BRAND_FONT_SIZE, 44);
    assert.equal(RED_TEXT, 'COMPLETO EN YT- YERI_LOKOLOKO');
    assert.equal(GREEN_TEXT, 'DIRECTOS EN KICK- YERILOKOLOKO');
    assert.ok(result.cardWidth < 1080 - 100);
    assert.ok(result.hookY > 120);
    assert.ok(result.brandY > 1400 && result.brandY + 190 < 1920 - 200);
    assert.equal((await sharp(result.brandPath).metadata()).width, 952);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
