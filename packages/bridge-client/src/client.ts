import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import {
  type AgentBridgeContract,
  type ProtocolReceiverState,
  assertSupportedProtocolMajor,
  loadProtocolReceiver,
} from "@libra/dsh-protocol";

import { BridgeConfigError, normalizeBridgeConfig } from "./config.js";
import {
  classifyTerminalState,
  parseResponseLine,
  serializeRequest,
} from "./ndjson.js";
import type {
  BridgeClientConfig,
  BridgeRequestRecord,
  CompletedRequest,
  InitializeResult,
  JsonRpcResponse,
} from "./types.js";

export class BridgeClientError extends Error {
  readonly code:
    | "not_connected"
    | "handshake_failed"
    | "protocol_violation"
    | "request_timeout"
    | "child_crashed";

  constructor(code: BridgeClientError["code"], message: string) {
    super(message);
    this.name = "BridgeClientError";
    this.code = code;
  }
}

interface PendingWaiter {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface InternalState {
  child: ChildProcess;
  contract: AgentBridgeContract;
  negotiated?: InitializeResult;
  requests: Map<string, BridgeRequestRecord>;
  nextId: number;
  disposed: boolean;
  lineReader: ReturnType<typeof createInterface>;
  pendingById: Map<string, PendingWaiter>;
}

function requestKey(id: number | string | null | undefined): string {
  if (id === null || id === undefined) {
    return "null";
  }
  return String(id);
}

export class BridgeClient {
  private state: InternalState | null = null;
  private readonly config: BridgeClientConfig;
  private readonly receiver: ProtocolReceiverState;

  constructor(config: BridgeClientConfig, receiver?: ProtocolReceiverState) {
    this.config = normalizeBridgeConfig(config);
    this.receiver = receiver ?? loadProtocolReceiver();
    if (this.receiver.status !== "ready") {
      throw new BridgeConfigError(
        `protocol receiver is blocked (${this.receiver.reason}); cannot create bridge client`,
      );
    }
  }

  get contract(): AgentBridgeContract {
    if (this.receiver.status !== "ready") {
      throw new BridgeClientError("handshake_failed", "protocol receiver blocked");
    }
    return this.receiver.contract;
  }

