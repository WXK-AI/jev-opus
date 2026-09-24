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
  assert.deepEqual(display.handle({ ...message(), message_id: 'm2' }), {}, 'unchanged level: no badge, the status line shows it');
  display.record('s', 'main', { ...decision, effort: 'medium', previous: 'high' });
  assert.deepEqual(display.handle({ ...message(), message_id: 'm3' }), {
    hookSpecificOutput: {
      hookEventName: 'MessageDisplay',
      displayContent: '> **◆ Jev · HIGH → MEDIUM · diagnosing**\n\nInvestigating the test failure.\n',
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
    assert.equal(settings.hooks.PreToolUse.length, 1, 'no tool-notice hook by default: only the caller\'s own');
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

test('a text badge shows every level since the previous badge', () => {
  const display = new EffortDisplay();
  const step = (effort: EffortDecision['effort'], previous: EffortDecision['effort']): EffortDecision => ({ ...decision, effort, previous, changed: effort !== previous });
  display.record('s', 'main', step('medium', 'low')); // task start, tool-only step
  display.record('s', 'main', step('high', 'medium')); // failure, tool-only step
  display.record('s', 'main', step('high', 'high')); // unchanged
  display.record('s', 'main', step('medium', 'high')); // tests pass
  assert.match(JSON.stringify(display.handle(message())), /Jev · LOW → MEDIUM → HIGH → MEDIUM · diagnosing/);
  assert.deepEqual(display.handle({ ...message(), message_id: 'm2' }), {}, 'no change since the last badge: no badge');
  display.record('s', 'main', { ...step('low', 'medium'), kind: 'task' }); // a new prompt, same session
  assert.match(JSON.stringify(display.handle({ ...message(), message_id: 'm3' })), /Jev · MEDIUM → LOW/, 'a new prompt announces its level');
  display.record('s', 'main', { ...step('low', 'low'), kind: 'task' });
  assert.match(JSON.stringify(display.handle({ ...message(), message_id: 'm4' })), /Jev · LOW · diagnosing/, 'even when unchanged, the first message of a prompt gets a badge');
});

test('tool notices are opt-in', () => {
  assert.deepEqual(Object.keys(inlineEffortSettings('http://x/h').hooks!), ['MessageDisplay']);
  assert.deepEqual(Object.keys(inlineEffortSettings('http://x/h', { toolNotices: true }).hooks!).sort(), ['MessageDisplay', 'PreToolUse']);
});

test('narration: one short line before each tool call, merged with a caller prompt', async () => {
  const { withNarration, NARRATION_PROMPT } = await import('../src/gateway/settings.ts');
  assert.deepEqual(withNarration(['-c']), ['--append-system-prompt', NARRATION_PROMPT, '-c']);
  assert.deepEqual(withNarration(['--append-system-prompt', 'Be terse.']), ['--append-system-prompt', `Be terse.\n\n${NARRATION_PROMPT}`]);
  assert.deepEqual(withNarration(['--append-system-prompt=Be terse.']), [`--append-system-prompt=Be terse.\n\n${NARRATION_PROMPT}`]);
  assert.deepEqual(withNarration(['--', '--append-system-prompt', 'x']), ['--append-system-prompt', NARRATION_PROMPT, '--', '--append-system-prompt', 'x'], 'arguments after -- are not flags');
});

test('status line shows the current prompt\'s whole effort path, newest level in capitals', async () => {
  const { formatStatusLine } = await import('../src/gateway/launch.ts');
  assert.equal(formatStatusLine({ effort: 'medium', previous: 'high', trail: ['medium', 'high', 'medium'], phase: 'verifying', source: 'jev' }), '◆ Jev · medium → high → MEDIUM · verifying');
  assert.equal(formatStatusLine({ effort: 'high', previous: 'medium', phase: 'diagnosing', source: 'local' }), '◆ Jev · medium → HIGH · diagnosing', 'older status files without a trail');
  assert.equal(formatStatusLine({ effort: 'low', previous: null, trail: ['low', 'medium', 'high', 'medium', 'high', 'medium', 'low'], phase: 'finishing', source: 'heuristic' }), '◆ Jev · … → high → medium → high → medium → LOW · finishing · local routing');
});

test('gateway status file carries the path of the current prompt and resets on a new prompt', async () => {
  const { JevGateway, readStatus } = await import('../src/gateway/server.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-status-'));
  try {
    const gw = new JevGateway({ jev: null, bounds: { min: 'low', max: 'high' }, statusDir: dir });
    const write = (d: EffortDecision) => (gw as unknown as { writeStatus(s: string, a: string, d: EffortDecision): void }).writeStatus('sess1', 'main', d);
    write({ ...decision, kind: 'task', effort: 'medium', previous: null });
    write({ ...decision, effort: 'high', previous: 'medium' });
    write({ ...decision, effort: 'high', previous: 'high' });
    write({ ...decision, effort: 'medium', previous: 'high' });
    assert.deepEqual(readStatus(dir, 'sess1')!.trail, ['medium', 'high', 'medium']);
    write({ ...decision, kind: 'task', effort: 'low', previous: 'medium' });
    assert.deepEqual(readStatus(dir, 'sess1')!.trail, ['medium', 'low'], 'a new prompt starts from the level in force');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
