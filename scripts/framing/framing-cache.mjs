import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { sha256 } from '../youtube-core.mjs';
import { readJson, saveJson } from '../pipeline-runtime.mjs';
import { analyzeVisual } from './visual-analyzer.mjs';
import { decideFraming } from './framing-engine.mjs';
import { FRAMING_SCORE_REVISION } from './framing-score.mjs';
import { SMART_FRAMING_VERSION } from './version.mjs';

export function framingCacheKey(context, candidate, config = {}, version = SMART_FRAMING_VERSION) {
  return sha256(JSON.stringify({ source: context.sourceSha256, start: candidate.start, end: candidate.end,
    version, scoreRevision: FRAMING_SCORE_REVISION,
    detector: 'YuNet-2023mar-8f2383e4+MediaPipePose-2023mar+video-region-1', config }));
}

export async function framingForClip(context, candidate, { analyze = analyzeVisual, config = {}, logger = () => {} } = {}) {
  const key = framingCacheKey(context, candidate, config);
  const dir = join(context.dir, 'framing', key.slice(0, 16));
  mkdirSync(dir, { recursive: true });
  const analysisPath = join(dir, 'visual-analysis.json');
  const decisionPath = join(dir, 'decision.json');
  let analysis = readJson(analysisPath);
  if (analysis?.cacheKey !== key || analysis?.version !== SMART_FRAMING_VERSION) {
    try { analysis = { ...await analyze(context, candidate), cacheKey: key }; }
    catch (error) {
      logger(`  Smart Framing: análisis visual no disponible (${error.message}); se usa frame completo.`);
      analysis = { version: SMART_FRAMING_VERSION, cacheKey: key, detector: 'unavailable',
        source: { width: context.metadata.width, height: context.metadata.height }, subjects: [],
        decorative: { cropFraction: null, reason: 'Análisis visual no disponible.' },
        timings: { extractionMs: 0, visualAnalysisMs: 0 }, error: error.message };
    }
    if (!analysis.error) saveJson(analysisPath, analysis);
    logger(`  Análisis visual: ${analysis.timings.extractionMs} ms de extracción, ${analysis.timings.visualAnalysisMs} ms de detección.`);
  }
  let decision = readJson(decisionPath);
  if (decision?.cacheKey !== key || decision?.version !== SMART_FRAMING_VERSION) {
    decision = { ...decideFraming(analysis, config), cacheKey: key,
      ...(analysis.error ? { analysisError: analysis.error } : {}) };
    if (!analysis.error) saveJson(decisionPath, decision);
  }
  return decision;
}
