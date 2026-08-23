import { createHash } from "node:crypto";

import type { RedactionResult } from "./types.js";

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/,
  /Bearer\s+[A-Za-z0-9._-]+/i,
  /api[_-]?key["']?\s*[:=]\s*["'][A-Za-z0-9._-]+/i,
];

export function hashPayload(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function redactPayload(payload: string): RedactionResult {
  if (payload.length > 256 * 1024) {
    return { ok: false, reason: "payload exceeds max event bytes" };
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(payload)) {
      return { ok: false, reason: "secret pattern detected with uncertain redaction" };
    }
  }
  const redacted = payload
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_SECRET]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  return {
    ok: true,
    payload: redacted,
    payload_hash: hashPayload(redacted),
  };
}
