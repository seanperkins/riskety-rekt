import { describe, expect, it } from "vitest"
import { loadSlackEnv } from "./env.js"

const complete = {
  SLACK_SIGNING_SECRET: "s3cret",
  SLACK_BOT_TOKEN: "xoxb-token",
  SLACK_TEAM_ID: "T01ABCDEF",
  SLACK_CHANNEL_ID: "C01ABCDEF",
  RR_WEB_URL: "https://rr.example.com",
}

describe("loadSlackEnv", () => {
  it("returns every value when the environment is complete", () => {
    expect(loadSlackEnv(complete)).toEqual({
      signingSecret: "s3cret",
      botToken: "xoxb-token",
      teamId: "T01ABCDEF",
      channelId: "C01ABCDEF",
      webUrl: "https://rr.example.com",
    })
  })

  it("throws when the signing secret is missing", () => {
    const { SLACK_SIGNING_SECRET: _unused, ...rest } = complete
    expect(() => loadSlackEnv(rest)).toThrow(/SLACK_SIGNING_SECRET/)
  })

  it("throws when the signing secret is present but empty", () => {
    // An unset variable in a systemd EnvironmentFile arrives as "", not as
    // undefined. Treating "" as present is how a service boots unverified.
    expect(() => loadSlackEnv({ ...complete, SLACK_SIGNING_SECRET: "" })).toThrow(
      /SLACK_SIGNING_SECRET/,
    )
  })

  it("throws for each other missing variable", () => {
    for (const key of ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID", "SLACK_CHANNEL_ID", "RR_WEB_URL"]) {
      const partial = { ...complete, [key]: undefined }
      expect(() => loadSlackEnv(partial)).toThrow(new RegExp(key))
    }
  })

  it("refuses to boot when a secret is exposed to the client bundle", () => {
    // Next.js inlines every NEXT_PUBLIC_ variable into the browser bundle. The
    // spec requires this assertion at boot; Plan 4 shares this environment.
    expect(() =>
      loadSlackEnv({ ...complete, NEXT_PUBLIC_SLACK_BOT_TOKEN: "xoxb-leaked" }),
    ).toThrow(/NEXT_PUBLIC_SLACK_BOT_TOKEN/)
  })

  it("allows a NEXT_PUBLIC_ variable that is not secret-shaped", () => {
    expect(() => loadSlackEnv({ ...complete, NEXT_PUBLIC_SITE_URL: "https://x" })).not.toThrow()
  })
})
