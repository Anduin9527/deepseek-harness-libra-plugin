import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BridgeClient } from "@libra/dsh-bridge-client";

const libraBinary = process.env.LIBRA_BINARY;
const libraRepo = process.env.LIBRA_REPO;
const realLibraConfigured = Boolean(libraBinary || libraRepo);

describe("bridge-client libra integration", () => {
  let client: BridgeClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it.skipIf(!realLibraConfigured)("handshakes with the compiled libra agent bridge", async () => {
    if (
      !libraBinary ||
      !libraRepo ||
      !existsSync(libraBinary) ||
      !existsSync(join(libraRepo, ".libra"))
    ) {
      throw new Error("configured LIBRA_BINARY/LIBRA_REPO is not a built, initialized Libra checkout");
    }
    client = new BridgeClient({
      executable: libraBinary,
      cwd: libraRepo,
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
