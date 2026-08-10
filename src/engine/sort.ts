/**
 * The engine's one string comparator.
 *
 * Determinism is the whole reason it exists: every faction and territory
 * iteration in the pipeline is sorted, so the same inputs produce the same
 * `log` in the same order, which is what the golden file pins. Four verbatim
 * copies of this used to sit in resolve, combat, irl and the simulator's
 * policies, plus two inlined `(a < b ? -1 : 1)` tiebreaks in the sim runner
 * that silently never returned 0 for equal keys.
 */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
