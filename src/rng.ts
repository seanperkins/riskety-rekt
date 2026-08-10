/** A deterministic PRNG. Seeded, so seasons and boards replay exactly. */
export type Rng = () => number

/**
 * xorshift32 — deterministic for a seed, so seasons replay exactly.
 *
 * Two corrections, both measured rather than assumed:
 *
 * The middle shift is `>>>`, not `>>`. JS bitwise operators coerce to *signed*
 * int32, so once the state passes 2^31 a `>>` sign-extends and folds ones into
 * the high bits — a different map from xorshift32, with no reason to believe it
 * keeps the full period.
 *
 * And the generator is warmed up. From a small seed, xorshift32's first output
 * is nearly linear in it: seeds 1..200 produced first draws of 0.000063,
 * 0.000126, 0.000189 ... — 200 out of 200 in the bottom quarter. The simulator
 * seeds seasons sequentially, so every season's first decision was drawn from
 * the same sliver, and a seeded Fisher-Yates picked j = 0 for its first swap
 * regardless of seed. Discarding the first outputs costs nothing and the state
 * is fully mixed by then.
 */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0 || 1
  const step = (): number => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x1_0000_0000
  }
  for (let i = 0; i < 16; i++) step()
  return step
}

/**
 * Fisher-Yates, seeded. The engine holds no randomness by design, so the
 * shuffle happens here and the seed goes in `seasons.seed` — that is what makes
 * a deal reproducible after the fact.
 *
 * Lives beside `makeRng` rather than in `season-init` because the simulator
 * needs it too, and the simulator importing from a job is the same inversion
 * that moved `makeRng` out of the simulator in the first place.
 */
export function shuffle<T>(items: T[], rng: Rng): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const a = out[i]!
    const b = out[j]!
    out[i] = b
    out[j] = a
  }
  return out
}
