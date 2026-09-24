import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { childEnv } from '../src/claude/env.ts';
import { PROJECT_ROOT, resolveClaudeCredentials, type ClaudeCredentials } from '../src/config.ts';

const fileVars = (entries: Record<string, { value: string; file: string }>) => new Map(Object.entries(entries));

const NO_CREDS: ClaudeCredentials = {
  apiKey: { value: '', source: '' },
  oauthToken: { value: '', source: '' },
  authToken: { value: '', source: '' },
  baseUrl: { value: '', source: '' },
};

test('resolveClaudeCredentials ignores inherited ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN without opt-in', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-parent', CLAUDE_CODE_OAUTH_TOKEN: 'tok-parent', ANTHROPIC_AUTH_TOKEN: 'at-parent' };
  const c = resolveClaudeCredentials(env, new Map(), {});
  assert.equal(c.apiKey.value, '');
  assert.equal(c.oauthToken.value, '');
  assert.equal(c.authToken.value, ''); // plain ANTHROPIC_AUTH_TOKEN is never read
  assert.equal(c.baseUrl.value, '');

  const inherited = resolveClaudeCredentials(env, new Map(), { inherit: true });
  assert.equal(inherited.apiKey.value, 'sk-parent');
  assert.match(inherited.apiKey.source, /inherited/);
  assert.equal(inherited.oauthToken.value, 'tok-parent');
  assert.match(inherited.oauthToken.source, /JEV_OPUS_INHERIT_CREDENTIALS/);
});

test('resolveClaudeCredentials uses plain names written in a jev-opus .env file, even over an inherited value', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-parent' };
  const files = fileVars({ ANTHROPIC_API_KEY: { value: 'sk-file', file: '/cfg/.env' } });
  const c = resolveClaudeCredentials(env, files, {});
  assert.equal(c.apiKey.value, 'sk-file');
  assert.equal(c.apiKey.source, '/cfg/.env');

  const filesOauth = fileVars({ CLAUDE_CODE_OAUTH_TOKEN: { value: 'tok-file', file: '/cfg/.env' } });
  const c2 = resolveClaudeCredentials({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-parent' }, filesOauth, {});
  assert.equal(c2.oauthToken.value, 'tok-file');
});

test('resolveClaudeCredentials: an empty value in a .env file does not count as configured', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-parent' };
  const files = fileVars({ ANTHROPIC_API_KEY: { value: '', file: '/cfg/.env' } });
  assert.equal(resolveClaudeCredentials(env, files, {}).apiKey.value, '');
  assert.equal(resolveClaudeCredentials(env, files, { inherit: true }).apiKey.value, 'sk-parent');
});

test('resolveClaudeCredentials: JEV_OPUS_* names win over file and inherited values', () => {
  const env = { JEV_OPUS_ANTHROPIC_API_KEY: 'sk-jev', ANTHROPIC_API_KEY: 'sk-parent' };
  const files = fileVars({ ANTHROPIC_API_KEY: { value: 'sk-file', file: '/cfg/.env' } });
  const c = resolveClaudeCredentials(env, files, { inherit: true });
  assert.equal(c.apiKey.value, 'sk-jev');
  assert.equal(c.apiKey.source, 'JEV_OPUS_ANTHROPIC_API_KEY');

  const c2 = resolveClaudeCredentials({ JEV_OPUS_CLAUDE_OAUTH_TOKEN: 'tok-jev' }, new Map(), {});
  assert.equal(c2.oauthToken.value, 'tok-jev');
  const c3 = resolveClaudeCredentials({ JEV_OPUS_ANTHROPIC_AUTH_TOKEN: 'at-jev', JEV_OPUS_ANTHROPIC_BASE_URL: 'https://gw' }, new Map(), {});
  assert.equal(c3.authToken.value, 'at-jev');
  assert.equal(c3.baseUrl.value, 'https://gw');
});

