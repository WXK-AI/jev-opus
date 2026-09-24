import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EffortDisplay, inlineEffortSettings } from '../src/gateway/display.ts';
import { withGatewaySettings } from '../src/gateway/settings.ts';
import type { EffortDecision } from '../src/router/types.ts';

const decision: EffortDecision = {
  kind: 'step', effort: 'high', previous: 'low', changed: true,
  reasons: ['diagnosing'], source: 'jev', jevLatencyMs: 1,
  signals: { phase: 'diagnosing', phaseConfidence: .9, stepDifficulty: 3, stuck: .1, source: 'jev' },
};
const message = (index = 0, delta = 'Investigating the test failure.\n') => ({
  hook_event_name: 'MessageDisplay', session_id: 's', message_id: 'm', turn_id: 't', index, delta, final: false,
});
const preTool = { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash' };

test('inline badges preserve streamed text and appear once per message', () => {
  const display = new EffortDisplay();
  display.record('s', 'main', decision);
  assert.deepEqual(display.handle(message()), {
    hookSpecificOutput: {
      hookEventName: 'MessageDisplay',
      displayContent: '> **◆ Jev · LOW → HIGH · diagnosing**\n\nInvestigating the test failure.\n',
    },
  });
  assert.deepEqual(display.handle(message(1, 'A later chunk.')), {});
  assert.deepEqual(display.handle({ ...message(2, ''), final: true }), {});
  assert.deepEqual(display.handle(preTool), {}, 'a text badge already announced this decision');
  assert.deepEqual(display.handle({ ...message(), message_id: 'm2' }), {
    hookSpecificOutput: {
      hookEventName: 'MessageDisplay',
      displayContent: '> **◆ Jev · HIGH · diagnosing**\n\nInvestigating the test failure.\n',
    },
  });
});

test('tool-only turns get one notice per decision, including parallel tools', () => {
  const display = new EffortDisplay();
  display.record('s', 'main', decision);
  assert.deepEqual(display.handle(preTool), { systemMessage: '◆ Jev · LOW → HIGH · diagnosing' });
  assert.deepEqual(display.handle(preTool), {});
  display.record('s', 'main', { ...decision, effort: 'medium', previous: 'high' });
  assert.deepEqual(display.handle(preTool), { systemMessage: '◆ Jev · HIGH → MEDIUM · diagnosing' });
});

test('badges are isolated by session and agent and cleared on model switches', () => {
  const display = new EffortDisplay();
  display.record('s', 'main', decision);
  assert.deepEqual(display.handle({ ...message(), session_id: 'other' }), {});
  assert.deepEqual(display.handle({ ...message(), agent_id: 'worker' }), {});
  display.record('s', 'worker', { ...decision, effort: 'low', previous: 'low' });
  assert.match(JSON.stringify(display.handle({ ...message(), agent_id: 'worker' })), /Jev · LOW · diagnosing/);
  display.clear('s', 'main');
  assert.deepEqual(display.handle(message()), {});
});

test('manual overrides are labelled and invalid events cannot add context or affect permissions', () => {
  const display = new EffortDisplay();
  display.record('s', 'main', { ...decision, source: 'pinned' });
  assert.deepEqual(display.handle(preTool), { systemMessage: '◆ Jev · LOW → HIGH · manual override' });
  for (const value of [null, [], {}, { ...message(), delta: null }, { ...message(), index: -1 }, { ...message(), agent_id: {} }, { ...message(), hook_event_name: 'PermissionRequest' }]) {
    assert.deepEqual(display.handle(value), {});
  }
});

test('UI settings preserve existing hooks, permissions, status line, and caller arguments', () => {
  const original = {
    permissions: { deny: ['Bash(rm *)'] },
    statusLine: { type: 'command', command: 'existing-status' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'existing-hook' }] }] },
  };
  const additions = { ...inlineEffortSettings('http://127.0.0.1:1/hooks'), statusLine: { type: 'command' as const, command: 'jev-status' } };
  for (const args of [['--settings', JSON.stringify(original), '-c'], [`--settings=${JSON.stringify(original)}`, '-c']]) {
    const result = withGatewaySettings(args, additions);
    const raw = result[0] === '--settings' ? result[1]! : result[0]!.slice('--settings='.length);
    const settings = JSON.parse(raw);
    assert.deepEqual(settings.permissions, original.permissions);
    assert.deepEqual(settings.statusLine, original.statusLine);
    assert.deepEqual(settings.hooks.PreToolUse[0], original.hooks.PreToolUse[0]);
    assert.equal(settings.hooks.PreToolUse.length, 2);
    assert.equal(settings.hooks.MessageDisplay[0].hooks[0].timeout, 1);
    assert.equal(result.at(-1), '-c');
  }
  assert.deepEqual(withGatewaySettings(['-c'], {}), ['-c'], 'opting out adds no settings');
  assert.equal(withGatewaySettings(['-c'], additions)[0], '--settings');
});

test('settings files are merged in memory without changing the original file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    const raw = '{"env":{"KEEP_ME":"yes"}}';
    fs.writeFileSync(file, raw);
    const args = withGatewaySettings(['--settings', file], inlineEffortSettings('http://localhost/hooks'));
    assert.equal(JSON.parse(args[1]!).env.KEEP_ME, 'yes');
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.throws(() => withGatewaySettings(['--settings'], inlineEffortSettings('http://localhost/hooks')), /needs a JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
