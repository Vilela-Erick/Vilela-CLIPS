export const CONTENT_TYPES = Object.freeze([
  'single-person', 'conversation', 'video-call', 'interview', 'podcast', 'multi-person', 'stream',
  'gameplay', 'gameplay-facecam', 'screen-content', 'presentation', 'native-vertical', 'unknown',
]);

export const PERSON_CENTRIC = new Set(['single-person', 'conversation', 'video-call', 'interview', 'podcast', 'multi-person']);

export function classifyContent(analysis) {
  const { width, height } = analysis.source;
  const subjects = analysis.subjects || [];
  if (width / height <= 0.8 && !analysis.activeRegion) return { contentType: 'native-vertical', confidence: 0.98, reason: 'El origen ya es vertical.' };
  if (!subjects.length) return { contentType: 'unknown', confidence: 0.25, reason: 'No se detectaron rostros persistentes; se conserva contexto.' };
  if (subjects.length === 1) {
    const face = subjects[0].face;
    const small = face.width * face.height / (width * height) < 0.004;
    const corner = (face.x + face.width / 2 < width * 0.25 || face.x + face.width / 2 > width * 0.75) && face.y < height * 0.55;
    if (small && corner) return { contentType: 'gameplay-facecam', confidence: 0.55,
      reason: 'Rostro pequeño en una esquina; se conserva el contenido de pantalla.' };
    return { contentType: 'single-person', confidence: subjects[0].confidence, reason: 'Un rostro persistente detectado.' };
  }
  if (subjects.length === 2) {
    const separation = (subjects[1].face.x - subjects[0].face.x) / width;
    const persistence = Math.min(...subjects.map((item) => item.persistence));
    if (separation > 0.3 && persistence >= 0.4) return { contentType: 'video-call', confidence: Math.min(0.9, persistence),
      reason: 'Dos participantes persistentes ocupan regiones horizontales separadas.' };
    return { contentType: 'conversation', confidence: Math.min(...subjects.map((item) => item.confidence)),
      reason: 'Dos participantes detectados en la escena.' };
  }
  return { contentType: 'multi-person', confidence: Math.min(...subjects.map((item) => item.confidence)),
    reason: `${subjects.length} participantes detectados.` };
}
