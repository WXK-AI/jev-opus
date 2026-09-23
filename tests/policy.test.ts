import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyHysteresis, stepTarget, taskEffort, type Bounds } from '../src/router/policy.ts';
import type { StepSignals, TaskProfile } from '../src/router/types.ts';

const ALL: Bounds = { min: 'low', max: 'max' };
const UP_TO_HIGH: Bounds = { min: 'low', max: 'high' };

const profile = (p: Partial<TaskProfile>): TaskProfile => ({
  taskType: 'code_small', typeConfidence: 0.8, difficulty: 1.5, stakes: 0.1, source: 'jev', ...p,
});
const signals = (s: Partial<StepSignals>): StepSignals => ({
  phase: 'implementing', phaseConfidence: 0.8, stepDifficulty: 1.5, stuck: 0.1, source: 'jev', ...s,
});

test('task: difficulty maps low → medium → high → xhigh', () => {
  assert.equal(taskEffort(profile({ taskType: 'analysis', difficulty: 0.5 }), ALL).effort, 'low');
  assert.equal(taskEffort(profile({ taskType: 'analysis', difficulty: 1.8 }), ALL).effort, 'medium');
  assert.equal(taskEffort(profile({ taskType: 'analysis', difficulty: 2.7 }), ALL).effort, 'high');
  assert.equal(taskEffort(profile({ taskType: 'analysis', difficulty: 3.4 }), ALL).effort, 'xhigh');
});

test('task: chat is capped at medium, debugging floored at medium', () => {
  assert.equal(taskEffort(profile({ taskType: 'chat', difficulty: 3.5 }), ALL).effort, 'medium');
  assert.equal(taskEffort(profile({ taskType: 'debugging', difficulty: 0.9 }), ALL).effort, 'medium');
});

test('task: floors do not lift genuinely trivial asks', () => {
  assert.equal(taskEffort(profile({ taskType: 'math_logic', difficulty: 0 }), ALL).effort, 'low');
});

test('task: low type confidence skips caps and floors', () => {
  assert.equal(taskEffort(profile({ taskType: 'chat', typeConfidence: 0.1, difficulty: 2.7 }), ALL).effort, 'high');
});

test('task: high stakes bumps to at least high; max only for extreme critical work', () => {
  assert.equal(taskEffort(profile({ taskType: 'refactor', difficulty: 1.6, stakes: 0.9 }), ALL).effort, 'high');
  assert.equal(taskEffort(profile({ taskType: 'architecture', difficulty: 3.8, stakes: 0.2 }), ALL).effort, 'max');
  assert.equal(taskEffort(profile({ taskType: 'code_feature', difficulty: 3.8, stakes: 0.2 }), ALL).effort, 'xhigh');
});

test('task: bounds clamp xhigh/max down to high', () => {
  assert.equal(taskEffort(profile({ taskType: 'architecture', difficulty: 3.9, stakes: 0.95 }), UP_TO_HIGH).effort, 'high');
  assert.equal(taskEffort(profile({ taskType: 'analysis', difficulty: 3.4 }), UP_TO_HIGH).effort, 'high');
});

test('step: exploring/verifying drop a level, diagnosing raises one', () => {
  assert.equal(stepTarget('high', signals({ phase: 'exploring' }), 0, ALL).effort, 'medium');
  assert.equal(stepTarget('high', signals({ phase: 'verifying' }), 0, ALL).effort, 'medium');
  assert.equal(stepTarget('medium', signals({ phase: 'diagnosing' }), 1, ALL).effort, 'high');
  assert.equal(stepTarget('medium', signals({ phase: 'implementing' }), 0, ALL).effort, 'medium');
});

test('step: finishing caps at medium, trivial steps go low', () => {
  assert.equal(stepTarget('xhigh', signals({ phase: 'finishing', stepDifficulty: 1 }), 0, ALL).effort, 'medium');
  assert.equal(stepTarget('medium', signals({ phase: 'exploring', stepDifficulty: 0.4 }), 0, ALL).effort, 'low');
});

test('step: a hard next step lifts to high even while exploring', () => {
  assert.equal(stepTarget('medium', signals({ phase: 'exploring', stepDifficulty: 3.6 }), 0, ALL).effort, 'high');
});

test('step: failures outside diagnosing still add a level', () => {
  assert.equal(stepTarget('medium', signals({ phase: 'implementing' }), 1, ALL).effort, 'high');
});

test('step: stuck escalates by two, max only after repeated failure', () => {
  assert.equal(stepTarget('low', signals({ phase: 'diagnosing', stuck: 0.8 }), 1, ALL).effort, 'high');
  assert.equal(stepTarget('medium', signals({ phase: 'diagnosing', stuck: 0.8 }), 2, ALL).effort, 'xhigh');
  assert.equal(stepTarget('high', signals({ phase: 'diagnosing', stuck: 0.95 }), 4, ALL).effort, 'max');
  assert.equal(stepTarget('high', signals({ phase: 'diagnosing', stuck: 0.95 }), 4, UP_TO_HIGH).effort, 'high');
});

test('step: never more than two levels under the task level', () => {
  assert.equal(stepTarget('xhigh', signals({ phase: 'exploring', stepDifficulty: 0.2 }), 0, ALL).effort, 'medium');
});

test('step: low phase confidence keeps the task level', () => {
  assert.equal(stepTarget('high', signals({ phase: 'exploring', phaseConfidence: 0.1 }), 0, ALL).effort, 'high');
});

test('hysteresis: raise now, hold one step, then step down one level at a time', () => {
  let h = applyHysteresis('low', 'high', 0, false);
  assert.deepEqual([h.effort, h.hold], ['high', 1]);
  h = applyHysteresis('high', 'low', h.hold, false);
  assert.deepEqual([h.effort, h.hold], ['high', 0]);
  h = applyHysteresis('high', 'low', h.hold, false);
  assert.equal(h.effort, 'medium');
  h = applyHysteresis('medium', 'low', h.hold, false);
  assert.equal(h.effort, 'low');
});

test('hysteresis: finishing drops straight to target even during a hold', () => {
  assert.equal(applyHysteresis('high', 'low', 1, true).effort, 'low');
});
