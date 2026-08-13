import { describe, expect, it } from "vitest"
import { openStore } from "../store/sqlite.js"
import { createSlackApp } from "./app.js"
import type { Directory } from "./post.js"

// A fake, so building an app still touches nothing. Injecting the real one is
// the entrypoint's job precisely so this stays true.
const directory: Directory = {
  nameFor: async () => undefined,
  membersOf: async () => [],
}

const env = {
  signingSecret: "s3cret",
  botToken: "xoxb-token",
  teamId: "T1",
  channelId: "C1",
      webUrl: "https://rr.test",
}

describe("createSlackApp", () => {
  it("builds an app without touching the network", () => {
    // deferInitialization keeps the constructor from calling auth.test. If this
    // test ever hangs or fails on a network error, that option was dropped.
    const store = openStore(":memory:")
    const app = createSlackApp({ env, store, seasonId: "s1", directory, log: () => {} })
    expect(typeof app.start).toBe("function")
    store.close()
  })

  it("refuses to build without a signing secret", () => {
    // A missing secret must never degrade into an unverified handler.
    const store = openStore(":memory:")
    expect(() =>
      createSlackApp({
        env: { ...env, signingSecret: "" },
        store,
        seasonId: "s1",
        directory,
        log: () => {},
      }),
    ).toThrow(/signing secret/i)
    store.close()
  })
})
