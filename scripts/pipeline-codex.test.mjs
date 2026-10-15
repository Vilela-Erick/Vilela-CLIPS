import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callCodex, codexExecArgs, configuredCodexModel } from './pipeline-codex.mjs';
import { runProcess } from './pipeline-runtime.mjs';

const temporary = (fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), 'primer-video-codex-test-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('el helper aísla configuración MCP, conserva modelo, Git, esquema y sandbox', temporary(async (dir) => {
  writeFileSync(join(dir, 'config.toml'), 'model = "gpt-6-sol"\n[mcp_servers.local]\nurl = "http://127.0.0.1:8000/mcp"\n');
  assert.equal(configuredCodexModel(dir), 'gpt-6-sol');
  const args = codexExecArgs({ root: dir }, join(dir, 'response.json'), 'clips-review.schema.json', configuredCodexModel(dir));
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.deepEqual(args.flatMap((arg, index) => arg === '--disable' ? [args[index + 1]] : []),
    ['plugins', 'remote_plugin', 'apps']);
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gpt-6-sol']);
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.deepEqual(args.slice(args.indexOf('--output-schema'), args.indexOf('--output-schema') + 2),
    ['--output-schema', join(dir, 'scripts', 'clips-review.schema.json')]);
  assert.equal(args[args.indexOf('-C') + 1], dir);
}));

test('el helper conserva process.env, credenciales y plazo al iniciar el hijo', temporary(async (dir) => {
  const previousHome = process.env.CODEX_HOME;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.CODEX_HOME = dir;
  process.env.OPENAI_API_KEY = 'test-credential-marker';
  try {
    const run = async (_bin, args, options) => {
      assert.equal(options.timeoutMs, 1234);
      assert.equal(options.cwd, dir);
      assert.equal(options.input, 'prueba');
      assert.equal(Object.hasOwn(options, 'env'), false);
      const responsePath = args[args.indexOf('--output-last-message') + 1];
      return runProcess(process.execPath, ['-e',
        'require("fs").writeFileSync(process.argv[1], JSON.stringify({home:process.env.CODEX_HOME,key:process.env.OPENAI_API_KEY}))', responsePath], options);
    };
    const result = await callCodex({ root: dir, dir }, 'prueba', null, 'env', { run, timeoutMs: 1234 });
    assert.deepEqual(JSON.parse(result.response), { home: dir, key: 'test-credential-marker' });
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
}));

test('el timeout del helper termina el proceso hijo', temporary(async (dir) => {
  const marker = join(dir, 'late.txt');
  const run = (_bin, _args, options) => runProcess(process.execPath, ['-e',
    `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'late'),500);setInterval(()=>{},1000)`], options);
  await assert.rejects(callCodex({ root: dir, dir }, 'prueba', null, 'timeout', { run, timeoutMs: 80 }), /superó/);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(existsSync(marker), false);
}));

test('Codex real responde OK sin MCP desde el mismo helper', { skip: process.env.CODEX_LIVE_SMOKE !== '1' }, temporary(async (dir) => {
  const result = await callCodex({ root: process.cwd(), dir }, 'Responde exactamente: OK', null, 'smoke', { timeoutMs: 120_000 });
  const stderr = readFileSync(join(dir, 'smoke.stderr.txt'), 'utf8');
  assert.equal(result.response, 'OK');
  assert.doesNotMatch(stderr, /MCP client|mcp server|127\.0\.0\.1:8000|failed to start.*mcp/i);
  console.log(JSON.stringify({ smoke: 'OK', mcpErrors: false, elapsedSeconds: result.elapsedSeconds }));
}));
