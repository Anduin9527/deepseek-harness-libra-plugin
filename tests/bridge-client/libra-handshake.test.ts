import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BridgeClient } from "@libra/dsh-bridge-client";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const libraBinary = process.env.LIBRA_BINARY ?? "/Volumes/Data/GitMono/libra/target/release/libra";

describe("bridge-client libra integration", () => {
  let client: BridgeClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("handshakes with the compiled libra agent bridge", async () => {
    if (!existsSync(libraBinary) || !existsSync(join(repoRoot, ".libra"))) {
      throw new Error("libra binary or .libra repo missing — run libra init and build libra first");
    }
    client = new BridgeClient({
      executable: libraBinary,
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        LIBRA_SKIP_WEB_BUILD: "1",
      },
      requestTimeoutMs: 10_000,
    });
    const init = await client.connect();
    expect(init.protocol.major).toBe(1);
    expect(init.source).toBe("deepseek-harness");
    expect(init.methods).toContain("event.append");
  });
});
