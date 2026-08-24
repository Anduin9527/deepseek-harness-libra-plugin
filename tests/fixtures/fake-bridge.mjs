#!/usr/bin/env node
/**
 * Minimal fake libra agent bridge for contract tests.
 * Speaks JSON-RPC 2.0 NDJSON on stdout; diagnostics on stderr only.
 */
import { createInterface } from "node:readline";

const limits = {
  max_frame_bytes: 262144,
  max_inflight: 64,
  max_batch_events: 64,
  max_batch_bytes: 262144,
  max_event_bytes: 262144,
  max_result_bytes: 262144,
  max_page: 100,
  request_deadline_secs: 30,
};

const methods = [
  "initialize",
  "session.open",
  "event.append",
  "session.flush",
  "session.close",
  "evidence.append",
  "provenance.append",
  "context.get",
  "status.get",
  "diff.get",
  "history.search",
  "checkpoint.create",
  "checkpoint.list",
  "checkpoint.show",
  "checkpoint.restore",
  "commit.create",
  "review.run",
  "workspace.claim",
  "workspace.renew",
  "workspace.release",
];

/** @type {Map<string, { session_id: string; workspace_id: string; lease_fence: number; mode: string; parent_session_id?: string }>} */
const leasesBySession = new Map();
/** @type {Map<string, { session_id: string; workspace_id: string; lease_fence: number }>} */
const leasesByWorkspace = new Map();

