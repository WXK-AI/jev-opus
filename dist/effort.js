/** Ordered weakest → strongest. Index is the effort's rank. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export function isEffort(value) {
    return typeof value === 'string' && EFFORT_LEVELS.includes(value);
}
export function rank(effort) {
    return EFFORT_LEVELS.indexOf(effort);
}
export function fromRank(r) {
    const i = Math.min(EFFORT_LEVELS.length - 1, Math.max(0, Math.round(r)));
    return EFFORT_LEVELS[i];
}
export function shift(effort, delta) {
    return fromRank(rank(effort) + delta);
}
export function clampEffort(effort, min, max) {
    return fromRank(Math.min(rank(max), Math.max(rank(min), rank(effort))));
}
export function maxEffort(a, b) {
    return rank(a) >= rank(b) ? a : b;
}
export function minEffort(a, b) {
    return rank(a) <= rank(b) ? a : b;
}
