import { verticalFilter } from '../clips-core.mjs';

function cropFilter(crop) {
  return `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},`;
}

export function smartVerticalFilter(decision, hookY = 188, brandY = 1480, videoStreamIndex = 0) {
  if (!decision || decision.version !== 2 || decision.strategy === 'full-frame') {
    return verticalFilter(decision?.crop ?? null, hookY, brandY, videoStreamIndex);
  }
  const overlay = (base) => [
    `[${base}][1:v]overlay=(W-w)/2:${hookY}:enable=lt(t\\,7)[withHook]`,
    `[withHook][2:v]overlay=(W-w)/2:${brandY}[v]`,
  ];
  if (decision.strategy === 'recomposed-split') {
    if (decision.regions?.length !== 2) throw new Error('Recomposed split requiere dos regiones.');
    const [top, bottom] = decision.regions;
    return [
      `[0:${videoStreamIndex}]split=2[subject0][subject1]`,
      `[subject0]${cropFilter(top)}scale=1078:672:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:675:(ow-iw)/2:(oh-ih)/2:black[top]`,
      `[subject1]${cropFilter(bottom)}scale=1078:672:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:675:(ow-iw)/2:(oh-ih)/2:black[bottom]`,
      '[top][bottom]vstack=inputs=2,pad=1080:1920:0:285:black[base]',
      ...overlay('base'),
    ].join(';');
  }
  if (!decision.crop) throw new Error(`Falta crop para estrategia ${decision.strategy}.`);
  return [
    `[0:${videoStreamIndex}]${cropFilter(decision.crop)}scale=1078:1348:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1350:(ow-iw)/2:(oh-ih)/2:black,pad=1080:1920:0:285:black[base]`,
    ...overlay('base'),
  ].join(';');
}
