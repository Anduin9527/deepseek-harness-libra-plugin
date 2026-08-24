import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

export class NdjsonProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NdjsonProtocolError";
  }
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function serializeRequest(request: JsonRpcRequest, maxFrameBytes?: number): string {
  const frame = `${JSON.stringify(request)}\n`;
  if (maxFrameBytes !== undefined && utf8ByteLength(frame.trim()) > maxFrameBytes) {
    throw new NdjsonProtocolError(`frame exceeds ${maxFrameBytes} bytes`);
  }
  return frame;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseResponseLine(
  line: string,
  maxFrameBytes: number,
  maxResultBytes?: number,
): JsonRpcResponse {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new NdjsonProtocolError("empty NDJSON frame");
  }
  if (utf8ByteLength(trimmed) > maxFrameBytes) {
    throw new NdjsonProtocolError(`frame exceeds ${maxFrameBytes} bytes`);
  }
  if (!trimmed.startsWith("{")) {
    throw new NdjsonProtocolError("stdout frame is not JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new NdjsonProtocolError(
      `invalid JSON frame: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
    throw new NdjsonProtocolError("unsupported or malformed jsonrpc response");
  }
  if (!("id" in parsed)) {
    throw new NdjsonProtocolError("jsonrpc response is missing id");
  }
  if (
    parsed.id !== null &&
    typeof parsed.id !== "string" &&
    typeof parsed.id !== "number"
  ) {
    throw new NdjsonProtocolError("jsonrpc response id must be a string, number, or null");
  }
  const hasResult = "result" in parsed;
  const hasError = "error" in parsed;
  if (hasResult === hasError) {
    throw new NdjsonProtocolError("jsonrpc response must contain exactly one of result or error");
  }
  if (hasError) {
    const error = parsed.error;
    if (!isRecord(error) || typeof error.code !== "number" || typeof error.message !== "string") {
      throw new NdjsonProtocolError("jsonrpc error object is malformed");
    }
    if (error.data !== undefined && !isRecord(error.data)) {
      throw new NdjsonProtocolError("jsonrpc error data must be an object");
    }
  }
  if (maxResultBytes !== undefined) {
    const resultBytes = utf8ByteLength(JSON.stringify(hasResult ? parsed.result : parsed.error));
    if (resultBytes > maxResultBytes) {
      throw new NdjsonProtocolError(`result exceeds ${maxResultBytes} bytes`);
    }
  }
  return parsed as unknown as JsonRpcResponse;
}

export function classifyTerminalState(
  response: JsonRpcResponse,
): "success" | "error_retryable" | "error_fatal" {
  if (response.error) {
    return response.error.data?.retryable ? "error_retryable" : "error_fatal";
  }
  return "success";
}
