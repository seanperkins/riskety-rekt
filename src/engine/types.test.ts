import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ENGINE_VERSION } from "./types.js"

describe("engine purity", () => {
  const dir = "src/engine"
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))

  it("has source files to check", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it("imports nothing outside the engine folder", () => {
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8")
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!)
      for (const spec of imports) {
        expect(spec.startsWith("./"), `${f} imports ${spec}`).toBe(true)
      }
    }
  })

  it("uses no wall-clock or randomness", () => {
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8")
      expect(src, `${f}`).not.toMatch(/Date\.now|Math\.random|new Date\(/)
    }
  })

  it("exports a version", () => {
    expect(ENGINE_VERSION).toBe("1.0.0")
  })
})
