import type { BridgeClient } from "@libra/dsh-bridge-client";

import { OutboxStore } from "./outbox.js";
import type {
  DisposeResult,
  HarnessSessionEvent,
  ProjectionMetrics,
  SessionProjectionOptions,
} from "./types.js";

const DEFAULT_MAX_CONCURRENT_SESSIONS = 64;
const DEFAULT_MAX_FLUSH_RETRIES = 3;

interface AppendResult {
  session_id?: string;
  last_acked_seq: number;
  per_event: Array<{ seq: number; status: "accepted" | "duplicate" | "conflict" | "rejected" }>;
}

export class SessionProjectionService {
  private readonly outbox: OutboxStore;
  private readonly bridge: BridgeClient;
  private readonly maxConcurrentSessions: number;
  private readonly maxFlushRetries: number;
  private readonly pausedSessions = new Set<string>();
  private readonly activeSessions = new Set<string>();
  private readonly openedSessions = new Set<string>();
  private readonly warnings: string[] = [];

  constructor(
    outbox: OutboxStore,
    bridge: BridgeClient,
    options?: SessionProjectionOptions,
  ) {
    this.outbox = outbox;
    this.bridge = bridge;
    this.maxConcurrentSessions = options?.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    this.maxFlushRetries = options?.maxFlushRetries ?? DEFAULT_MAX_FLUSH_RETRIES;
  }

  capture(event: HarnessSessionEvent): ProjectionMetrics {
    if (this.pausedSessions.has(event.session_id)) {
      throw new Error(`session ${event.session_id} projection paused due to outbox quota`);
    }
    if (
      !this.activeSessions.has(event.session_id) &&
      this.activeSessions.size >= this.maxConcurrentSessions
    ) {
      this.warnings.push(`concurrent session limit ${this.maxConcurrentSessions} reached`);
      throw new Error(`concurrent session limit ${this.maxConcurrentSessions} reached`);
    }
    this.activeSessions.add(event.session_id);
    try {
      this.outbox.enqueue(event);
    } catch (error) {
      this.pausedSessions.add(event.session_id);
      throw error;
    }
    return this.metrics(event.session_id);
  }

  async open(sessionId: string, parentSessionId?: string): Promise<void> {
    if (this.openedSessions.has(sessionId)) {
      return;
    }
    const opened = await this.bridge.requestMethod("session.open", {
      session_id: sessionId,
      ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
    });
    if (opened.state !== "success") {
      throw new Error(opened.error?.message ?? "session.open failed");
    }
    this.openedSessions.add(sessionId);
    this.activeSessions.add(sessionId);
  }

  async flush(sessionId: string): Promise<number> {
    const contract = this.bridge.contract;
    let acked = 0;
    let retries = 0;
    for (;;) {
      const batch = this.outbox.pendingBatch(sessionId, contract);
      if (batch.length === 0) {
        break;
      }
      const parentSessionId = this.outbox.parentSessionId(sessionId);
      await this.open(sessionId, parentSessionId);
      let append;
      try {
        append = await this.bridge.requestMethod("event.append", {
          session_id: sessionId,
          events: batch.map((entry) => ({
            seq: entry.event_seq,
            type: entry.event_type,
            payload: entry.payload,
            ...(entry.operation_id ? { operation_id: entry.operation_id } : {}),
          })),
        });
      } catch (error) {
        retries++;
        if (retries > this.maxFlushRetries) {
          throw error;
        }
        this.warnings.push(`event.append retry ${retries} for session ${sessionId}`);
        continue;
      }
      if (append.state !== "success") {
        retries++;
        if (retries > this.maxFlushRetries) {
          throw new Error(append.error?.message ?? "event.append failed");
        }
        this.warnings.push(`event.append failed retry ${retries} for session ${sessionId}`);
        continue;
      }
      const appendResult = this.parseAppendResult(append.result);
      const flush = await this.bridge.requestMethod("session.flush", { session_id: sessionId });
      if (flush.state !== "success") {
        throw new Error(flush.error?.message ?? "session.flush failed");
      }
      const applied = this.outbox.applyAppendResult(
        sessionId,
        appendResult.last_acked_seq,
        appendResult.per_event,
      );
      acked += applied;
      retries = 0;
      if (applied === 0 || batch.length < contract.limits.max_batch_events) {
        break;
      }
    }
    return acked;
  }

  async dispose(sessionId: string, timeoutMs = 5_000): Promise<DisposeResult> {
    const warnings: string[] = [];
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const pending = this.outbox.pendingBatch(sessionId, this.bridge.contract);
      if (pending.length === 0) {
        break;
      }
      try {
        await this.flush(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`flush failed during dispose for ${sessionId}: ${message}`);
        this.warnings.push(warnings[warnings.length - 1] ?? message);
        break;
      }
    }
    const remaining = this.outbox.pendingBatch(sessionId, this.bridge.contract);
    const drained = remaining.length === 0;
    if (!drained) {
      warnings.push(
        `session/disposed drain incomplete for ${sessionId}: ${remaining.length} events remain after ${timeoutMs}ms`,
      );
      this.warnings.push(...warnings);
    }
    await this.bridge.requestMethod("session.close", { session_id: sessionId });
    this.activeSessions.delete(sessionId);
    this.openedSessions.delete(sessionId);
    this.pausedSessions.delete(sessionId);
    return { drained, warnings };
  }

  resumeFromAck(sessionId: string): number {
    return this.outbox.load(sessionId).last_acked_seq;
  }

  metrics(sessionId: string): ProjectionMetrics {
    const base = this.outbox.metrics(sessionId);
    return {
      ...base,
      active_sessions: this.activeSessions.size,
      warnings: [...this.warnings],
      paused: this.pausedSessions.has(sessionId) || base.paused,
    };
  }

  private parseAppendResult(value: unknown): AppendResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("event.append result must be an object");
    }
    const result = value as Record<string, unknown>;
    if (
      typeof result.last_acked_seq !== "number" ||
      !Number.isSafeInteger(result.last_acked_seq) ||
      !Array.isArray(result.per_event)
    ) {
      throw new Error("event.append result is missing last_acked_seq/per_event");
    }
    const perEvent = result.per_event.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("event.append per_event entry is malformed");
      }
      const record = entry as Record<string, unknown>;
      if (
        typeof record.seq !== "number" ||
        !Number.isSafeInteger(record.seq) ||
        !["accepted", "duplicate", "conflict", "rejected"].includes(String(record.status))
      ) {
        throw new Error("event.append per_event status is malformed");
      }
      return {
        seq: record.seq,
        status: record.status as AppendResult["per_event"][number]["status"],
      };
    });
    return {
      ...(typeof result.session_id === "string" ? { session_id: result.session_id } : {}),
      last_acked_seq: result.last_acked_seq,
      per_event: perEvent,
    };
  }
}
