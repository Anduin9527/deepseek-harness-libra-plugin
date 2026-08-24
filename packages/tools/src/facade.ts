import { randomUUID } from "node:crypto";

import { BridgeClientError, type BridgeClient } from "@libra/dsh-bridge-client";

import type {
  ApprovalPolicy,
  ApprovalDecision,
  ToolDefinition,
  ToolInput,
  ToolResult,
} from "./types.js";

const TOOL_CATALOG: ToolDefinition[] = [
  {
    name: "libra_context",
    bridge_method: "context.get",
    risk: "read",
    schema_version: "1",
    retryable: true,
    parameters: ["session_id", "intent", "checkpoint_id"],
    required_parameters: ["session_id"],
  },
  {
    name: "libra_status",
    bridge_method: "status.get",
    risk: "read",
    schema_version: "1",
    retryable: true,
    parameters: ["kind"],
    required_parameters: [],
  },
  {
    name: "libra_diff",
    bridge_method: "diff.get",
    risk: "read",
    schema_version: "1",
    retryable: true,
    parameters: ["mode", "paths", "checkpoint_id", "limit"],
    required_parameters: [],
  },
  {
    name: "libra_history_search",
    bridge_method: "history.search",
    risk: "read",
    schema_version: "1",
    retryable: true,
    parameters: ["query", "limit", "offset", "page"],
    required_parameters: [],
  },
  {
    name: "libra_checkpoint",
    bridge_method: "checkpoint.list",
    risk: "read",
    schema_version: "1",
    retryable: true,
    parameters: ["session_id", "limit", "page"],
    required_parameters: [],
  },
  {
    name: "libra_checkpoint_show",
    bridge_method: "checkpoint.show",
    risk: "read",
    schema_version: "1",
    retryable: true,
    parameters: ["checkpoint_id"],
    required_parameters: ["checkpoint_id"],
  },
  {
    name: "libra_checkpoint_create",
    bridge_method: "checkpoint.create",
    risk: "write",
    schema_version: "1",
    retryable: false,
    parameters: ["session_id", "checkpoint_id", "agent_checkpoint_id", "target_oid", "evidence_ids", "operation_id", "approval"],
    required_parameters: ["checkpoint_id"],
  },
  {
    name: "libra_commit",
    bridge_method: "commit.create",
    risk: "write",
    schema_version: "1",
    retryable: false,
    parameters: ["session_id", "message", "expected_head", "signoff", "allow_empty", "evidence_ids", "operation_id", "approval"],
    required_parameters: ["message"],
  },
  {
    name: "libra_review",
    bridge_method: "review.run",
    risk: "write",
    schema_version: "1",
    retryable: true,
    parameters: ["session_id", "agents", "checkpoint_id", "expected_head", "operation_id"],
    required_parameters: ["agents"],
  },
  {
    name: "libra_restore_checkpoint",
    bridge_method: "checkpoint.restore",
    risk: "restore",
    schema_version: "1",
    retryable: false,
    parameters: ["session_id", "checkpoint_id", "expected_head", "evidence_ids", "operation_id", "approval"],
    required_parameters: ["checkpoint_id", "expected_head"],
  },
];

const FORBIDDEN_MODEL_PARAMS = new Set([
  "actor",
  "repository_root",
  "executable",
  "database_path",
  "cwd",
  "owner",
  "fence",
  "workspace_id",
  "path",
  "worktree_id",
]);

