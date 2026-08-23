import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@libra/dsh-protocol": fileURLToPath(
        new URL("./packages/protocol/src/index.ts", import.meta.url),
      ),
      "@libra/dsh-bridge-client": fileURLToPath(
        new URL("./packages/bridge-client/src/index.ts", import.meta.url),
      ),
      "@libra/dsh-session": fileURLToPath(
        new URL("./packages/session/src/index.ts", import.meta.url),
      ),
      "@libra/dsh-tools": fileURLToPath(
        new URL("./packages/tools/src/index.ts", import.meta.url),
      ),
      "@libra/dsh-workspace": fileURLToPath(
        new URL("./packages/workspace/src/index.ts", import.meta.url),
      ),
      "@libra/dsh-context": fileURLToPath(
        new URL("./packages/context/src/index.ts", import.meta.url),
      ),
      "@libra/dsh-ui": fileURLToPath(
        new URL("./packages/ui/src/index.ts", import.meta.url),
      ),
      "@libra/dsh-bundle": fileURLToPath(
        new URL("./packages/bundle/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "packages/**/src/**/*.test.ts"],
    environment: "node",
  },
});
