import { describe, expect, it } from "vitest"
import { openStore } from "../store/sqlite.js"
import { createSlackApp } from "./app.js"

const env = {
  signingSecret: "s3cret",
  botToken: "xoxb-token",
  teamId: "T1",
  channelId: "C1",
}

describe("createSlackApp", () => {
  it("builds an app without touching the network", () => {
    // deferInitialization keeps the constructor from calling auth.test. If this
    // test ever hangs or fails on a network error, that option was dropped.
    const store = openStore(":memory:")
    const app = createSlackApp({ env, store, log: () => {} })
    expect(typeof app.start).toBe("function")
    store.close()
  })

  it("refuses to build without a signing secret", () => {
    // A missing secret must never degrade into an unverified handler.
    const store = openStore(":memory:")
    expect(() =>
      createSlackApp({ env: { ...env, signingSecret: "" }, store, log: () => {} }),
    ).toThrow(/signing secret/i)
    store.close()
  })
})
