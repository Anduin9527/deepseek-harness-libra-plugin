import { randomUUID } from "node:crypto";

import { BridgeClientError, type BridgeClient } from "@libra/dsh-bridge-client";

import type { ApprovalPolicy, ToolDefinition, ToolInput, ToolResult } from "./types.js";

const TOOL_CATALOG: ToolDefinition[] = [
  { name: "libra_context", bridge_method: "context.get", risk: "read", schema_version: "1", retryable: true },
  { name: "libra_status", bridge_method: "status.get", risk: "read", schema_version: "1", retryable: true },
  { name: "libra_diff", bridge_method: "diff.get", risk: "read", schema_version: "1", retryable: true },
  { name: "libra_history_search", bridge_method: "history.search", risk: "read", schema_version: "1", retryable: true },
  { name: "libra_checkpoint", bridge_method: "checkpoint.list", risk: "read", schema_version: "1", retryable: true },
  { name: "libra_commit", bridge_method: "commit.create", risk: "write", schema_version: "1", retryable: false },
  { name: "libra_review", bridge_method: "review.run", risk: "read", schema_version: "1", retryable: true },
  { name: "libra_restore_checkpoint", bridge_method: "checkpoint.restore", risk: "restore", schema_version: "1", retryable: false },
];

const FORBIDDEN_MODEL_PARAMS = new Set([
  "actor",
  "repository_root",
  "executable",
  "database_path",
  "cwd",
  "lease_fence",
  "workspace_id",
]);

const ALLOWED_TOOL_PARAMS = new Set([
  "operation_id",
  "session_id",
  "intent",
  "query",
  "checkpoint_id",
  "limit",
  "offset",
  "kind",
  "page",
]);

export class ToolsFacade {
  private readonly bridge: BridgeClient;
  private readonly policy: ApprovalPolicy;

  constructor(bridge: BridgeClient, policy: ApprovalPolicy) {
    this.bridge = bridge;
    this.policy = policy;
  }

  getPolicy(): ApprovalPolicy {
    return this.policy;
  }

  listTools(): ToolDefinition[] {
    return TOOL_CATALOG;
  }

  async invoke(name: string, params: ToolInput & Record<string, unknown>): Promise<ToolResult> {
    const tool = TOOL_CATALOG.find((entry) => entry.name === name);
    if (!tool) {
      return this.errorResult("unknown-tool", `unknown tool ${name}`, false);
    }
    if (!this.isAllowed(tool.risk)) {
      return this.errorResult(tool.name, `approval denied for ${tool.risk} tool`, false);
    }
    for (const key of Object.keys(params)) {
      if (FORBIDDEN_MODEL_PARAMS.has(key)) {
        return this.errorResult(
          tool.name,
          "model cannot override actor, repository identity, or database path",
          false,
        );
      }
      if (!ALLOWED_TOOL_PARAMS.has(key)) {
        return this.errorResult(tool.name, `unexpected tool parameter ${key}`, false);
      }
    }
    const operation_id =
      typeof params.operation_id === "string" ? params.operation_id : randomUUID();
    const bridgeParams: Record<string, unknown> = { operation_id };
    for (const key of ALLOWED_TOOL_PARAMS) {
      if (key in params && key !== "operation_id") {
        bridgeParams[key] = params[key];
      }
    }
    try {
      const response = await this.bridge.requestMethod(tool.bridge_method, bridgeParams);
      if (response.state === "success") {
        return {
          schema_version: tool.schema_version,
          operation_id,
          status: "ok",
          data: response.result,
        };
      }
      return {
        schema_version: tool.schema_version,
        operation_id,
        status: "error",
        error: {
          code: response.error?.code ?? -32603,
          message: response.error?.message ?? "bridge error",
          retryable: response.error?.data?.retryable ?? tool.retryable,
          ...(response.error?.data?.stable_code
            ? { stable_code: response.error.data.stable_code }
            : {}),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        error instanceof BridgeClientError &&
        (error.code === "request_timeout" || error.code === "child_crashed");
      return this.errorResult(operation_id, message, retryable);
    }
  }

  private isAllowed(risk: ToolDefinition["risk"]): boolean {
    switch (risk) {
      case "read":
        return this.policy.allowRead;
      case "write":
        return this.policy.allowWrite;
      case "restore":
        return this.policy.allowRestore;
      case "push_publish":
        return this.policy.allowPushPublish;
      default: {
        const _exhaustive: never = risk;
        return _exhaustive;
      }
    }
  }

  private errorResult(operation_id: string, message: string, retryable: boolean): ToolResult {
    return {
      schema_version: "1",
      operation_id,
      status: "error",
      error: { code: 1009, message, retryable },
    };
  }
}