test('childEnv strips parent Anthropic variables and adds no credential without config', () => {
  const { env, credential } = childEnv(
    {
      ANTHROPIC_API_KEY: 'sk-parent',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok-parent',
      ANTHROPIC_AUTH_TOKEN: 'at-parent',
      ANTHROPIC_BASE_URL: 'https://parent',
      CLAUDE_CODE_EFFORT_LEVEL: 'low',
      MCP_SOME: 'x',
      OTEL_Y: 'y',
      CLAUDE_CONFIG_DIR: '/keep-me',
      PATH: '/bin',
    },
    { credentials: NO_CREDS },
  );
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  assert.equal(env.MCP_SOME, undefined);
  assert.equal(env.OTEL_Y, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/keep-me');
  assert.equal(env.PATH, '/bin');
  assert.match(credential, /claude login/);
});

test('childEnv sets the resolved credential and labels its source', () => {
  const { env, credential } = childEnv({}, {
    credentials: { ...NO_CREDS, apiKey: { value: 'sk-file', source: '/cfg/.env' } },
  });
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-file');
  assert.equal(credential, 'ANTHROPIC_API_KEY from /cfg/.env');

  const oauth = childEnv({}, {
    credentials: { ...NO_CREDS, oauthToken: { value: 'tok', source: 'JEV_OPUS_CLAUDE_OAUTH_TOKEN' } },
  });
  assert.equal(oauth.env.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
  assert.equal(oauth.credential, 'CLAUDE_CODE_OAUTH_TOKEN from JEV_OPUS_CLAUDE_OAUTH_TOKEN');

  const auth = childEnv({}, {
    credentials: { ...NO_CREDS, authToken: { value: 'at', source: 'JEV_OPUS_ANTHROPIC_AUTH_TOKEN' }, baseUrl: { value: 'https://gw', source: 'JEV_OPUS_ANTHROPIC_BASE_URL' } },
  });
  assert.equal(auth.env.ANTHROPIC_AUTH_TOKEN, 'at');
  assert.equal(auth.env.ANTHROPIC_BASE_URL, 'https://gw');
  assert.equal(auth.credential, 'ANTHROPIC_AUTH_TOKEN from JEV_OPUS_ANTHROPIC_AUTH_TOKEN');

  const inherited = childEnv({}, {
    credentials: { ...NO_CREDS, apiKey: { value: 'sk-p', source: 'inherited environment (JEV_OPUS_INHERIT_CREDENTIALS=1)' } },
  });
  assert.match(inherited.credential, /inherited environment/);
});

// The finding-#8 reproduction end to end: a parent-session ANTHROPIC_API_KEY in
// the environment must not reach the child unless explicitly opted in.
test('e2e: an inherited ANTHROPIC_API_KEY is not passed to the child unless opted in', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'jev-opus-env-'));
  const envTs = pathToFileURL(path.join(PROJECT_ROOT, 'src', 'claude', 'env.ts')).href;
  const code =
    `const { childEnv } = await import(${JSON.stringify(envTs)});` +
    `const r = childEnv();` +
    `console.log(JSON.stringify({ key: r.env.ANTHROPIC_API_KEY ?? null, oauth: r.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, cred: r.credential }));`;
  const run = (extra: Record<string, string>) =>
    JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', code], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: os.homedir(),
          JEV_OPUS_CONFIG_DIR: tmp,
          ANTHROPIC_API_KEY: 'sk-synthetic-parent',
          CLAUDE_CODE_OAUTH_TOKEN: 'tok-synthetic-parent',
          ...extra,
        },
      }),
    ) as { key: string | null; oauth: string | null; cred: string };

  const plain = run({});
  assert.equal(plain.key, null);
  assert.equal(plain.oauth, null);
  assert.match(plain.cred, /claude login/);

  const optIn = run({ JEV_OPUS_INHERIT_CREDENTIALS: '1' });
  assert.equal(optIn.key, 'sk-synthetic-parent');
  assert.match(optIn.cred, /inherited/);

  // A credential written in the jev-opus config file wins over the inherited one.
  writeFileSync(path.join(tmp, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=tok-file\n');
  const fromFile = run({});
  assert.equal(fromFile.key, null);
  assert.equal(fromFile.oauth, 'tok-file');
  assert.match(fromFile.cred, new RegExp(`CLAUDE_CODE_OAUTH_TOKEN from .*${path.basename(tmp)}`));

  writeFileSync(path.join(tmp, '.env'), 'ANTHROPIC_API_KEY=sk-file\n');
  const fileKey = run({});
  assert.equal(fileKey.key, 'sk-file');
  assert.match(fileKey.cred, /ANTHROPIC_API_KEY from .*\.env/);
});
