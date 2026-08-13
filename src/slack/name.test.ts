import { describe, expect, it } from "vitest"
import { openStore } from "../store/sqlite.js"
import { handleNameCommand } from "./name.js"

function seeded() {
  const store = openStore(":memory:")
  store.addRosterMember({ slackUserId: "U1", factionId: "ada", displayName: "Ada" })
  return store
}

const deps = (store: ReturnType<typeof openStore>) => ({ store })

describe("handleNameCommand", () => {
  it("changes the display name", () => {
    const store = seeded()
    const reply = handleNameCommand({ userId: "U1", text: "Ada Lovelace" }, deps(store))
    expect(store.roster()).toEqual([
      { slackUserId: "U1", factionId: "ada", displayName: "Ada Lovelace" },
    ])
    expect(reply).toContain("Ada Lovelace")
    store.close()
  })

  it("NEVER moves the faction id", () => {
    // The id is written into every saved state and every log line. Following
    // the name would detach a player from their own history.
    const store = seeded()
    handleNameCommand({ userId: "U1", text: "Something Totally Different" }, deps(store))
    expect(store.factionForSlackUser("U1")).toBe("ada")
    store.close()
  })

  it("does not consult a season, so it works whether or not one is running", () => {
    // Renaming has no season gate, unlike joining. Asserted structurally: the
    // deps this handler takes are a RosterStore, which cannot read a season at
    // all, and the rename lands with no season row present.
    const store = seeded()
    expect(store.season("s1")).toBeUndefined()
    handleNameCommand({ userId: "U1", text: "Renamed Mid Flight" }, deps(store))
    expect(store.roster()[0]!.displayName).toBe("Renamed Mid Flight")

    store.upsertSeason({ seasonId: "s1", startDate: "2026-09-01", lengthDays: 14 })
    handleNameCommand({ userId: "U1", text: "Renamed Again" }, deps(store))
    expect(store.roster()[0]!.displayName).toBe("Renamed Again")
    store.close()
  })

  it("refuses somebody who is not on the roster", () => {
    const store = seeded()
    const reply = handleNameCommand({ userId: "U0STRANGER", text: "Nobody" }, deps(store))
    expect(reply).toMatch(/not on the roster/i)
    expect(store.roster()).toHaveLength(1)
    store.close()
  })

  it("asks for a name when given none", () => {
    const store = seeded()
    const reply = handleNameCommand({ userId: "U1", text: "   " }, deps(store))
    expect(reply).toMatch(/usage|give me|what name/i)
    // Unchanged.
    expect(store.roster()[0]!.displayName).toBe("Ada")
    store.close()
  })

  it("refuses an over-long name and says so", () => {
    const store = seeded()
    const reply = handleNameCommand({ userId: "U1", text: "a".repeat(200) }, deps(store))
    expect(reply).toMatch(/too long|32/i)
    expect(store.roster()[0]!.displayName).toBe("Ada")
    store.close()
  })

  it("tidies whitespace rather than refusing it", () => {
    const store = seeded()
    handleNameCommand({ userId: "U1", text: "  Ada   L.  " }, deps(store))
    expect(store.roster()[0]!.displayName).toBe("Ada L.")
    store.close()
  })

  it("does not let a name impersonate a Slack mention in its own reply", () => {
    // The reply goes back to Slack as text. safeText turns the brackets into
    // look-alikes so a name cannot render as a live <!channel> ping.
    const store = seeded()
    const reply = handleNameCommand({ userId: "U1", text: "<!channel>" }, deps(store))
    expect(reply).not.toContain("<!channel>")
    store.close()
  })
})
