/**
 * Versioned Jev question sets. One batched Jev call per decision point:
 *  - TASK_QUESTIONS when a user prompt arrives
 *  - STEP_QUESTIONS after every tool batch inside that prompt
 */
export declare const TASK_TYPES: {
    readonly chat: 'Conversation, greetings, opinions, or a quick question answerable in a few sentences';
    readonly factual: 'Explaining a known fact, definition, command, or concept';
    readonly writing: 'Drafting, editing, translating, or summarizing prose, docs, or messages';
    readonly code_small: 'A small, well-specified code change: one function, a rename, a config tweak, a short script';
    readonly code_feature: 'Implementing a feature or module that spans several functions or files';
    readonly debugging: 'Diagnosing and fixing a bug, crash, failing test, or unexpected behavior';
    readonly refactor: 'Restructuring or migrating existing code without changing its behavior';
    readonly architecture: 'System design, architecture decisions, trade-off analysis, or planning a large change';
    readonly analysis: 'Research, data analysis, reviewing code or documents, or comparing options';
    readonly math_logic: 'Math, proofs, algorithm design, puzzles, or rigorous multi-step reasoning';
};
export type TaskType = keyof typeof TASK_TYPES;
export declare const PHASES: {
    readonly exploring: 'Gathering context: listing, reading, or searching files; nothing has gone wrong';
    readonly implementing: 'Writing new code or content, or substantially changing existing code';
    readonly diagnosing: 'Investigating an error, a failing test, or a result that contradicts expectations';
    readonly verifying: 'Running tests, builds, or checks after a change, expecting them to pass';
    readonly finishing: 'The work looks done; only a short summary or final answer remains';
};
export type Phase = keyof typeof PHASES;
export declare const DIFFICULTY_LABELS: readonly ['Trivial: can be answered or done instantly', 'Easy: routine for a competent engineer', 'Moderate: needs some care and a few steps', 'Hard: subtle, multi-step, easy to get wrong', 'Extreme: research-grade or deeply intricate'];
export declare const TASK_SET_VERSION = "task.v2";
export declare const TASK_QUESTIONS: {
    task_type: {
        type: "choice";
        instructions: string;
        criteria: {
            readonly chat: 'Conversation, greetings, opinions, or a quick question answerable in a few sentences';
            readonly factual: 'Explaining a known fact, definition, command, or concept';
            readonly writing: 'Drafting, editing, translating, or summarizing prose, docs, or messages';
            readonly code_small: 'A small, well-specified code change: one function, a rename, a config tweak, a short script';
            readonly code_feature: 'Implementing a feature or module that spans several functions or files';
            readonly debugging: 'Diagnosing and fixing a bug, crash, failing test, or unexpected behavior';
            readonly refactor: 'Restructuring or migrating existing code without changing its behavior';
            readonly architecture: 'System design, architecture decisions, trade-off analysis, or planning a large change';
            readonly analysis: 'Research, data analysis, reviewing code or documents, or comparing options';
            readonly math_logic: 'Math, proofs, algorithm design, puzzles, or rigorous multi-step reasoning';
        };
    };
    difficulty: {
        type: "score";
        instructions: string;
        criteria: readonly ["Trivial: can be answered or done instantly", "Easy: routine for a competent engineer", "Moderate: needs some care and a few steps", "Hard: subtle, multi-step, easy to get wrong", "Extreme: research-grade or deeply intricate"];
    };
    stakes: {
        type: "noul";
        instructions: string;
    };
};
export declare const STEP_SET_VERSION = "step.v2";
export declare const STEP_QUESTIONS: {
    phase: {
        type: "choice";
        instructions: string;
        criteria: {
            readonly exploring: 'Gathering context: listing, reading, or searching files; nothing has gone wrong';
            readonly implementing: 'Writing new code or content, or substantially changing existing code';
            readonly diagnosing: 'Investigating an error, a failing test, or a result that contradicts expectations';
            readonly verifying: 'Running tests, builds, or checks after a change, expecting them to pass';
            readonly finishing: 'The work looks done; only a short summary or final answer remains';
        };
    };
    step_difficulty: {
        type: "score";
        instructions: string;
        criteria: readonly ["Trivial: can be answered or done instantly", "Easy: routine for a competent engineer", "Moderate: needs some care and a few steps", "Hard: subtle, multi-step, easy to get wrong", "Extreme: research-grade or deeply intricate"];
    };
    stuck: {
        type: "noul";
        instructions: string;
    };
};
