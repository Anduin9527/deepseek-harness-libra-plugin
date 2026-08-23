export type BridgeRequestTerminalState =
  | "success"
  | "error_retryable"
  | "error_fatal";

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: {
    stable_code?: string;
    retryable?: boolean;
    resource?: string;
  };
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: JsonRpcErrorObject;
  id: number | string | null;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id?: number | string | null;
}

export interface InitializeResult {
  protocol: { major: number; minor: number };
  limits: Record<string, number>;
  methods: string[];
  source: string;
}

export interface BridgeClientConfig {
  /** Absolute path to the libra executable. Model input must never override this. */
  executable: string;
  /** Fixed argv — only `agent bridge --stdio` is permitted. */
  args?: readonly string[];
  cwd: string;
  /** Environment allowlist merged onto a minimal safe baseline. */
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  libraBinary?: string;
}

export interface PendingRequest {
  id: number | string;
  method: string;
  state: "pending";
}

export interface CompletedRequest {
  id: number | string;
  method: string;
  state: BridgeRequestTerminalState;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export type BridgeRequestRecord = PendingRequest | CompletedRequest;
