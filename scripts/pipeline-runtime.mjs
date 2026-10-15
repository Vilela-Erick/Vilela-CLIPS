import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(temp, path);
}

export async function hashFile(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function terminate(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
    if (child.exitCode === null) child.kill('SIGKILL');
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export async function runProcess(bin, args, { cwd, input, timeoutMs = 30 * 60_000, stderrPath, onProgress, abortOnStderr } = {}) {
  const started = performance.now();
  const child = spawn(bin, args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const stderrFile = stderrPath ? createWriteStream(stderrPath, { flags: 'w' }) : null;
  let stdout = '', stderrTail = '', progressBuffer = '';
  let timedOut = false, interrupted = false, spawnError = null, abortedReason = null;
  child.stdout.on('data', (data) => {
    const chunk = data.toString('utf8');
    stdout = (stdout + chunk).slice(-2_000_000);
    if (onProgress) {
      progressBuffer += chunk;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop();
      for (const line of lines) onProgress(line);
    }
  });
  child.stderr.on('data', (data) => {
    stderrTail = (stderrTail + data.toString('utf8')).slice(-16_000);
    stderrFile?.write(data);
    if (abortOnStderr && !abortedReason && abortOnStderr.test(stderrTail)) {
      abortedReason = 'fallo de certificado TLS en Codex; revisa el certificado raíz o la conexión de red';
      void terminate(child);
    }
  });
  child.once('error', (error) => { spawnError = error; });
  child.stdin.on('error', () => {});
  child.stdin.end(input ?? '');
  const onInterrupt = () => { interrupted = true; void terminate(child); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  const timer = setTimeout(() => { timedOut = true; void terminate(child); }, timeoutMs);
  const { code, signal } = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer);
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);
  if (stderrFile) await new Promise((resolve) => stderrFile.end(resolve));
  if (spawnError) throw new Error(`No se pudo iniciar ${bin}: ${spawnError.message}`);
  if (abortedReason) throw new Error(`${bin} detenido: ${abortedReason}. Registro: ${stderrPath ?? stderrTail}`);
  if (timedOut) throw new Error(`${bin} superó ${timeoutMs} ms; proceso terminado. Registro: ${stderrPath ?? stderrTail}`);
  if (interrupted) throw new Error(`${bin} interrumpido; proceso terminado.`);
  if (code !== 0) throw new Error(`${bin} falló (${code ?? signal}): ${stderrTail.slice(-3000)}${stderrPath ? `\nRegistro: ${stderrPath}` : ''}`);
  return { stdout, elapsedSeconds: +((performance.now() - started) / 1000).toFixed(2), stderrTail };
}
