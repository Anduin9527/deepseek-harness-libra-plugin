import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

export class NdjsonProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NdjsonProtocolError";
  }
}

export function serializeRequest(request: JsonRpcRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function parseResponseLine(
  line: string,
  maxFrameBytes: number,
): JsonRpcResponse {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new NdjsonProtocolError("empty NDJSON frame");
  }
  if (trimmed.length > maxFrameBytes) {
    throw new NdjsonProtocolError(`frame exceeds ${maxFrameBytes} bytes`);
  }
  if (!trimmed.startsWith("{")) {
    throw new NdjsonProtocolError("stdout frame is not JSON");
  }
  const parsed = JSON.parse(trimmed) as JsonRpcResponse;
  if (parsed.jsonrpc !== "2.0") {
    throw new NdjsonProtocolError(`unsupported jsonrpc version ${parsed.jsonrpc}`);
  }
  return parsed;
}

export function classifyTerminalState(
  response: JsonRpcResponse,
): "success" | "error_retryable" | "error_fatal" {
  if (response.error) {
    return response.error.data?.retryable ? "error_retryable" : "error_fatal";
  }
  return "success";
}
