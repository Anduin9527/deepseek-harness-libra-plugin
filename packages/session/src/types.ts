export interface HarnessSessionEvent {
  session_id: string;
  parent_session_id?: string;
  event_seq: number;
  event_type: string;
  payload: string;
  operation_id?: string;
}

export interface OutboxEntry {
  session_id: string;
  event_seq: number;
  event_type: string;
  payload: string;
  payload_hash: string;
  operation_id?: string;
  state: "pending" | "acked" | "rejected";
  last_error?: string;
}

export interface OutboxSnapshot {
  session_id: string;
  parent_session_id?: string;
  last_acked_seq: number;
  entries: OutboxEntry[];
  bytes: number;
}

export interface ProjectionBatch {
  session_id: string;
  events: Array<{
    seq: number;
    type: string;
    payload: string;
    operation_id?: string;
  }>;
}

export interface ProjectionMetrics {
  queued_events: number;
  queued_bytes: number;
  paused: boolean;
  rejected_events: number;
  active_sessions: number;
  warnings: string[];
}

export interface SessionProjectionOptions {
  maxConcurrentSessions?: number;
  maxFlushRetries?: number;
  maxRejectedDiagnostics?: number;
}

export interface DisposeResult {
  drained: boolean;
  warnings: string[];
}

export type RedactionResult =
  | {
      ok: true;
      payload: string;
      payload_hash: string;
    }
  | {
      ok: false;
      reason: string;
    };
