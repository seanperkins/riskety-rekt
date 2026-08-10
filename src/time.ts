import { TIMEZONE } from "./config.js"

const DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

const OFFSET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  timeZoneName: "longOffset",
})

/** The America/New_York calendar date of an instant, as "YYYY-MM-DD". */
export function etDate(at: Date): string {
  return DATE_FMT.format(at)
}

/** UTC offset of America/New_York at an instant, in minutes (-240 in EDT). */
function offsetMinutes(at: Date): number {
  const name = OFFSET_FMT.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT"
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name)
  if (!m) return 0 // bare "GMT" means a zero offset
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

/**
 * The instant at which the clock in America/New_York reads `hour:minute` on the
 * given ET calendar date.
 *
 * Two passes: the offset itself depends on the instant we are solving for, so
 * the first pass uses the offset at the naive UTC guess and the second corrects
 * it. Only a date whose offset changes between the guess and the answer needs
 * the second pass, but it always converges because ET has one transition per
 * date at most.
 */
export function etInstant(date: string, hour: number, minute = 0): Date {
  const [y, mo, d] = date.split("-").map(Number)
  if (y === undefined || mo === undefined || d === undefined) {
    throw new Error(`etInstant: not a YYYY-MM-DD date: ${date}`)
  }
  const naive = Date.UTC(y, mo - 1, d, hour, minute)
  const first = naive - offsetMinutes(new Date(naive)) * 60_000
  const second = naive - offsetMinutes(new Date(first)) * 60_000
  return new Date(second)
}

/**
 * Whole calendar days from one ET date to another.
 *
 * Both dates are read as UTC midnight, so a DST transition inside the interval
 * cannot shift the count -- the whole point of counting in dates, not hours.
 */
export function etDaysBetween(from: string, to: string): number {
  const parse = (s: string) => {
    const [y, mo, d] = s.split("-").map(Number)
    if (y === undefined || mo === undefined || d === undefined) {
      throw new Error(`etDaysBetween: not a YYYY-MM-DD date: ${s}`)
    }
    return Date.UTC(y, mo - 1, d)
  }
  return Math.round((parse(to) - parse(from)) / 86_400_000)
}
