import { redactPayload } from "@libra/dsh-session";
import type { ApprovalPolicy, ToolsFacade, ToolResult } from "@libra/dsh-tools";
import type { WorkspaceBindingService, WorkspaceMode } from "@libra/dsh-workspace";

export type CardKind = "checkpoint" | "diff" | "commit" | "evidence" | "approval";

export interface UiCard {
  kind: CardKind;
  schema_version: string;
  id: string;
  summary: string;
  status: string;
  warnings: string[];
}

export type UiAction = "read" | "commit" | "restore" | "approve" | "workspace_create";

export interface UiActionOptions {
  workspace_id?: string;
  mode?: WorkspaceMode;
}

export interface UiCardServiceOptions {
  policy?: ApprovalPolicy;
  workspace?: WorkspaceBindingService;
}

function cardKindFromEventType(eventType: string): CardKind | undefined {
  if (eventType.includes("checkpoint")) {
    return "checkpoint";
  }
  if (eventType.includes("diff")) {
    return "diff";
  }
  if (eventType.includes("commit")) {
    return "commit";
  }
  if (eventType.includes("approval")) {
    return "approval";
  }
  if (eventType.includes("tool/result")) {
    return "evidence";
  }
  return undefined;
}

export class UiCardService {
  private readonly tools: ToolsFacade;
  private readonly policy: ApprovalPolicy;
  private readonly workspace?: WorkspaceBindingService;
  private readonly cards: Map<string, UiCard[]> = new Map();
  private readonly inflightActions = new Set<string>();
  private readonly completedActions = new Set<string>();

  constructor(tools: ToolsFacade, options?: UiCardServiceOptions) {
    this.tools = tools;
    this.policy = options?.policy ?? tools.getPolicy();
    if (options?.workspace) {
      this.workspace = options.workspace;
    }
  }

  projectEvent(sessionId: string, eventType: string, payload: string): UiCard | undefined {
    const kind = cardKindFromEventType(eventType);
    if (!kind) {
      return undefined;
    }
    const redacted = redactPayload(payload);
    const warnings: string[] = [];
    let summary = "[REDACTED]";
    let status = "ready";
    if (redacted.ok) {
      summary = redacted.payload.slice(0, 256);
    } else {
      warnings.push(redacted.reason);
      status = "warning";
    }
    const card: UiCard = {
      kind,
      schema_version: "1",
      id: `${sessionId}:${this.cards.get(sessionId)?.length ?? 0}`,
      summary,
      status,
      warnings,
    };
    const list = this.cards.get(sessionId) ?? [];
    list.push(card);
    this.cards.set(sessionId, list);
    return card;
  }

  listCards(sessionId: string): UiCard[] {
    return this.cards.get(sessionId) ?? [];
  }

  async runAction(
    sessionId: string,
    action: UiAction,
    operation_id: string,
    options?: UiActionOptions,
  ): Promise<ToolResult> {
    if (this.completedActions.has(operation_id)) {
      return {
        schema_version: "1",
        operation_id,
        status: "ok",
        data: { deduplicated: true },
      };
    }
    if (this.inflightActions.has(operation_id)) {
      return {
        schema_version: "1",
        operation_id,
        status: "error",
        error: { code: 1010, message: "action already in flight", retryable: true },
      };
    }
    this.inflightActions.add(operation_id);
    try {
      if (action === "read") {
        const readResult = await this.tools.invoke("libra_status", { operation_id });
        if (readResult.status === "ok") {
          this.completedActions.add(operation_id);
        }
        return readResult;
      }
      if (action === "commit") {
        if (!this.policy.allowWrite) {
          return this.actionError(operation_id, "approval denied for commit action", false);
        }
        const commitResult = await this.tools.invoke("libra_commit", {
          operation_id,
          session_id: sessionId,
        });
        if (commitResult.status === "ok") {
          this.completedActions.add(operation_id);
        }
        return commitResult;
      }
      if (action === "restore") {
        if (!this.policy.allowRestore) {
          return this.actionError(operation_id, "approval denied for restore action", false);
        }
        const restoreResult = await this.tools.invoke("libra_restore_checkpoint", {
          operation_id,
          session_id: sessionId,
        });
        if (restoreResult.status === "ok") {
          this.completedActions.add(operation_id);
        }
        return restoreResult;
      }
      if (action === "approve") {
        if (!this.policy.allowWrite && !this.policy.allowRestore) {
          return this.actionError(operation_id, "approval denied: no write or restore policy", false);
        }
        this.completedActions.add(operation_id);
        return {
          schema_version: "1",
          operation_id,
          status: "ok",
          data: { approved: true, session_id: sessionId },
        };
      }
      if (action === "workspace_create") {
        if (!this.policy.allowWrite) {
          return this.actionError(operation_id, "approval denied for workspace create", false);
        }
        if (!this.workspace) {
          return this.actionError(operation_id, "workspace binding unavailable", false);
        }
        const workspaceId = options?.workspace_id ?? `ws-${sessionId}`;
        const mode = options?.mode ?? "linked";
        const handle = await this.workspace.claim({
          session_id: sessionId,
          workspace_id: workspaceId,
          mode,
        });
        this.completedActions.add(operation_id);
        return {
          schema_version: "1",
          operation_id,
          status: "ok",
          data: {
            workspace_id: handle.workspace_id,
            lease_fence: handle.lease_fence,
            actor: handle.actor,
          },
        };
      }
      const _exhaustive: never = action;
      return this.actionError(operation_id, `unknown action ${String(_exhaustive)}`, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.actionError(operation_id, message, false);
    } finally {
      this.inflightActions.delete(operation_id);
    }
  }

  dispose(): void {
    this.cards.clear();
    this.inflightActions.clear();
    this.completedActions.clear();
  }

  private actionError(operation_id: string, message: string, retryable: boolean): ToolResult {
    return {
      schema_version: "1",
      operation_id,
      status: "error",
      error: { code: 1009, message, retryable },
    };
  }
}
