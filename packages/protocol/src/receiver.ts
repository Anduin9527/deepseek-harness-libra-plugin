import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentBridgeContract, ProtocolReceiverState, ProtocolVersion } from "./types.js";
import { validateContractShape } from "./validate.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(packageRoot, "..", "..", "..");

const bundledSchemaPath = join(packageRoot, "protocol", "agent-bridge.v1.schema.json");
const DEFAULT_SCHEMA_PATH = existsSync(bundledSchemaPath)
  ? bundledSchemaPath
  : join(repoRoot, "protocol", "agent-bridge.v1.schema.json");

export class ProtocolReceiverError extends Error {
  readonly code: "missing_fixture" | "empty_fixture" | "invalid_fixture" | "major_mismatch";

  constructor(
    code: ProtocolReceiverError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ProtocolReceiverError";
    this.code = code;
  }
}

export function resolveSchemaPath(customPath?: string): string {
  return customPath ?? DEFAULT_SCHEMA_PATH;
}

export function loadProtocolReceiver(options?: {
  schemaPath?: string;
  receiptPath?: string;
}): ProtocolReceiverState {
  const schemaPath = resolveSchemaPath(options?.schemaPath);
  let raw: string;
  try {
    const stats = statSync(schemaPath);
    if (stats.size === 0) {
      return { status: "blocked", reason: "empty_fixture", schemaPath };
    }
    raw = readFileSync(schemaPath, "utf8");
  } catch {
    return { status: "blocked", reason: "missing_fixture", schemaPath };
  }

  if (raw.trim().length === 0) {
    return { status: "blocked", reason: "empty_fixture", schemaPath };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} is not valid JSON: ${message}`,
    );
  }

  const contract = validateContractShape(parsed, schemaPath);
  const receiptPath = options?.receiptPath
    ?? join(dirname(schemaPath), "agent-bridge.v1.receipt.json");
  verifyReceipt(receiptPath, raw, contract);
  return { status: "ready", schemaPath, contract };
}

function verifyReceipt(
  receiptPath: string,
  rawSchema: string,
  contract: AgentBridgeContract,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(receiptPath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol receipt at ${receiptPath} is unavailable or invalid: ${message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProtocolReceiverError("invalid_fixture", "protocol receipt must be an object");
  }
  const receipt = parsed as Record<string, unknown>;
  const version = receipt.protocol_version;
  const authority = receipt.authority;
  const fixture = receipt.fixture;
  const authorityRecord = authority !== null && typeof authority === "object" && !Array.isArray(authority)
    ? authority as Record<string, unknown>
    : undefined;
  const fixtureRecord = fixture !== null && typeof fixture === "object" && !Array.isArray(fixture)
    ? fixture as Record<string, unknown>
    : undefined;
  const expectedSha = fixtureRecord?.sha256;
  const actualSha = createHash("sha256").update(Buffer.from(rawSchema, "utf8")).digest("hex");
  const sha256Hex = /^[0-9a-f]{64}$/;
  if (
    version === null
    || typeof version !== "object"
    || Array.isArray(version)
    || (version as Record<string, unknown>).major !== contract.protocol_version.major
    || (version as Record<string, unknown>).minor !== contract.protocol_version.minor
    || authorityRecord?.repository !== "libra"
    || authorityRecord.revision !== contract.fixture_provenance.authority_revision
    || authorityRecord.protocol_source !== contract.fixture_provenance.fixture_origin
    || authorityRecord.golden_frame !== contract.fixture_provenance.golden_frames_path
    || authorityRecord.libra_version !== contract.fixture_provenance.libra_version
    || typeof authorityRecord.protocol_source_sha256 !== "string"
    || !sha256Hex.test(authorityRecord.protocol_source_sha256)
    || typeof authorityRecord.golden_frame_sha256 !== "string"
    || !sha256Hex.test(authorityRecord.golden_frame_sha256)
    || fixtureRecord?.path !== "protocol/agent-bridge.v1.schema.json"
    || expectedSha !== actualSha
  ) {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      "protocol receipt does not match the loaded schema",
    );
  }
}

export function assertSupportedProtocolMajor(
  receiver: ProtocolReceiverState,
  peer: ProtocolVersion,
): AgentBridgeContract {
  if (receiver.status !== "ready") {
    throw new ProtocolReceiverError(
      "missing_fixture",
      `protocol receiver is blocked (${receiver.reason}); cannot validate protocol major`,
    );
  }
  if (peer.major !== receiver.contract.protocol_version.major) {
    throw new ProtocolReceiverError(
      "major_mismatch",
      `unsupported protocol major ${peer.major}; receiver supports major ${receiver.contract.protocol_version.major}`,
    );
  }
  return receiver.contract;
}

export function isMethodAllowed(
  receiver: ProtocolReceiverState,
  method: string,
): boolean {
  if (receiver.status !== "ready") {
    return false;
  }
  return receiver.contract.methods.includes(method);
}
