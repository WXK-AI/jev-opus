import type { Phase, TaskType } from './questions.ts';
import type { StepContext, TaskProfile, StepSignals } from './types.ts';

/**
 * Deterministic fallbacks used when Jev is disabled or unreachable, and the
 * hard signals (tool failures) that are blended into every Jev decision.
 */

const TYPE_PATTERNS: Array<[TaskType, RegExp]> = [
  ['debugging', /\b(bug|fix|broken|crash|error|exception|stack ?trace|fail(s|ing|ed)?|regression|doesn'?t work|not working)\b/i],
  ['architecture', /\b(architect(ure)?|system design|design (a|the) system|trade-?offs?|scalab|microservice|roadmap|migration plan)\b/i],
  ['math_logic', /\b(prove|proof|theorem|lemma|complexity|big-?o|algorithm|dynamic programming|puzzle|equation|integral)\b/i],
  ['refactor', /\b(refactor|restructure|clean ?up|migrate|rename|extract (a |the )?(function|module|class))\b/i],
  ['analysis', /\b(review|analy[sz]e|compare|research|investigate|audit|evaluate|benchmark)\b/i],
  ['code_feature', /\b(implement|build|create|add (a |an )?(feature|endpoint|module|page|command)|scaffold|integrate)\b/i],
  ['writing', /\b(write|draft|rewrite|summari[sz]e|translate|email|essay|blog|readme|docs?|documentation)\b/i],
  ['code_small', /\b(function|script|regex|one-?liner|snippet|config|typo|tweak)\b/i],
  ['factual', /^(what|who|when|where|which|how (do|does|can|to)|explain|define)\b/i],
];

const HARD_WORDS = /\b(concurren|race condition|deadlock|distributed|consensus|security|crypto|memory leak|performance|optimi[sz]e|compiler|parser|kernel|lock-?free|numerical|edge cases?|production)\b/gi;
const STAKES_WORDS = /\b(production|prod\b|database|migration|delete|drop table|payment|billing|auth(entication|orization)?|security|secret|credential|deploy|rm -rf|irreversible|customer data)\b/gi;

export function heuristicTaskProfile(prompt: string): TaskProfile {
  const text = prompt.trim();
  let taskType: TaskType = text.length < 60 ? 'chat' : 'code_small';
  for (const [type, re] of TYPE_PATTERNS) {
    if (re.test(text)) { taskType = type; break; }
  }
  const hard = text.match(HARD_WORDS)?.length ?? 0;
  const stakesHits = text.match(STAKES_WORDS)?.length ?? 0;
  const lengthScore = Math.min(1.5, text.length / 800);
  const typeBase: Record<TaskType, number> = {
    chat: 0.3, factual: 0.6, writing: 1.2, code_small: 1.3, code_feature: 2.2,
    debugging: 2.2, refactor: 2.0, architecture: 2.8, analysis: 2.0, math_logic: 2.6,
  };
  const difficulty = Math.min(4, typeBase[taskType] + lengthScore + 0.5 * hard);
  return {
    taskType,
    typeConfidence: 0.5,
    difficulty,
    stakes: Math.min(1, 0.15 + 0.3 * stakesHits),
    source: 'heuristic',
  };
}

const READ_ONLY_TOOLS = /^(Read|Glob|Grep|LS|WebFetch|WebSearch|TodoWrite|NotebookRead|ToolSearch|Skill)$/;
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const VERIFY_CMD = /\b(test|jest|vitest|pytest|mocha|cargo (test|check|build)|go (test|build|vet)|tsc|lint|eslint|build|typecheck|make( |$)|npm run|pnpm|yarn)\b/i;

export function heuristicStepSignals(ctx: StepContext): StepSignals {
  const calls = ctx.lastBatch;
  const failed = calls.filter((c) => c.failed).length;
  let phase: Phase = 'exploring';
  if (calls.length === 0) phase = 'finishing';
  else if (failed > 0) phase = 'diagnosing';
  else if (calls.some((c) => WRITE_TOOLS.test(c.tool))) phase = 'implementing';
  else if (calls.some((c) => c.tool === 'Bash' && VERIFY_CMD.test(c.summary))) phase = 'verifying';
  else if (calls.every((c) => READ_ONLY_TOOLS.test(c.tool))) phase = 'exploring';

  const stepDifficulty =
    phase === 'diagnosing' ? Math.min(4, 2.2 + 0.5 * ctx.consecutiveFailures)
      : phase === 'implementing' ? Math.max(1.5, ctx.profile.difficulty)
        : phase === 'verifying' ? 1.0
          : phase === 'finishing' ? 0.8
            : 1.0;
  return {
    phase,
    phaseConfidence: 0.5,
    stepDifficulty,
    stuck: ctx.consecutiveFailures >= 3 ? 0.8 : ctx.consecutiveFailures === 2 ? 0.5 : 0.1,
    source: 'heuristic',
  };
}
