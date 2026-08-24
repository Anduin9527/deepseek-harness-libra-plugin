import { redactPayload } from "@libra/dsh-session";
import { utf8ByteLength } from "@libra/dsh-bridge-client";
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
  path?: string;
  worktree_id?: string;
  mode?: WorkspaceMode;
  checkpoint_id?: string;
  expected_head?: string;
  message?: string;
}

export interface UiHost {
  isAvailable?: () => boolean;
  publishCard?: (sessionId: string, card: UiCard) => Promise<void> | void;
  removeSession?: (sessionId: string) => Promise<void> | void;
}

export interface UiCardServiceOptions {
  policy?: ApprovalPolicy;
  workspace?: WorkspaceBindingService;
  host?: UiHost;
  maxCardsPerSession?: number;
  maxBytesPerSession?: number;
}

const MAX_OPERATION_RECORDS = 4096;

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
  private readonly host: UiHost | undefined;
  private readonly maxCardsPerSession: number;
  private readonly maxBytesPerSession: number;
  private readonly cards: Map<string, UiCard[]> = new Map();
  private readonly inflightActions = new Set<string>();
  private readonly completedActions = new Set<string>();
  private readonly approvedOperations = new Set<string>();
  private readonly operationSessions = new Map<string, string>();
  private operationOrder: string[] = [];

  constructor(tools: ToolsFacade, options?: UiCardServiceOptions) {
    this.tools = tools;
    this.policy = options?.policy ?? tools.getPolicy();
    if (options?.workspace) {
      this.workspace = options.workspace;
    }
    this.host = options?.host;
    this.maxCardsPerSession = options?.maxCardsPerSession ?? 128;
    this.maxBytesPerSession = options?.maxBytesPerSession ?? 10 * 1024 * 1024;
  }

  projectEvent(sessionId: string, eventType: string, payload: string): UiCard | undefined {
    const kind = cardKindFromEventType(eventType);
    if (!kind) {
      return undefined;
    }
    const redacted = redactPayload(payload);
    const warnings: string[] = [];
    let summary = "[REDACTED]";
    let status = this.host?.isAvailable?.() === false ? "warning" : "ready";
    if (status === "warning") {
      warnings.push("DSH UI card capability unavailable; card retained locally only");
    }
    if (redacted.ok) {
      summary = sliceByUtf8Bytes(redacted.payload, 256);
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
    const totalBytes = list.reduce((sum, item) => sum + utf8ByteLength(item.summary), 0);
    if (list.length >= this.maxCardsPerSession || totalBytes + utf8ByteLength(card.summary) > this.maxBytesPerSession) {
      card.status = "warning";
      card.warnings = [...card.warnings, "UI card quota exceeded; retaining only the bounded summary"];
      while (list.length >= this.maxCardsPerSession ||
        list.reduce((sum, item) => sum + utf8ByteLength(item.summary), 0) + utf8ByteLength(card.summary) > this.maxBytesPerSession) {
        list.shift();
        if (list.length === 0) {
          break;
        }
      }
    }
    list.push(card);
    this.cards.set(sessionId, list);
    const publish = this.host?.publishCard;
    if (publish) {
      void Promise.resolve(publish(sessionId, card)).catch(() => undefined);
    }
    return card;
  }

  listCards(sessionId: string): UiCard[] {
    return this.cards.get(sessionId) ?? [];
  }

  disposeSession(sessionId: string): void {
    const remove = this.host?.removeSession;
    if (remove) {
      void Promise.resolve(remove(sessionId)).catch(() => undefined);
    }
    this.cards.delete(sessionId);
    for (const [operation, owner] of this.operationSessions) {
      if (owner === sessionId) {
        this.inflightActions.delete(operation);
        this.completedActions.delete(operation);
        this.approvedOperations.delete(operation);
        this.operationSessions.delete(operation);
      }
    }
    this.operationOrder = this.operationOrder.filter((operation) => this.operationSessions.has(operation));
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
    this.rememberOperation(operation_id, sessionId);
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
          message: options?.message ?? `commit from session ${sessionId}`,
          ...(this.approvedOperations.has(operation_id)
            ? { approval: { decision: "approved", approver: `ui:${sessionId}` } }
            : {}),
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
          checkpoint_id: options?.checkpoint_id,
          expected_head: options?.expected_head,
          ...(this.approvedOperations.has(operation_id)
            ? { approval: { decision: "approved", approver: `ui:${sessionId}` } }
            : {}),
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
        this.approvedOperations.add(operation_id);
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
          ...(options?.path ? { path: options.path } : {}),
          ...(options?.worktree_id ? { worktree_id: options.worktree_id } : {}),
          mode,
        });
        this.completedActions.add(operation_id);
        return {
          schema_version: "1",
          operation_id,
          status: "ok",
          data: {
            workspace_id: handle.workspace_id,
            fence: handle.fence,
            owner: handle.owner,
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
    for (const sessionId of this.cards.keys()) {
      const remove = this.host?.removeSession;
      if (remove) {
        void Promise.resolve(remove(sessionId)).catch(() => undefined);
      }
    }
    this.cards.clear();
    this.inflightActions.clear();
    this.completedActions.clear();
    this.approvedOperations.clear();
    this.operationSessions.clear();
    this.operationOrder = [];
  }

  private actionError(operation_id: string, message: string, retryable: boolean): ToolResult {
    return {
      schema_version: "1",
      operation_id,
      status: "error",
      error: { code: 1009, message, retryable },
    };
  }

  private rememberOperation(operationId: string, sessionId: string): void {
    this.operationSessions.set(operationId, sessionId);
    this.operationOrder.push(operationId);
    while (this.operationOrder.length > MAX_OPERATION_RECORDS) {
      const evicted = this.operationOrder.shift();
      if (!evicted) {
        break;
      }
      this.inflightActions.delete(evicted);
      this.completedActions.delete(evicted);
      this.approvedOperations.delete(evicted);
      this.operationSessions.delete(evicted);
    }
  }
}

function sliceByUtf8Bytes(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) {
    return value;
  }
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && utf8ByteLength(value.slice(0, end)) > maxBytes) {
    end--;
  }
  return value.slice(0, end);
}
