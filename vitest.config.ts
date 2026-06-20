import { defineConfig } from "vitest/config";

// Offline unit tests only. The Python engine under engine/ has its own pytest
// suite and is excluded here.
export default defineConfig({
  test: {
    include: [
      "money/**/*.test.ts",
      "supplier/**/*.test.ts",
      "storefront/**/*.test.ts",
      "lib/**/*.test.ts",
      "cfo/**/*.test.ts",
      "ledger/**/*.test.ts",
    ],
    exclude: ["node_modules", "engine/**"],
    environment: "node",
    // Loads .env.example defaults + offline placeholders so the suite runs with no .env.
    // Never overrides a real .env value (reviewer's live run is unaffected). See cfo/test-setup.ts.
    setupFiles: ["cfo/test-setup.ts"],
  },
});
