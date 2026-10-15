export function safeHook(value) {
  const hook = String(value ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/u, '');
  if (!hook || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(hook)) throw new Error('Hook inválido para un nombre de archivo.');
  return hook.slice(0, 120).replace(/[. ]+$/u, '');
}

export function uniqueName(hook, occupied) {
  const stem = safeHook(hook);
  let name = `${stem}.mp4`;
  for (let n = 2; occupied.has(name.toLocaleLowerCase()); n++) name = `${stem} (${n}).mp4`;
  occupied.add(name.toLocaleLowerCase());
  return name;
}

export function intersectsCut(start, end, cuts, margin = 0.5) {
  return cuts.some((cut) => start < cut.end + margin && end > cut.start - margin);
}

export function validateCandidates(value, duration, cuts) {
  if (!value || !Array.isArray(value.candidates)) throw new Error('Codex no devolvió candidates[].');
  return value.candidates.map((raw) => {
    const start = Number(raw.start), end = Number(raw.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration + 0.25 || end <= start) throw new Error('Candidato con tiempos inválidos.');
    if (end - start < 29 || end - start > 91) return null;
    const hook = safeHook(raw.hook);
    const hookFits = hook.split(/\s+/u).length >= 3 && hook.split(/\s+/u).length <= 9;
    try { wrapHook(hook); } catch { throw new Error(`Hook demasiado largo para pantalla: ${hook}`); }
    const scores = Object.fromEntries(['viralScore', 'contextScore', 'hookScore', 'standaloneScore'].map((key) => [key, Number(raw[key])]));
    if (Object.values(scores).some((score) => !Number.isFinite(score) || score < 0 || score > 10)) throw new Error('Puntajes inválidos.');
    const excluded = intersectsCut(start, end, cuts);
    return { start, end, duration: +(end - start).toFixed(3), hook, ...scores,
      reason: String(raw.reason ?? '').trim(), selected: !excluded && hookFits && scores.viralScore >= 7.5 && scores.contextScore >= 7 && scores.standaloneScore >= 7 && raw.selected !== false,
      ...(excluded ? { exclusionReason: 'Interseca un corte de idoneidad con margen de seguridad.' } : !hookFits ? { exclusionReason: 'El hook no tiene entre 3 y 9 palabras.' } : {}) };
  }).filter(Boolean).sort((a, b) => a.start - b.start);
}

export function wrapHook(hook, max = 22) {
  const lines = [''];
  for (const word of hook.split(' ')) {
    const last = lines.length - 1;
    if (lines[last] && `${lines[last]} ${word}`.length > max) lines.push(word);
    else lines[last] += `${lines[last] ? ' ' : ''}${word}`;
  }
  if (lines.length > 3) throw new Error(`Hook demasiado largo para pantalla: ${hook}`);
  return lines.join('\n');
}

export function verticalFilter(cropRegion = null, hookY = 188, brandY = 1480, videoStreamIndex = 0) {
  if (![hookY, brandY].every((value) => Number.isSafeInteger(value) && value >= 0 && value < 1920)) throw new Error('Posicion grafica invalida.');
  if (typeof cropRegion === 'number') {
    if (!Number.isFinite(cropRegion) || cropRegion < 0 || cropRegion >= 0.3) throw new Error('Recorte lateral de layout invalido.');
    cropRegion = cropRegion ? { x: null, fraction: cropRegion } : null;
  }
  if (cropRegion && !('fraction' in cropRegion) &&
      ![cropRegion.x, cropRegion.y, cropRegion.width, cropRegion.height].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      cropRegion && !('fraction' in cropRegion) && (cropRegion.width < 2 || cropRegion.height < 2)) {
    throw new Error('Región de recorte inválida.');
  }
  const crop = cropRegion?.fraction
    ? `crop=iw-2*trunc(iw*${cropRegion.fraction}/2)*2:ih:trunc(iw*${cropRegion.fraction}/2)*2:0,`
    : cropRegion ? `crop=${cropRegion.width}:${cropRegion.height}:${cropRegion.x}:${cropRegion.y},` : '';
  return [
    `[0:${videoStreamIndex}]${crop}scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[base]`,
    `[base][1:v]overlay=(W-w)/2:${hookY}:enable=lt(t\\,7)[withHook]`,
    `[withHook][2:v]overlay=(W-w)/2:${brandY}[v]`,
  ].join(';');
}

