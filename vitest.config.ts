import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Enforces the offline rule instead of trusting it. See the file's comment.
    setupFiles: ["test/no-network.ts"],
  },
})
