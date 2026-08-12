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
  return runGate(policyNames, seasonsPerArm, ruleId, { rules: [ruleId] })
}

/**
 * The VOTED regime, paired against the same baseline seeds: rules on, drawn
 * and voted daily. This is the regime a real season can actually produce —
 * forced-daily is the stress envelope above it — and both arms share the
 * season's main rng stream, so the difference is the rules alone.
 */
export function runVoteGate(policyNames: string[], seasonsPerArm: number): GateResult {
  return runGate(policyNames, seasonsPerArm, "voted", { voteRules: true })
}

function runGate(
  policyNames: string[],
  seasonsPerArm: number,
  label: string,
  arm: { rules?: string[]; voteRules?: boolean },
): GateResult {
  const seats = seatsFor(policyNames)
  const policyOf = new Map(seats.map((s) => [s.id, s.policy]))
  const policies = [...new Set(policyNames)]
  const diffs = new Map(policies.map((p) => [p, [] as number[]]))
  const baseWins = new Map(policies.map((p) => [p, 0]))
  const forcedWins = new Map(policies.map((p) => [p, 0]))

  for (let seed = 1; seed <= seasonsPerArm; seed++) {
    const base = runSeason(policyNames, seed)
    const forced = runSeason(policyNames, seed, arm)
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
    ruleId: label,
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

  const arms = [
    ...RULE_CATALOGUE.map((r) => ({
      label: `${r.id} forced daily`,
      run: () => runRuleGate(ROSTER, seasons, r.id),
    })),
    { label: "the VOTED regime (drawn and voted daily)", run: () => runVoteGate(ROSTER, seasons) },
  ]

  for (const arm of arms) {
    const out = arm.run()
    console.log(`=== ${arm.label} vs baseline ===`)
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
}
