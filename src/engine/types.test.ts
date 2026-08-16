import { readFileSync, readdirSync } from "node:fs"
import { posix } from "node:path"
import { describe, expect, it } from "vitest"
import { ENGINE_VERSION } from "./types.js"

describe("engine purity", () => {
  const root = "src/engine"

  // Recursive: mechanics live in src/engine/modules/ (and later rules/), and a
  // flat scan would silently exempt them from every check below.
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
    )
  const files = walk(root).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))

  it("has source files to check", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it("imports nothing outside the engine folder", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!)
      for (const spec of imports) {
        // Reject bare specifiers BEFORE resolving: join("src/engine", "lodash")
        // is under src/engine/, so naive resolution would accept the exact
        // package import this check exists to catch.
        expect(spec.startsWith("./") || spec.startsWith("../"), `${f} imports ${spec}`).toBe(true)
        const resolved = posix.normalize(posix.join(posix.dirname(f), spec))
        expect(resolved.startsWith(`${root}/`), `${f} imports outside the engine: ${resolved}`).toBe(
          true,
        )
      }
    }
  })

  it("uses no wall-clock or randomness", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      expect(src, `${f}`).not.toMatch(/Date\.now|Math\.random|new Date\(/)
    }
  })

  it("exports a version", () => {
    expect(ENGINE_VERSION).toBe("1.1.0")
  })
})
