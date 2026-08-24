import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { utf8ByteLength } from "@libra/dsh-bridge-client";
import type { AgentBridgeContract } from "@libra/dsh-protocol";

import { hashPayload, redactPayload } from "./redaction.js";
import type { HarnessSessionEvent, OutboxEntry, OutboxSnapshot } from "./types.js";

export const DEFAULT_OUTBOX_MAX_BYTES = 64 * 1024 * 1024;

export const DEFAULT_MAX_REJECTED_DIAGNOSTICS = 64;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class OutboxCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxCorruptionError";
  }
}

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
    chmodSync(this.root, 0o700);
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (error) {
        throw new OutboxCorruptionError(
          `outbox ${sessionId} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.validateSnapshot(parsed, sessionId);
      this.snapshots.set(sessionId, parsed);
      return parsed as OutboxSnapshot;
    } catch (error) {
      if (error instanceof OutboxCorruptionError) {
        throw error;
      }
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
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
    const candidate = this.cloneSnapshot(snapshot);
    if (event.parent_session_id) {
      if (candidate.parent_session_id && candidate.parent_session_id !== event.parent_session_id) {
        throw new Error(
          `parent_session_id drift for ${event.session_id}: ${candidate.parent_session_id} vs ${event.parent_session_id}`,
        );
      }
      candidate.parent_session_id = event.parent_session_id;
    }
    const duplicate = candidate.entries.find((entry) => entry.event_seq === event.event_seq);
    if (duplicate) {
      const redacted = redactPayload(event.payload);
      if (!redacted.ok) {
        return duplicate;
      }
      if (duplicate.payload_hash !== redacted.payload_hash) {
        duplicate.state = "rejected";
        duplicate.last_error = "digest conflict on duplicate event_seq";
        this.persist(candidate);
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
      candidate.entries.push(rejected);
      this.pruneRejectedDiagnostics(candidate);
      candidate.bytes = this.bytesFor(candidate.entries);
      this.persist(candidate);
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
    candidate.entries.push(entry);
    candidate.bytes = this.bytesFor(candidate.entries);
    if (candidate.bytes > this.maxBytes) {
      throw new Error(`outbox quota exceeded for session ${event.session_id}`);
    }
    this.persist(candidate);
    return entry;
  }

  markAcked(sessionId: string, lastSeq: number): void {
    const snapshot = this.load(sessionId);
    this.applyAppendResult(
      sessionId,
      lastSeq,
      snapshot.entries
        .filter((entry) => entry.state === "pending" && entry.event_seq <= lastSeq)
        .map((entry) => ({ seq: entry.event_seq, status: "accepted" as const })),
    );
  }

  applyAppendResult(
    sessionId: string,
    lastAckedSeq: number,
    statuses: readonly { seq: number; status: string }[],
  ): number {
    const snapshot = this.cloneSnapshot(this.load(sessionId));
    const pendingBefore = snapshot.entries.filter((entry) => entry.state === "pending").length;
    snapshot.last_acked_seq = Math.max(snapshot.last_acked_seq, lastAckedSeq);
    const statusBySeq = new Map(statuses.map((status) => [status.seq, status.status]));
    for (const entry of snapshot.entries) {
      if (entry.state !== "pending") {
        continue;
      }
      const status = statusBySeq.get(entry.event_seq);
      if (status === "conflict" || status === "rejected") {
        entry.state = "rejected";
        entry.last_error = `bridge event status: ${status}`;
      } else if (entry.event_seq <= lastAckedSeq || status === "accepted" || status === "duplicate") {
        entry.state = "acked";
      }
    }
    snapshot.entries = snapshot.entries.filter((entry) => entry.state !== "acked");
    this.pruneRejectedDiagnostics(snapshot);
    snapshot.bytes = this.bytesFor(snapshot.entries);
    this.persist(snapshot);
    return pendingBefore - snapshot.entries.filter((entry) => entry.state === "pending").length;
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
    let changed = false;
    let bytes = 0;
    for (const entry of pending) {
      if (utf8ByteLength(entry.payload) > contract.limits.max_event_bytes) {
        entry.state = "rejected";
        entry.last_error = `event exceeds ${contract.limits.max_event_bytes} UTF-8 bytes`;
        changed = true;
        continue;
      }
      if (selected.length >= contract.limits.max_batch_events) {
        break;
      }
      const nextBytes = bytes + utf8ByteLength(entry.payload);
      if (nextBytes > contract.limits.max_batch_bytes) {
        break;
      }
      selected.push(entry);
      bytes = nextBytes;
    }
    if (changed) {
      const updated = this.cloneSnapshot(snapshot);
      this.pruneRejectedDiagnostics(updated);
      updated.bytes = this.bytesFor(updated.entries);
      this.persist(updated);
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
      queued_bytes: pending.reduce((sum, entry) => sum + utf8ByteLength(entry.payload), 0),
      paused: snapshot.bytes >= this.maxBytes,
      rejected_events: rejected.length,
    };
  }

  private persist(snapshot: OutboxSnapshot): void {
    this.snapshots.set(snapshot.session_id, snapshot);
    const path = this.pathFor(snapshot.session_id);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }

  private pathFor(sessionId: string): string {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new OutboxCorruptionError(`invalid session id for outbox path: ${sessionId}`);
    }
    return join(this.root, `${sessionId}.outbox.json`);
  }

  private cloneSnapshot(snapshot: OutboxSnapshot): OutboxSnapshot {
    return {
      ...snapshot,
      entries: snapshot.entries.map((entry) => ({ ...entry })),
    };
  }

  private bytesFor(entries: readonly OutboxEntry[]): number {
    return entries.reduce((sum, entry) => sum + utf8ByteLength(entry.payload), 0);
  }

  private validateSnapshot(value: unknown, sessionId: string): asserts value is OutboxSnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new OutboxCorruptionError(`outbox ${sessionId} must contain an object snapshot`);
    }
    const snapshot = value as Record<string, unknown>;
    if (
      snapshot.session_id !== sessionId ||
      typeof snapshot.last_acked_seq !== "number" ||
      !Number.isSafeInteger(snapshot.last_acked_seq) ||
      snapshot.last_acked_seq < 0 ||
      typeof snapshot.bytes !== "number" ||
      !Number.isSafeInteger(snapshot.bytes) ||
      !Array.isArray(snapshot.entries)
    ) {
      throw new OutboxCorruptionError(`outbox ${sessionId} has an invalid snapshot header`);
    }
    for (const entry of snapshot.entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new OutboxCorruptionError(`outbox ${sessionId} contains an invalid entry`);
      }
      const record = entry as Record<string, unknown>;
      if (
        record.session_id !== sessionId ||
        typeof record.event_seq !== "number" ||
        !Number.isSafeInteger(record.event_seq) ||
        typeof record.event_type !== "string" ||
        typeof record.payload !== "string" ||
        typeof record.payload_hash !== "string" ||
        !["pending", "acked", "rejected"].includes(String(record.state))
      ) {
        throw new OutboxCorruptionError(`outbox ${sessionId} contains an invalid event entry`);
      }
    }
    if (snapshot.bytes !== this.bytesFor(snapshot.entries)) {
      throw new OutboxCorruptionError(`outbox ${sessionId} byte accounting is inconsistent`);
    }
  }
}
