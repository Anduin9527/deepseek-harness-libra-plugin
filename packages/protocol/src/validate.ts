import { ProtocolReceiverError } from "./receiver.js";
import type { AgentBridgeContract } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProtocolVersion(value: unknown, schemaPath: string) {
  if (!isRecord(value)) {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} is missing protocol_version object`,
    );
  }
  const major = value["major"];
  const minor = value["minor"];
  if (typeof major !== "number" || !Number.isInteger(major)) {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} has invalid protocol_version.major`,
    );
  }
  if (typeof minor !== "number" || !Number.isInteger(minor)) {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} has invalid protocol_version.minor`,
    );
  }
  return { major, minor };
}

function readLimits(value: unknown, schemaPath: string) {
  if (!isRecord(value)) {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} is missing limits object`,
    );
  }
  const max_frame_bytes = value["max_frame_bytes"];
  const max_inflight = value["max_inflight"];
  const max_batch_events = value["max_batch_events"];
  const max_batch_bytes = value["max_batch_bytes"];
  const max_event_bytes = value["max_event_bytes"];
  const max_result_bytes = value["max_result_bytes"];
  const max_page = value["max_page"];
  const request_deadline_secs = value["request_deadline_secs"];
  const entries: [string, unknown][] = [
    ["max_frame_bytes", max_frame_bytes],
    ["max_inflight", max_inflight],
    ["max_batch_events", max_batch_events],
    ["max_batch_bytes", max_batch_bytes],
    ["max_event_bytes", max_event_bytes],
    ["max_result_bytes", max_result_bytes],
    ["max_page", max_page],
    ["request_deadline_secs", request_deadline_secs],
  ];
  for (const [key, candidate] of entries) {
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate <= 0) {
      throw new ProtocolReceiverError(
        "invalid_fixture",
        `protocol fixture at ${schemaPath} has invalid limits.${key}`,
      );
    }
  }
  return {
    max_frame_bytes: max_frame_bytes as number,
    max_inflight: max_inflight as number,
    max_batch_events: max_batch_events as number,
    max_batch_bytes: max_batch_bytes as number,
    max_event_bytes: max_event_bytes as number,
    max_result_bytes: max_result_bytes as number,
    max_page: max_page as number,
    request_deadline_secs: request_deadline_secs as number,
  };
}

function readFixtureProvenance(value: unknown, schemaPath: string) {
  if (!isRecord(value)) {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} is missing fixture_provenance`,
    );
  }
  const libra_version = value["libra_version"];
  const fixture_origin = value["fixture_origin"];
  const golden_frames_path = value["golden_frames_path"];
  const authority_revision = value["authority_revision"];
  if (
    typeof libra_version !== "string"
    || libra_version.length === 0
    || typeof fixture_origin !== "string"
    || fixture_origin.length === 0
    || typeof golden_frames_path !== "string"
    || golden_frames_path.length === 0
    || typeof authority_revision !== "string"
    || authority_revision.length === 0
  ) {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} has invalid fixture_provenance`,
    );
  }
  return { libra_version, fixture_origin, golden_frames_path, authority_revision };
}

export function validateContractShape(
  parsed: unknown,
  schemaPath: string,
): AgentBridgeContract {
  if (!isRecord(parsed)) {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} must be a JSON object`,
    );
  }

  const protocol_version = readProtocolVersion(parsed["protocol_version"], schemaPath);
  const source = parsed["source"];
  const jsonrpc_version = parsed["jsonrpc_version"];
  const methods = parsed["methods"];
  const limits = readLimits(parsed["limits"], schemaPath);
  const error_codes = parsed["error_codes"];
  const fixture_provenance = readFixtureProvenance(parsed["fixture_provenance"], schemaPath);

  if (typeof source !== "string" || source.length === 0) {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} has invalid source`,
    );
  }
  if (jsonrpc_version !== "2.0") {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} must declare jsonrpc_version "2.0"`,
    );
  }
  if (!Array.isArray(methods) || methods.some((method) => typeof method !== "string")) {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} has invalid methods array`,
    );
  }
  const validatedMethods = methods;
  if (validatedMethods.length === 0) {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} must list at least one method`,
    );
  }
  if (new Set(validatedMethods).size !== validatedMethods.length) {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} must not contain duplicate methods`,
    );
  }
  if (!validatedMethods.includes("initialize")) {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} must include initialize`,
    );
  }
  if (!isRecord(error_codes)) {
    throw new ProtocolReceiverError(
      "invalid_fixture",
      `protocol fixture at ${schemaPath} has invalid error_codes object`,
    );
  }

  return {
    protocol_version,
    source,
    jsonrpc_version: "2.0",
    fixture_provenance,
    methods: validatedMethods,
    limits,
    error_codes: error_codes as AgentBridgeContract["error_codes"],
  };
}
