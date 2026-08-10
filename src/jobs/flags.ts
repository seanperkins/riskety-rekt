/**
 * Long-flag parsing for the CLI, in its own module because `cli.ts` is a script
 * — top-level await and a `process.exit` — so nothing can import it to test it.
 */

/**
 * An operator mistake, as opposed to a system failure. `cli.ts` prints these as
 * one line; everything else gets a stack trace. It lives here rather than in
 * `cli.ts` so `parseFlags` can raise it — a typo'd flag is the most likely
 * operator mistake there is, and it was printing a five-frame stack.
 */
export class UsageError extends Error {}

/**
 * Parse `--name value` pairs. Unknown flags and bare positionals are errors
 * rather than silently ignored: a typo'd `--sed 4711` that parsed as "no seed"
 * would deal a different board than the operator asked for and say nothing.
 */
export function parseFlags(argv: string[], allowed: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!
    if (!flag.startsWith("--")) throw new UsageError(`unexpected argument: ${flag}`)
    const name = flag.slice(2)
    if (!allowed.includes(name)) {
      throw new UsageError(
        `unknown flag: ${flag} (expected ${allowed.map((a) => `--${a}`).join(", ")})`,
      )
    }
    const value = argv[i + 1]
    if (value === undefined) throw new UsageError(`${flag} needs a value`)
    if (name in out) throw new UsageError(`${flag} given twice`)
    out[name] = value
  }
  return out
}

/**
 * A stable seed for a start date, used when the operator gives none.
 *
 * Deterministic on purpose. A clock-derived default would make the deal
 * unreproducible from the recorded arguments, which is the whole reason the
 * seed is stored at all — and the operator would have no way to re-derive the
 * board from `season-init 2026-09-01` alone.
 *
 * FNV-1a, then masked to 31 bits so it stays a safe positive integer.
 */
export function seedFromDate(date: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < date.length; i++) {
    h ^= date.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) & 0x7fffffff
}
