export interface ProtocolVersion {
  major: number;
  minor: number;
}

export interface BridgeLimits {
  max_frame_bytes: number;
  max_inflight: number;
  max_batch_events: number;
  max_batch_bytes: number;
  max_event_bytes: number;
  max_result_bytes: number;
  max_page: number;
  request_deadline_secs: number;
}

export interface BridgeErrorCode {
  code: number;
  stable_code: string;
  retryable: boolean;
}

export interface FixtureProvenance {
  libra_version: string;
  fixture_origin: string;
  golden_frames_path: string;
  authority_revision: string;
}

export interface AgentBridgeContract {
  protocol_version: ProtocolVersion;
  source: string;
  jsonrpc_version: "2.0";
  fixture_provenance: FixtureProvenance;
  methods: readonly string[];
  limits: BridgeLimits;
  error_codes: Record<string, BridgeErrorCode>;
}

export type ProtocolReceiverBlockedReason =
  | "missing_fixture"
  | "empty_fixture";

export type ProtocolReceiverState =
  | {
      status: "ready";
      schemaPath: string;
      contract: AgentBridgeContract;
    }
  | {
      status: "blocked";
      schemaPath: string;
      reason: ProtocolReceiverBlockedReason;
    };