const COMMON_TOOL_PARAMS = new Set([
  "operation_id",
  "approval",
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
    const validationError = this.validateInput(tool, params);
    if (validationError) {
      return this.errorResult(operationIdFor(params, tool.name), validationError, false);
    }
    const operation_id =
      typeof params.operation_id === "string" ? params.operation_id : randomUUID();
    const bridgeParams: Record<string, unknown> = { operation_id };
    for (const key of tool.parameters) {
      if (key in params && key !== "operation_id") {
        bridgeParams[key] = params[key];
      }
    }
    if (tool.risk !== "read" && bridgeParams.approval === undefined) {
      const approval = this.policy.defaultApproval ?? this.defaultApproval(tool.risk);
      if (approval) {
        bridgeParams.approval = approval;
      }
    }
    try {
      const response = await this.bridge.requestMethod(tool.bridge_method, bridgeParams);
      if (response.state === "success") {
        validateResultEnvelope(response.result);
        const normalized = normalizeReadEnvelope(response.result);
        return {
          schema_version: tool.schema_version,
          operation_id,
          status: "ok",
          ...(normalized.data !== undefined ? { data: normalized.data } : {}),
          ...(normalized.warnings.length > 0 ? { warnings: normalized.warnings } : {}),
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

  private validateInput(tool: ToolDefinition, params: ToolInput): string | undefined {
    for (const key of Object.keys(params)) {
      if (FORBIDDEN_MODEL_PARAMS.has(key)) {
        return "model cannot override actor, repository identity, workspace lease, or executable";
      }
      if (!COMMON_TOOL_PARAMS.has(key) && !tool.parameters.includes(key)) {
        return `unexpected tool parameter ${key}`;
      }
    }
    for (const required of tool.required_parameters) {
      if (!(required in params)) {
        return `${tool.name} requires parameter ${required}`;
      }
    }
    if (tool.risk !== "read" && typeof params.operation_id !== "string") {
      return `${tool.name} requires parameter operation_id`;
    }
    if (params.operation_id !== undefined && typeof params.operation_id !== "string") {
      return "operation_id must be a string";
    }
    if (params.approval !== undefined && !isApprovalDecision(params.approval)) {
      return "approval must be { decision: 'approved'|'denied', approver?: string }";
    }
    if (tool.name === "libra_context" && typeof params.session_id !== "string") {
      return "session_id must be a string";
    }
    if (params.session_id !== undefined && typeof params.session_id !== "string") {
      return "session_id must be a string";
    }
    if (tool.name === "libra_restore_checkpoint" && typeof params.expected_head !== "string") {
      return "expected_head must be a string";
    }
    if (tool.name === "libra_commit" && typeof params.message !== "string") {
      return "message must be a string";
    }
    for (const key of ["checkpoint_id", "expected_head", "message"]) {
      if (params[key] !== undefined && typeof params[key] !== "string") {
        return `${key} must be a string`;
      }
    }
    if (params.agents !== undefined &&
      (!Array.isArray(params.agents) || params.agents.length === 0 ||
        params.agents.some((agent) => typeof agent !== "string"))) {
      return "agents must be a non-empty string array";
    }
    for (const key of ["evidence_ids", "paths"]) {
      if (params[key] !== undefined &&
        (!Array.isArray(params[key]) || params[key].some((value) => typeof value !== "string"))) {
        return `${key} must be a string array`;
      }
    }
    return undefined;
  }

  private defaultApproval(risk: ToolDefinition["risk"]): ApprovalDecision | undefined {
    if (risk === "write" && this.policy.allowWrite) {
      return { decision: "approved", approver: "bundle-policy" };
    }
    if (risk === "restore" && this.policy.allowRestore) {
      return { decision: "approved", approver: "bundle-policy" };
    }
    if (risk === "push_publish" && this.policy.allowPushPublish) {
      return { decision: "approved", approver: "bundle-policy" };
    }
    return undefined;
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

function operationIdFor(params: ToolInput, fallback: string): string {
  return typeof params.operation_id === "string" ? params.operation_id : fallback;
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.decision === "approved" || record.decision === "denied") &&
    (record.approver === undefined || typeof record.approver === "string")
  );
}

function normalizeReadEnvelope(value: unknown): { data: unknown; warnings: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { data: value, warnings: [] };
  }
  const record = value as Record<string, unknown>;
  if (record.status !== "ok" || !("data" in record)) {
    if (record.status === "error") {
      throw new Error("bridge returned an error result envelope");
    }
    return { data: value, warnings: [] };
  }
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  return { data: record.data, warnings };
}

function validateResultEnvelope(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const record = value as Record<string, unknown>;
  const looksLikeEnvelope =
    "schema_version" in record ||
    "operation_id" in record ||
    (record.status === "ok" || record.status === "error");
  if (!looksLikeEnvelope) {
    return;
  }
  if (
    record.schema_version !== 1 ||
    typeof record.operation_id !== "string" ||
    (record.status !== "ok" && record.status !== "error") ||
    (record.status === "ok" && !("data" in record)) ||
    (record.warnings !== undefined &&
      (!Array.isArray(record.warnings) || record.warnings.some((warning) => typeof warning !== "object")))
  ) {
    throw new Error("bridge result envelope is malformed");
  }
}
