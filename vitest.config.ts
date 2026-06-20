import { defineConfig } from "vitest/config";

// Offline unit tests only. The Python engine under engine/ has its own pytest
// suite and is excluded here.
export default defineConfig({
  test: {
    include: ["money/**/*.test.ts", "supplier/**/*.test.ts", "storefront/**/*.test.ts", "lib/**/*.test.ts"],
    exclude: ["node_modules", "engine/**"],
    environment: "node",
  },
});
