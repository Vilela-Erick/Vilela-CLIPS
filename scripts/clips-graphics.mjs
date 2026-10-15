import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

export const HOOK_SECONDS = 7;
export const BRAND_FONT_SIZE = 44;
export const RED_TEXT = 'COMPLETO EN YT- YERI_LOKOLOKO';
export const GREEN_TEXT = 'DIRECTOS EN KICK- YERILOKOLOKO';

const FONT_PATHS = process.platform === 'win32'
  ? ['C:/Windows/Fonts/ariblk.ttf', 'C:/Windows/Fonts/segoeuib.ttf']
  : ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'];
const FONT_FILE = FONT_PATHS.find(existsSync);
if (!FONT_FILE) throw new Error('No hay una fuente sans serif gruesa disponible para los clips.');
export const FONT_NAME = FONT_FILE.toLowerCase().includes('ariblk') ? 'Arial Black' :
  FONT_FILE.toLowerCase().includes('segoe') ? 'Segoe UI' : 'DejaVu Sans';

const escapeMarkup = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const roundedRect = (width, height, radius, fill) => Buffer.from(
  `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" rx="${radius}" fill="${fill}"/></svg>`,
);

async function textImage(text, size, color = '#000000') {
  const markup = `<span foreground="${color}">${escapeMarkup(text)}</span>`;
  return sharp({ text: { text: markup, font: `${FONT_NAME} ${size}`, fontfile: FONT_FILE, rgba: true } })
    .png().toBuffer({ resolveWithObject: true });
}

export async function layoutHook(hook) {
  const words = String(hook).trim().split(/\s+/u).filter(Boolean);
  if (!words.length) throw new Error('Hook vacío para la tarjeta blanca.');
  for (const lineCount of [1, 2, 3]) {
    const sizes = lineCount === 3 ? [68, 64] : [76, 72, 68, 64];
    for (const fontSize of sizes) {
      const variants = [];
      const build = (start, remaining, lines) => {
        if (remaining === 1) {
          if (start < words.length) variants.push([...lines, words.slice(start).join(' ')]);
          return;
        }
        for (let end = start + 1; end <= words.length - remaining + 1; end++) {
          build(end, remaining - 1, [...lines, words.slice(start, end).join(' ')]);
        }
      };
      build(0, lineCount, []);
      let best;
      for (const lines of variants) {
        const images = await Promise.all(lines.map((line) => textImage(line, fontSize)));
        const widths = images.map(({ info }) => info.width);
        if (Math.max(...widths) > 840) continue;
        const score = Math.max(...widths) + (Math.max(...widths) - Math.min(...widths)) * 0.15;
        if (!best || score < best.score) best = { lines, images, fontSize, score };
      }
      if (best) return best;
    }
  }
  throw new Error(`El hook no cabe en tres líneas: ${hook}`);
}

export async function createClipGraphics(hook, dir, id) {
  const layout = await layoutHook(hook);
  const lineGap = 12;
  const horizontalPadding = 56;
  const verticalPadding = 27;
  const cardWidth = Math.ceil(Math.max(...layout.images.map(({ info }) => info.width)) + horizontalPadding * 2);
  const cardHeight = Math.ceil(layout.images.reduce((total, { info }) => total + info.height, 0) +
    lineGap * (layout.images.length - 1) + verticalPadding * 2);
  const hookY = layout.lines.length === 3 ? 150 : layout.lines.length === 2 ? 188 : 224;
  const cardBase = await sharp(roundedRect(cardWidth, cardHeight, 25, '#FFFFFF')).png().toBuffer();
  let lineY = verticalPadding;
  const cardLayers = layout.images.map(({ data, info }) => {
    const layer = { input: data, left: Math.round((cardWidth - info.width) / 2), top: lineY };
    lineY += info.height + lineGap;
    return layer;
  });
  const hookPath = join(dir, `hook-card-${id}.png`);
  await sharp(cardBase).composite(cardLayers).png().toFile(hookPath);

  const brandWidth = 952;
  const barHeight = 88;
  const barGap = 14;
  const brandHeight = barHeight * 2 + barGap;
  const brandY = 1480;
  const brandBase = await sharp(Buffer.from(
    `<svg width="${brandWidth}" height="${brandHeight}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${brandWidth}" height="${barHeight}" rx="16" fill="#E32228"/>` +
    `<rect y="${barHeight + barGap}" width="${brandWidth}" height="${barHeight}" rx="16" fill="#59F322"/>` +
    '</svg>',
  )).png().toBuffer();
  const red = await textImage(RED_TEXT, BRAND_FONT_SIZE, '#FFFFFF');
  const green = await textImage(GREEN_TEXT, BRAND_FONT_SIZE, '#000000');
  if (red.info.width > brandWidth - 48 || green.info.width > brandWidth - 48) throw new Error('El branding no cabe en las barras.');
  const brandPath = join(dir, `brand-bars-${id}.png`);
  await sharp(brandBase).composite([
    { input: red.data, left: Math.round((brandWidth - red.info.width) / 2), top: Math.round((barHeight - red.info.height) / 2) },
    { input: green.data, left: Math.round((brandWidth - green.info.width) / 2), top: barHeight + barGap + Math.round((barHeight - green.info.height) / 2) },
  ]).png().toFile(brandPath);
  return { hookPath, brandPath, hookY, brandY, cardWidth, cardHeight,
    hookFontSize: layout.fontSize, hookLines: layout.lines, brandFontSize: BRAND_FONT_SIZE };
}