function writeResponse(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function expectedActor(sessionId) {
  return `deepseek-harness:${sessionId}`;
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  if (!trimmed.startsWith("{")) {
    console.error("non-json frame");
    writeResponse({
      jsonrpc: "2.0",
      error: { code: -32700, message: "parse error", data: { stable_code: "LBR-AGENT-024", retryable: false } },
      id: null,
    });
    return;
  }
  const frame = JSON.parse(trimmed);
  const id = frame.id ?? null;
  if (frame.method === "initialize") {
    const major = frame.params?.protocol?.major;
    if (major !== 1) {
      writeResponse({
        jsonrpc: "2.0",
        error: {
          code: 1000,
          message: "major mismatch",
          data: { stable_code: "LBR-AGENT-031", retryable: false },
        },
        id,
      });
      return;
    }
    writeResponse({
      jsonrpc: "2.0",
      result: {
        protocol: { major: 1, minor: 0 },
        limits,
        methods,
        source: "deepseek-harness",
      },
      id,
    });
    return;
  }
  if (frame.method === "workspace.claim") {
    const params = frame.params ?? {};
    const sessionId = params.session_id;
    const workspaceId = params.workspace_id ?? params.worktree_id ?? params.path ?? "workspace";
    const actor = params.actor ?? expectedActor(sessionId);
    const mode = params.mode ?? "linked";
    const parentSessionId = params.parent_session_id;
    if (!sessionId || !workspaceId) {
      writeResponse({
        jsonrpc: "2.0",
        error: {
          code: 1009,
          message: "missing workspace identity",
          data: { stable_code: "LBR-AGENT-022", retryable: false },
        },
        id,
      });
      return;
    }
    if (actor !== expectedActor(sessionId)) {
      writeResponse({
        jsonrpc: "2.0",
        error: {
          code: 1009,
          message: "actor binding mismatch",
          data: { stable_code: "LBR-AGENT-022", retryable: false },
        },
        id,
      });
      return;
    }
    if (parentSessionId && !leasesBySession.has(parentSessionId)) {
      writeResponse({
        jsonrpc: "2.0",
        error: {
          code: 1006,
          message: "parent workspace lease missing",
          data: { stable_code: "LBR-AGENT-023", retryable: false },
        },
        id,
      });
      return;
    }
    const existing = leasesByWorkspace.get(workspaceId);
    if (existing && existing.session_id !== sessionId && !parentSessionId) {
      writeResponse({
        jsonrpc: "2.0",
        error: {
          code: 1009,
          message: "workspace lease held",
          data: { stable_code: "LBR-AGENT-022", retryable: true },
        },
        id,
      });
      return;
    }
    const leaseFence = (existing?.lease_fence ?? 0) + 1;
    const lease = {
      session_id: sessionId,
      workspace_id: workspaceId,
      lease_fence: leaseFence,
      mode,
      ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
    };
    leasesBySession.set(sessionId, lease);
    leasesByWorkspace.set(workspaceId, lease);
    writeResponse({
      jsonrpc: "2.0",
      result: {
        session_id: sessionId,
        workspace_id: workspaceId,
        owner: expectedActor(sessionId),
        fence: leaseFence,
        lease_fence: leaseFence,
        expires_at: Date.now() + (params.lease_ttl_ms ?? 30_000),
      },
      id,
    });
    return;
  }
  if (frame.method === "workspace.renew") {
    const params = frame.params ?? {};
    const lease = leasesBySession.get(params.session_id);
    const fence = params.fence ?? params.lease_fence;
    if (!lease || lease.lease_fence !== fence) {
      writeResponse({
        jsonrpc: "2.0",
        error: {
          code: 1006,
          message: "workspace lease lost",
          data: { stable_code: "LBR-AGENT-023", retryable: false },
        },
        id,
      });
      return;
    }
    writeResponse({
      jsonrpc: "2.0",
      result: {
        session_id: params.session_id,
        workspace_id: lease.workspace_id,
        owner: expectedActor(params.session_id),
        fence: lease.lease_fence,
        expires_at: Date.now() + (params.lease_ttl_ms ?? 30_000),
      },
      id,
    });
    return;
  }
  if (frame.method === "workspace.release") {
    const params = frame.params ?? {};
    const lease = leasesBySession.get(params.session_id);
    if (!lease) {
      writeResponse({ jsonrpc: "2.0", result: { ok: true }, id });
      return;
    }
    const fence = params.fence ?? params.lease_fence;
    if (lease.lease_fence !== fence) {
      writeResponse({
        jsonrpc: "2.0",
        error: {
          code: 1009,
          message: "workspace lease conflict",
          data: { stable_code: "LBR-AGENT-022", retryable: true },
        },
        id,
      });
      return;
    }
    leasesBySession.delete(params.session_id);
    const workspaceLease = leasesByWorkspace.get(lease.workspace_id);
    if (workspaceLease?.session_id === params.session_id) {
      leasesByWorkspace.delete(lease.workspace_id);
    }
    writeResponse({ jsonrpc: "2.0", result: { ok: true }, id });
    return;
  }
  if (frame.method === "session.open") {
    writeResponse({ jsonrpc: "2.0", result: { opened: true }, id });
    return;
  }
  if (frame.method === "event.append") {
    const events = frame.params?.events ?? [];
    writeResponse({
      jsonrpc: "2.0",
      result: {
        session_id: frame.params?.session_id,
        per_event: events.map((event) => ({ seq: event.seq, status: "accepted" })),
        last_acked_seq: events.at(-1)?.seq ?? 0,
      },
      id,
    });
    return;
  }
  if (frame.method === "session.flush") {
    writeResponse({ jsonrpc: "2.0", result: { flushed: true }, id });
    return;
  }
  if (frame.method === "session.close") {
    writeResponse({ jsonrpc: "2.0", result: { closed: true }, id });
    return;
  }
  if (frame.method === "context.get") {
    const checkpointId = frame.params?.checkpoint_id;
    writeResponse({
      jsonrpc: "2.0",
      result: {
        history: "token sk-abcdefghijklmnopqrstuvwxyz prior context",
        decisions: "decision summary",
        evidence: checkpointId ? `checkpoint:${checkpointId}` : "evidence summary",
        skills: "skill hints",
        sensitive: "token sk-abcdefghijklmnopqrstuvwxyz",
        checkpoint_id: checkpointId ?? null,
      },
      id,
    });
    return;
  }
  if (frame.method === "status.get") {
    if (frame.params?.kind === "retryable") {
      writeResponse({
        jsonrpc: "2.0",
        error: {
          code: 1010,
          message: "retry me",
          data: { stable_code: "LBR-AGENT-036", retryable: true },
        },
        id,
      });
      return;
    }
    if (frame.params?.kind === "fatal") {
      writeResponse({
        jsonrpc: "2.0",
        error: {
          code: 1006,
          message: "fatal",
          data: { stable_code: "LBR-AGENT-032", retryable: false },
        },
        id,
      });
      return;
    }
    if (frame.params?.kind === "partial") {
      writeResponse({ jsonrpc: "2.0", result: { partial: true }, id });
      return;
    }
    if (frame.params?.kind === "offline") {
      writeResponse({
        jsonrpc: "2.0",
        error: {
          code: 1006,
          message: "bridge offline",
          data: { stable_code: "LBR-AGENT-023", retryable: false },
        },
        id,
      });
      return;
    }
  }
  if (frame.method === "retryable.error") {
    writeResponse({
      jsonrpc: "2.0",
      error: {
        code: 1010,
        message: "retry me",
        data: { stable_code: "LBR-AGENT-036", retryable: true },
      },
      id,
    });
    return;
  }
  if (frame.method === "fatal.error") {
    writeResponse({
      jsonrpc: "2.0",
      error: {
        code: 1006,
        message: "fatal",
        data: { stable_code: "LBR-AGENT-032", retryable: false },
      },
      id,
    });
    return;
  }
  if (frame.method === "partial.response") {
    writeResponse({ jsonrpc: "2.0", result: { partial: true }, id });
    return;
  }
  if (!methods.includes(frame.method)) {
    writeResponse({
      jsonrpc: "2.0",
      error: {
        code: -32601,
        message: "unknown",
        data: { stable_code: "LBR-AGENT-026", retryable: false },
      },
      id,
    });
    return;
  }
  writeResponse({ jsonrpc: "2.0", result: { ok: true, method: frame.method }, id });
});
