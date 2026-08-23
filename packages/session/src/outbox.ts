import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentBridgeContract } from "@libra/dsh-protocol";

import { hashPayload, redactPayload } from "./redaction.js";
import type { HarnessSessionEvent, OutboxEntry, OutboxSnapshot } from "./types.js";

export const DEFAULT_OUTBOX_MAX_BYTES = 64 * 1024 * 1024;

export const DEFAULT_MAX_REJECTED_DIAGNOSTICS = 64;

export class OutboxStore {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly maxRejectedDiagnostics: number;
  private readonly snapshots = new Map<string, OutboxSnapshot>();

  constructor(
    root: string,
    maxBytes = DEFAULT_OUTBOX_MAX_BYTES,
    maxRejectedDiagnostics = DEFAULT_MAX_REJECTED_DIAGNOSTICS,
  ) {
    this.root = root;
    mkdirSync(this.root, { recursive: true });
    this.maxBytes = maxBytes;
    this.maxRejectedDiagnostics = maxRejectedDiagnostics;
  }

  load(sessionId: string): OutboxSnapshot {
    const cached = this.snapshots.get(sessionId);
    if (cached) {
      return cached;
    }
    const path = this.pathFor(sessionId);
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as OutboxSnapshot;
      this.snapshots.set(sessionId, parsed);
      return parsed;
    } catch {
      const empty: OutboxSnapshot = {
        session_id: sessionId,
        last_acked_seq: 0,
        entries: [],
        bytes: 0,
      };
      this.snapshots.set(sessionId, empty);
      return empty;
    }
  }

  enqueue(event: HarnessSessionEvent): OutboxEntry {
    const snapshot = this.load(event.session_id);
    if (event.parent_session_id) {
      if (snapshot.parent_session_id && snapshot.parent_session_id !== event.parent_session_id) {
        throw new Error(
          `parent_session_id drift for ${event.session_id}: ${snapshot.parent_session_id} vs ${event.parent_session_id}`,
        );
      }
      snapshot.parent_session_id = event.parent_session_id;
    }
    const duplicate = snapshot.entries.find((entry) => entry.event_seq === event.event_seq);
    if (duplicate) {
      const redacted = redactPayload(event.payload);
      if (!redacted.ok) {
        return duplicate;
      }
      if (duplicate.payload_hash !== redacted.payload_hash) {
        duplicate.state = "rejected";
        duplicate.last_error = "digest conflict on duplicate event_seq";
        this.persist(snapshot);
        return duplicate;
      }
      return duplicate;
    }

    const redacted = redactPayload(event.payload);
    if (!redacted.ok) {
      const rejected: OutboxEntry = {
        session_id: event.session_id,
        event_seq: event.event_seq,
        event_type: event.event_type,
        payload: "",
        payload_hash: hashPayload(""),
        state: "rejected",
        last_error: redacted.reason,
        ...(event.operation_id ? { operation_id: event.operation_id } : {}),
      };
      snapshot.entries.push(rejected);
      this.pruneRejectedDiagnostics(snapshot);
      this.persist(snapshot);
      return rejected;
    }

    const entry: OutboxEntry = {
      session_id: event.session_id,
      event_seq: event.event_seq,
      event_type: event.event_type,
      payload: redacted.payload,
      payload_hash: redacted.payload_hash,
      state: "pending",
      ...(event.operation_id ? { operation_id: event.operation_id } : {}),
    };
    snapshot.entries.push(entry);
    snapshot.bytes += entry.payload.length;
    if (snapshot.bytes > this.maxBytes) {
      throw new Error(`outbox quota exceeded for session ${event.session_id}`);
    }
    this.persist(snapshot);
    return entry;
  }

  markAcked(sessionId: string, lastSeq: number): void {
    const snapshot = this.load(sessionId);
    snapshot.last_acked_seq = Math.max(snapshot.last_acked_seq, lastSeq);
    for (const entry of snapshot.entries) {
      if (entry.event_seq <= lastSeq && entry.state === "pending") {
        entry.state = "acked";
      }
    }
    snapshot.entries = snapshot.entries.filter((entry) => entry.state !== "acked");
    this.pruneRejectedDiagnostics(snapshot);
    snapshot.bytes = snapshot.entries.reduce((sum, entry) => sum + entry.payload.length, 0);
    this.persist(snapshot);
  }

  private pruneRejectedDiagnostics(snapshot: OutboxSnapshot): void {
    const rejected = snapshot.entries.filter((entry) => entry.state === "rejected");
    if (rejected.length <= this.maxRejectedDiagnostics) {
      return;
    }
    const keepFrom = rejected.length - this.maxRejectedDiagnostics;
    const dropSeqs = new Set(rejected.slice(0, keepFrom).map((entry) => entry.event_seq));
    snapshot.entries = snapshot.entries.filter((entry) => !dropSeqs.has(entry.event_seq));
  }

  parentSessionId(sessionId: string): string | undefined {
    return this.load(sessionId).parent_session_id;
  }

  pendingBatch(
    sessionId: string,
    contract: AgentBridgeContract,
  ): OutboxEntry[] {
    const snapshot = this.load(sessionId);
    const pending = snapshot.entries
      .filter((entry) => entry.state === "pending")
      .sort((a, b) => a.event_seq - b.event_seq);
    const selected: OutboxEntry[] = [];
    let bytes = 0;
    for (const entry of pending) {
      if (selected.length >= contract.limits.max_batch_events) {
        break;
      }
      const nextBytes = bytes + entry.payload.length;
      if (nextBytes > contract.limits.max_batch_bytes) {
        break;
      }
      selected.push(entry);
      bytes = nextBytes;
    }
    return selected;
  }

  metrics(sessionId: string): {
    queued_events: number;
    queued_bytes: number;
    paused: boolean;
    rejected_events: number;
  } {
    const snapshot = this.load(sessionId);
    const pending = snapshot.entries.filter((entry) => entry.state === "pending");
    const rejected = snapshot.entries.filter((entry) => entry.state === "rejected");
    return {
      queued_events: pending.length,
      queued_bytes: pending.reduce((sum, entry) => sum + entry.payload.length, 0),
      paused: snapshot.bytes >= this.maxBytes,
      rejected_events: rejected.length,
    };
  }

  private persist(snapshot: OutboxSnapshot): void {
    this.snapshots.set(snapshot.session_id, snapshot);
    const path = this.pathFor(snapshot.session_id);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot), "utf8");
    renameSync(tmp, path);
  }

  private pathFor(sessionId: string): string {
    return join(this.root, `${sessionId}.outbox.json`);
  }
}
