import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["landing/tests/backend/**/*.test.ts"],
  },
});
