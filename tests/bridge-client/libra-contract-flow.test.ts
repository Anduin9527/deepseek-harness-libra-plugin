import { mkdtempSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BridgeClient } from "@libra/dsh-bridge-client";
import { OutboxStore, SessionProjectionService } from "@libra/dsh-session";

const libraBinary = process.env.LIBRA_BINARY;
const libraRepo = process.env.LIBRA_REPO;
const realLibraConfigured = Boolean(libraBinary || libraRepo);

describe("libra contract flow", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it.skipIf(!realLibraConfigured)("runs initialize → open → append → flush → close", async () => {
    if (
      !libraBinary ||
      !libraRepo ||
      !existsSync(libraBinary) ||
      !existsSync(join(libraRepo, ".libra"))
    ) {
      throw new Error("configured LIBRA_BINARY/LIBRA_REPO is not a built, initialized Libra checkout");
    }
    bridge = new BridgeClient({
      executable: libraBinary,
      cwd: libraRepo,
      env: {
        PATH: process.env.PATH ?? "",
        LIBRA_SKIP_WEB_BUILD: "1",
      },
      requestTimeoutMs: 15_000,
    });
    await bridge.connect();
    const outboxRoot = mkdtempSync(join(tmpdir(), "dsh-libra-flow-"));
    const projection = new SessionProjectionService(new OutboxStore(outboxRoot), bridge);
    projection.capture({
      session_id: "contract-s1",
      event_seq: 1,
      event_type: "tool/result",
      payload: '{"tool":"libra_status","ok":true}',
    });
    const acked = await projection.flush("contract-s1");
    expect(acked).toBeGreaterThanOrEqual(1);
    await projection.dispose("contract-s1");
    expect(projection.resumeFromAck("contract-s1")).toBeGreaterThanOrEqual(1);
  });
});
