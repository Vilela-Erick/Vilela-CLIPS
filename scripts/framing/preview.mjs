import { join } from 'node:path';
import { createClipGraphics } from '../clips-graphics.mjs';
import { runProcess } from '../pipeline-runtime.mjs';
import { smartVerticalFilter } from './ffmpeg-filter.mjs';

export async function previewFraming(context, candidate, decision, { run = runProcess, graphics = createClipGraphics } = {}) {
  const art = await graphics(candidate.hook, context.dir, `preview-${decision.cacheKey.slice(0, 12)}`);
  const path = join(context.dir, `preview-smart-framing-v${decision.version}-${decision.cacheKey.slice(0, 12)}.png`);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(candidate.start + Math.min(1, candidate.duration * 0.1)),
    '-i', context.metadata.source, '-loop', '1', '-i', art.hookPath, '-loop', '1', '-i', art.brandPath,
    '-filter_complex', smartVerticalFilter(decision, art.hookY, art.brandY, context.metadata.videoStreamIndex),
    '-map', '[v]', '-frames:v', '1', '-update', '1', path], { cwd: context.root, timeoutMs: 120_000,
    stderrPath: join(context.dir, 'framing-preview.stderr.txt') });
  return path;
}
