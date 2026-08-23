import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ProtocolReceiverError,
  assertSupportedProtocolMajor,
  isMethodAllowed,
  loadProtocolReceiver,
} from "@libra/dsh-protocol";

describe("protocol receiver", () => {
  it("loads the DEP-LB-01 fixture with protocol_version", () => {
    const receiver = loadProtocolReceiver();
    expect(receiver.status).toBe("ready");
    if (receiver.status !== "ready") {
      return;
    }
    expect(receiver.contract.protocol_version).toEqual({ major: 1, minor: 0 });
    expect(receiver.contract.methods).toHaveLength(20);
    expect(receiver.contract.limits.max_frame_bytes).toBe(256 * 1024);
    expect(receiver.contract.source).toBe("deepseek-harness");
  });

  it("rejects unknown protocol majors fail-closed", () => {
    const receiver = loadProtocolReceiver();
    expect(() =>
      assertSupportedProtocolMajor(receiver, { major: 2, minor: 0 }),
    ).toThrow(ProtocolReceiverError);
  });

  it("accepts the negotiated major from initialize params", () => {
    const receiver = loadProtocolReceiver();
    const contract = assertSupportedProtocolMajor(receiver, { major: 1, minor: 0 });
    expect(contract.jsonrpc_version).toBe("2.0");
  });

  it("returns blocked when the fixture path is missing", () => {
    const receiver = loadProtocolReceiver({
      schemaPath: join(tmpdir(), "missing-agent-bridge-schema.json"),
    });
    expect(receiver.status).toBe("blocked");
    expect(receiver.reason).toBe("missing_fixture");
    expect(isMethodAllowed(receiver, "initialize")).toBe(false);
  });

  it("returns blocked for a zero-byte fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-protocol-"));
    const schemaPath = join(dir, "empty.schema.json");
    writeFileSync(schemaPath, "");
    const receiver = loadProtocolReceiver({ schemaPath });
    expect(receiver.status).toBe("blocked");
    expect(receiver.reason).toBe("empty_fixture");
  });

  it("accepts additive method entries on the same protocol major", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-protocol-"));
    const schemaPath = join(dir, "additive.schema.json");
    const receiver = loadProtocolReceiver();
    if (receiver.status !== "ready") {
      throw new Error("expected default fixture to be ready");
    }
    const additive = {
      ...receiver.contract,
      protocol_version: { major: 1, minor: 1 },
      methods: [...receiver.contract.methods, "session.ping"],
    };
    writeFileSync(schemaPath, JSON.stringify(additive));
    const loaded = loadProtocolReceiver({ schemaPath });
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") {
      return;
    }
    expect(loaded.contract.methods).toContain("session.ping");
    expect(loaded.contract.protocol_version.minor).toBe(1);
  });
});
