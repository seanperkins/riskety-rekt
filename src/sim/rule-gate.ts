/**
 * The bounded-swing gate (spec, "Replacing the reversibility test"): each rule
 * forced active EVERY day vs a no-rules baseline, same pinned seeds both arms
 * (common random numbers). Reject a rule moving any policy's win rate by more
 * than GATE_POINTS. The paired SE is EMPIRICAL — the sd of per-season
 * win-indicator differences — reported with a 95% CI, per the spec's
 * statistics correction. Forcing a rule daily is stress evidence, not proof:
 * for a nonlinear rule (compounding Boom days) daily activation explores a
 * different regime than scattered single days, so the gate is a strong screen.
 *
 *   npm run sim:rules            # 10,000 seasons per arm (~minutes)
 *   npm run sim:rules -- 200     # a smoke run
 */
import { RULE_CATALOGUE } from "../engine/rules/index.js"
import { runSeason, seatsFor } from "./run.js"

export const GATE_POINTS = 3

export interface GatePolicyRow {
  policy: string
  baselinePct: number
  forcedPct: number
  /** forced − baseline, percentage points. */
  diffPct: number
  /** Empirical paired SE: sd of per-season win-indicator diffs / √n, ×100. */
  pairedSePct: number
  ci95Pct: [number, number]
  pass: boolean
}

export interface GateResult {
  ruleId: string
  seasons: number
  perPolicy: GatePolicyRow[]
}

export function runRuleGate(
  policyNames: string[],
  seasonsPerArm: number,
  ruleId: string,
): GateResult {
  const seats = seatsFor(policyNames)
  const policyOf = new Map(seats.map((s) => [s.id, s.policy]))
  const policies = [...new Set(policyNames)]
  const diffs = new Map(policies.map((p) => [p, [] as number[]]))
  const baseWins = new Map(policies.map((p) => [p, 0]))
  const forcedWins = new Map(policies.map((p) => [p, 0]))

  for (let seed = 1; seed <= seasonsPerArm; seed++) {
    const base = runSeason(policyNames, seed)
    const forced = runSeason(policyNames, seed, { rules: [ruleId] })
    const bWin = policyOf.get(base.winner)
    const fWin = policyOf.get(forced.winner)
    for (const p of policies) {
      const b = bWin === p ? 1 : 0
      const f = fWin === p ? 1 : 0
      diffs.get(p)!.push(f - b)
      if (b === 1) baseWins.set(p, baseWins.get(p)! + 1)
      if (f === 1) forcedWins.set(p, forcedWins.get(p)! + 1)
    }
  }

  return {
    ruleId,
    seasons: seasonsPerArm,
    perPolicy: policies.map((p) => {
      const d = diffs.get(p)!
      const mean = d.reduce((a, x) => a + x, 0) / d.length
      const sd = Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / (d.length - 1))
      const se = (sd / Math.sqrt(d.length)) * 100
      const diffPct = mean * 100
      return {
        policy: p,
        baselinePct: (baseWins.get(p)! / seasonsPerArm) * 100,
        forcedPct: (forcedWins.get(p)! / seasonsPerArm) * 100,
        diffPct,
        pairedSePct: se,
        ci95Pct: [diffPct - 1.96 * se, diffPct + 1.96 * se] as [number, number],
        pass: Math.abs(diffPct) <= GATE_POINTS,
      }
    }),
  }
}

/** The vote-dynamics arm: rules on, uniform-random seat votes (abstain ½). */
export function runVoteDynamics(
  policyNames: string[],
  seasons: number,
): { wins: Record<string, number>; seasons: number } {
  const seats = seatsFor(policyNames)
  const policyOf = new Map(seats.map((s) => [s.id, s.policy]))
  const wins: Record<string, number> = {}
  for (let seed = 1; seed <= seasons; seed++) {
    const r = runSeason(policyNames, seed, { voteRules: true })
    const p = policyOf.get(r.winner)
    if (p !== undefined) wins[p] = (wins[p] ?? 0) + 1
  }
  return { wins, seasons }
}

const ROSTER = [
  "Turtle",
  "Blitz",
  "Consolidator",
  "Hunter",
  "Gambler",
  "Slacker",
  "GymRat",
  "Arbitrageur",
]

const isMain = process.argv[1]?.endsWith("rule-gate.ts") === true
if (isMain) {
  const seasons = Number(process.argv[2] ?? 10_000)
  console.log(`bounded-swing gate: ${seasons} seasons per arm, roster ${ROSTER.join(", ")}\n`)

  for (const rule of RULE_CATALOGUE) {
    const out = runRuleGate(ROSTER, seasons, rule.id)
    console.log(`=== ${rule.id} forced daily vs baseline ===`)
    console.log(
      "policy".padEnd(14) +
        "base%".padStart(8) +
        "forced%".padStart(9) +
        "diff".padStart(8) +
        "±CI95".padStart(9) +
        "  verdict",
    )
    for (const row of out.perPolicy) {
      console.log(
        row.policy.padEnd(14) +
          row.baselinePct.toFixed(2).padStart(8) +
          row.forcedPct.toFixed(2).padStart(9) +
          row.diffPct.toFixed(2).padStart(8) +
          (1.96 * row.pairedSePct).toFixed(2).padStart(9) +
          `  ${row.pass ? "PASS" : "FAIL"}`,
      )
    }
    console.log("")
  }

  const dyn = runVoteDynamics(ROSTER, seasons)
  console.log(`=== vote dynamics (random votes, abstain 1/2) — ${dyn.seasons} seasons ===`)
  for (const [p, w] of Object.entries(dyn.wins).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(14)} ${((w / dyn.seasons) * 100).toFixed(1).padStart(5)}%`)
  }
}
