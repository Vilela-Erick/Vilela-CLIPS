import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, runProcess } from './pipeline-runtime.mjs';

export function findCodex() {
  if (process.env.CODEX_CLI_PATH) {
    if (!existsSync(process.env.CODEX_CLI_PATH)) throw new Error(`CODEX_CLI_PATH no existe: ${process.env.CODEX_CLI_PATH}`);
    return process.env.CODEX_CLI_PATH;
  }
  const candidates = process.platform === 'win32'
    ? [join(process.env.LOCALAPPDATA || '', 'Programs', 'codex', 'codex.exe')]
    : ['/usr/local/bin/codex', '/usr/bin/codex'];
  if (process.platform === 'win32') {
    for (const extensionRoot of [join(homedir(), '.vscode', 'extensions'), join(homedir(), '.vscode-insiders', 'extensions')]) {
      if (!existsSync(extensionRoot)) continue;
      for (const name of readdirSync(extensionRoot).filter((item) => item.startsWith('openai.chatgpt-')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
        candidates.push(join(extensionRoot, name, 'bin', 'windows-x86_64', 'codex.exe'));
      }
    }
  }
  const found = candidates.find(existsSync);
  if (!found) throw new Error('No encuentro Codex CLI. Define CODEX_CLI_PATH con la ruta completa.');
  return found;
}

// --ignore-user-config conserva la autenticación en CODEX_HOME, pero omite el modelo
// configurado allí. Lo pasamos explícitamente para mantener la elección del usuario.
export function configuredCodexModel(configHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  const configPath = join(configHome, 'config.toml');
  if (!existsSync(configPath)) return null;
  const topLevel = readFileSync(configPath, 'utf8').split(/^\s*\[/m, 1)[0];
  const assignment = topLevel.match(/^\s*model\s*=\s*(.+?)\s*(?:#.*)?$/m);
  if (!assignment) return null;
  const value = assignment[1].trim();
  const model = value.match(/^['"]([A-Za-z0-9._:-]+)['"]$/)?.[1];
  if (!model) throw new Error(`No se pudo conservar el modelo de ${configPath}; revisa la línea model.`);
  return model;
}

export function codexExecArgs(context, responsePath, schema, model = configuredCodexModel()) {
  return ['exec', '--ephemeral', '--ignore-user-config', '--disable', 'plugins', '--disable', 'remote_plugin',
    '--disable', 'apps', '--sandbox', 'read-only', '--skip-git-repo-check',
    ...(model ? ['--model', model] : []), '-C', context.root,
    ...(schema ? ['--output-schema', join(context.root, 'scripts', schema)] : []),
    '--output-last-message', responsePath, '-'];
}

export async function callCodex(context, prompt, schema, name, { run = runProcess, timeoutMs = 10 * 60_000 } = {}) {
  const responsePath = join(context.dir, `${name}-response.${schema ? 'json' : 'txt'}`);
  const logPath = join(context.dir, `${name}.stderr.txt`);
  const result = await run(findCodex(), codexExecArgs(context, responsePath, schema),
    { cwd: context.root, input: prompt, timeoutMs, stderrPath: logPath,
      abortOnStderr: /invalid peer certificate: UnknownIssuer|certificate verify failed|self-signed certificate/i });
  const response = schema ? readJson(responsePath) : (existsSync(responsePath) ? readFileSync(responsePath, 'utf8').trim() : null);
  if (!response) throw new Error(`Codex no devolvió ${schema ? 'JSON' : 'texto'} para ${name}; revisa ${logPath}.`);
  return { response, elapsedSeconds: result.elapsedSeconds };
}