  async connect(): Promise<InitializeResult> {
    if (this.state) {
      return this.handshakeFromOpenConnection();
    }

    const child = spawn(this.config.executable, [...this.config.args ?? []], {
      cwd: this.config.cwd,
      env: this.config.env ?? {},
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!child.stdout || !child.stdin) {
      child.kill();
      throw new BridgeClientError("protocol_violation", "bridge child missing stdio pipes");
    }

    const lineReader = createInterface({ input: child.stdout });
    const pendingById = new Map<string, PendingWaiter>();
    const requests = new Map<string, BridgeRequestRecord>();

    const state: InternalState = {
      child,
      contract: this.contract,
      requests,
      nextId: 1,
      disposed: false,
      lineReader,
      pendingById,
    };

    child.on("error", (error) => {
      if (state.disposed) {
        return;
      }
      state.disposed = true;
      this.state = null;
      const bridgeError = new BridgeClientError("child_crashed", `bridge child error: ${error.message}`);
      for (const pending of pendingById.values()) {
        clearTimeout(pending.timer);
        pending.reject(bridgeError);
      }
      pendingById.clear();
    });

    lineReader.on("line", (line) => {
      this.handleStdoutLine(state, line);
    });

    child.on("exit", (code, signal) => {
      if (!state.disposed) {
        state.disposed = true;
        this.state = null;
        const reason = `bridge child exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
        for (const pending of pendingById.values()) {
          clearTimeout(pending.timer);
          pending.reject(new BridgeClientError("child_crashed", reason));
        }
        pendingById.clear();
        if (!child.killed) {
          child.kill();
        }
      }
    });

    this.state = state;
    try {
      return await this.handshakeFromOpenConnection();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  get negotiatedCapabilities(): InitializeResult | undefined {
    return this.state?.negotiated;
  }

  private async handshakeFromOpenConnection(): Promise<InitializeResult> {
    const state = this.state;
    if (!state) {
      throw new BridgeClientError("not_connected", "bridge client is not connected");
    }

    const response = await this.request(state, "initialize", {
      protocol: {
        major: state.contract.protocol_version.major,
        minor: state.contract.protocol_version.minor,
      },
    });
    const initId = response.id ?? state.nextId - 1;
    const initTerminal = classifyTerminalState(response);

    if (response.error) {
      state.requests.set(requestKey(initId), {
        id: initId,
        method: "initialize",
        state: initTerminal,
        error: response.error,
      });
      throw new BridgeClientError(
        "handshake_failed",
        response.error.message ?? "initialize failed",
      );
    }

    const result = this.parseInitializeResult(response.result);
    state.requests.set(requestKey(initId), {
      id: initId,
      method: "initialize",
      state: initTerminal,
      result,
    });
    assertSupportedProtocolMajor(this.receiver, result.protocol);
    if (result.source !== state.contract.source) {
      throw new BridgeClientError(
        "handshake_failed",
        `bridge source mismatch: expected ${state.contract.source}, got ${result.source}`,
      );
    }
    state.negotiated = result;
    return result;
  }

  async requestMethod(method: string, params?: unknown): Promise<CompletedRequest> {
    const state = this.state;
    if (!state || state.disposed) {
      throw new BridgeClientError("not_connected", "bridge client is not connected");
    }
    if (!state.contract.methods.includes(method)) {
      throw new BridgeClientError("protocol_violation", `method ${method} is not in contract allowlist`);
    }

    const response = await this.request(state, method, params);
    const id = response.id ?? state.nextId - 1;
    const terminal = classifyTerminalState(response);
    const completed: CompletedRequest = {
      id,
      method,
      state: terminal,
      ...(response.result !== undefined ? { result: response.result } : {}),
      ...(response.error ? { error: response.error } : {}),
    };
    state.requests.set(requestKey(id), completed);
    return completed;
  }

  listRequests(): BridgeRequestRecord[] {
    const state = this.state;
    if (!state) {
      return [];
    }
    return [...state.requests.values()];
  }

  async close(): Promise<void> {
    const state = this.state;
    if (!state || state.disposed) {
      return;
    }
    state.disposed = true;
    state.lineReader.close();
    if (state.child.stdin) {
      state.child.stdin.end();
    }
    for (const pending of state.pendingById.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeClientError("not_connected", "bridge client closed"));
    }
    state.pendingById.clear();
    if (!state.child.killed) {
      state.child.kill();
    }
    this.state = null;
  }

  private handleStdoutLine(state: InternalState, line: string): void {
    try {
      const response = parseResponseLine(
        line,
        state.contract.limits.max_frame_bytes,
        state.contract.limits.max_result_bytes,
      );
      const key = requestKey(response.id);
      const pending = state.pendingById.get(key);
      if (!pending) {
        throw new BridgeClientError("protocol_violation", `unexpected response id ${key}`);
      }
      clearTimeout(pending.timer);
      state.pendingById.delete(key);
      pending.resolve(response);
    } catch (error) {
      for (const pending of state.pendingById.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          error instanceof Error
            ? error
            : new BridgeClientError("protocol_violation", String(error)),
        );
      }
      state.pendingById.clear();
      state.disposed = true;
      this.state = null;
      if (!state.child.killed) {
        state.child.kill();
      }
    }
  }

  private request(
    state: InternalState,
    method: string,
    params?: unknown,
  ): Promise<JsonRpcResponse> {
    if (state.disposed) {
      return Promise.reject(new BridgeClientError("not_connected", "bridge client disposed"));
    }
    if (state.pendingById.size >= state.contract.limits.max_inflight) {
      return Promise.reject(
        new BridgeClientError("protocol_violation", "in-flight request limit reached"),
      );
    }

    const id = state.nextId++;
    const key = requestKey(id);
    state.requests.set(key, { id, method, state: "pending" });

    let frame: string;
    try {
      frame = serializeRequest(
        {
          jsonrpc: "2.0",
          method,
          params,
          id,
        },
        state.contract.limits.max_frame_bytes,
      );
    } catch (error) {
      state.requests.delete(key);
      return Promise.reject(
        new BridgeClientError(
          "protocol_violation",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pendingById.delete(key);
        state.requests.set(key, {
          id,
          method,
          state: "error_fatal",
          error: { code: 1010, message: "request deadline exceeded" },
        });
        reject(new BridgeClientError("request_timeout", `request ${method} timed out`));
      }, this.config.requestTimeoutMs ?? 30_000);

      state.pendingById.set(key, { resolve, reject, timer });

      if (!state.child.stdin) {
        clearTimeout(timer);
        state.pendingById.delete(key);
        reject(new BridgeClientError("protocol_violation", "bridge child stdin is unavailable"));
        return;
      }
      state.child.stdin.write(frame, (error) => {
        if (error) {
          clearTimeout(timer);
          state.pendingById.delete(key);
          state.requests.set(key, {
            id,
            method,
            state: "error_fatal",
            error: { code: 1001, message: error.message },
          });
          reject(new BridgeClientError("child_crashed", error.message));
        }
      });
    });
  }

  private parseInitializeResult(value: unknown): InitializeResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BridgeClientError("handshake_failed", "initialize result must be an object");
    }
    const result = value as Record<string, unknown>;
    const protocol = result.protocol;
    const limits = result.limits;
    const methods = result.methods;
    if (
      !protocol ||
      typeof protocol !== "object" ||
      typeof (protocol as Record<string, unknown>).major !== "number" ||
      typeof (protocol as Record<string, unknown>).minor !== "number" ||
      !limits ||
      typeof limits !== "object" ||
      !Array.isArray(methods) ||
      !methods.every((method) => typeof method === "string") ||
      typeof result.source !== "string"
    ) {
      throw new BridgeClientError("handshake_failed", "initialize result does not match the bridge contract");
    }
    const requiredLimits = [
      "max_frame_bytes",
      "max_inflight",
      "max_batch_events",
      "max_batch_bytes",
      "max_event_bytes",
      "max_result_bytes",
      "max_page",
      "request_deadline_secs",
    ] as const;
    for (const key of requiredLimits) {
      const value = (limits as Record<string, unknown>)[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new BridgeClientError("handshake_failed", `initialize limits.${key} is invalid`);
      }
    }
    if (new Set(methods).size !== methods.length || !methods.includes("initialize")) {
      throw new BridgeClientError("handshake_failed", "initialize methods list is invalid");
    }
    return value as InitializeResult;
  }
}
