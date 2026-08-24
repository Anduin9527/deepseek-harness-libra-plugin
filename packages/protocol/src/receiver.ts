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
  return { status: "ready", schemaPath, contract };
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
