import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ProtocolReceiverError,
  assertSupportedProtocolMajor,
  isMethodAllowed,
  loadProtocolReceiver,
} from "@libra/dsh-protocol";
import type { AgentBridgeContract } from "@libra/dsh-protocol";

function writeMatchingReceipt(
  schemaPath: string,
  receiptPath: string,
  contract: AgentBridgeContract,
  fixtureSha?: string,
): void {
  const provenance = contract.fixture_provenance;
  const raw = readFileSync(schemaPath, "utf8");
  writeFileSync(receiptPath, JSON.stringify({
    protocol_version: contract.protocol_version,
    authority: {
      repository: "libra",
      revision: provenance.authority_revision,
      protocol_source: provenance.fixture_origin,
      protocol_source_sha256: "a".repeat(64),
      golden_frame: provenance.golden_frames_path,
      golden_frame_sha256: "b".repeat(64),
      libra_version: provenance.libra_version,
    },
    fixture: {
      path: "protocol/agent-bridge.v1.schema.json",
      sha256: fixtureSha ?? createHash("sha256").update(raw, "utf8").digest("hex"),
    },
  }));
}

describe("protocol receiver", () => {
  it("loads the DEP-LB-01 fixture with protocol_version", () => {
    const receiver = loadProtocolReceiver();
    expect(receiver.status).toBe("ready");
    if (receiver.status !== "ready") {
      return;
    }
    expect(receiver.contract.protocol_version).toEqual({ major: 1, minor: 1 });
    expect(receiver.contract.methods).toHaveLength(21);
    expect(receiver.contract.methods[8]).toBe("memory.recall");
    expect(receiver.contract.limits.max_frame_bytes).toBe(256 * 1024);
    expect(receiver.contract.source).toBe("deepseek-harness");
    expect(receiver.contract.error_codes.memory_digest_unavailable).toEqual({
      code: -32603,
      stable_code: "LBR-MEMORY-001",
      retryable: false,
    });
    expect(receiver.contract.error_codes.memory_storage).toEqual({
      code: -32603,
      stable_code: "LBR-MEMORY-005",
      retryable: true,
    });
  });

  it("rejects unknown protocol majors fail-closed", () => {
    const receiver = loadProtocolReceiver();
    expect(() =>
      assertSupportedProtocolMajor(receiver, { major: 2, minor: 0 }),
    ).toThrow(ProtocolReceiverError);
  });

  it("accepts the negotiated major from initialize params", () => {
    const receiver = loadProtocolReceiver();
    const contract = assertSupportedProtocolMajor(receiver, { major: 1, minor: 1 });
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

  it("rejects a mismatched authority receipt", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-protocol-"));
    const schemaPath = join(dir, "agent-bridge.v1.schema.json");
    const receiptPath = join(dir, "agent-bridge.v1.receipt.json");
    const receiver = loadProtocolReceiver();
    if (receiver.status !== "ready") throw new Error("expected default fixture");
    writeFileSync(schemaPath, JSON.stringify(receiver.contract));
    writeMatchingReceipt(schemaPath, receiptPath, receiver.contract, "0".repeat(64));

    expect(() => loadProtocolReceiver({ schemaPath, receiptPath }))
      .toThrow(/receipt does not match/);
  });

  it("requires an authority receipt beside a custom fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-protocol-"));
    const schemaPath = join(dir, "agent-bridge.v1.schema.json");
    const receiver = loadProtocolReceiver();
    if (receiver.status !== "ready") throw new Error("expected default fixture");
    writeFileSync(schemaPath, JSON.stringify(receiver.contract));

    expect(() => loadProtocolReceiver({ schemaPath }))
      .toThrow(/receipt.*unavailable/);
  });

  it("accepts additive method entries on the same protocol major", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-protocol-"));
    const schemaPath = join(dir, "agent-bridge.v1.schema.json");
    const receiptPath = join(dir, "agent-bridge.v1.receipt.json");
    const receiver = loadProtocolReceiver();
    if (receiver.status !== "ready") {
      throw new Error("expected default fixture to be ready");
    }
    const additive = {
      ...receiver.contract,
      protocol_version: { major: 1, minor: 2 },
      methods: [...receiver.contract.methods, "session.ping"],
    };
    writeFileSync(schemaPath, JSON.stringify(additive));
    writeMatchingReceipt(schemaPath, receiptPath, additive);
    const loaded = loadProtocolReceiver({ schemaPath });
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") {
      return;
    }
    expect(loaded.contract.methods).toContain("session.ping");
    expect(loaded.contract.protocol_version.minor).toBe(2);
  });
});
