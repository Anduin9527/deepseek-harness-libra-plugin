import type { BridgeClient } from "@libra/dsh-bridge-client";

export type WorkspaceMode = "linked" | "isolated" | "readonly";

export interface WorkspaceClaimRequest {
  session_id: string;
  workspace_id: string;
  mode: WorkspaceMode;
  parent_session_id?: string;
}

export interface WorkspaceHandle {
  workspace_id: string;
  session_id: string;
  lease_fence: number;
  actor: string;
  mode: WorkspaceMode;
  parent_session_id?: string;
}

export class WorkspaceBindingError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "WorkspaceBindingError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class WorkspaceBindingService {
  private readonly bridge: BridgeClient;
  private readonly handles: Map<string, WorkspaceHandle> = new Map();

  constructor(bridge: BridgeClient) {
    this.bridge = bridge;
  }

  actorForSession(sessionId: string): string {
    return `deepseek-harness:${sessionId}`;
  }

  getHandle(sessionId: string): WorkspaceHandle | undefined {
    return this.handles.get(sessionId);
  }

  async claim(request: WorkspaceClaimRequest): Promise<WorkspaceHandle> {
    this.validateSubagentScope(request);
    const actor = this.actorForSession(request.session_id);
    const response = await this.bridge.requestMethod("workspace.claim", {
      session_id: request.session_id,
      workspace_id: request.workspace_id,
      mode: request.mode,
      actor,
      ...(request.parent_session_id ? { parent_session_id: request.parent_session_id } : {}),
    });
    if (response.state !== "success") {
      const stable = response.error?.data?.stable_code;
      const retryable = response.error?.data?.retryable ?? false;
      throw new WorkspaceBindingError(
        stable ?? "workspace.claim_failed",
        response.error?.message ?? "workspace.claim failed",
        retryable,
      );
    }
    const result = response.result as { lease_fence?: number };
    const handle: WorkspaceHandle = {
      workspace_id: request.workspace_id,
      session_id: request.session_id,
      lease_fence: result.lease_fence ?? 1,
      actor,
      mode: request.mode,
      ...(request.parent_session_id ? { parent_session_id: request.parent_session_id } : {}),
    };
    this.handles.set(request.session_id, handle);
    return handle;
  }

  async renew(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) {
      throw new WorkspaceBindingError("stale_workspace_handle", "stale workspace handle", false);
    }
    const response = await this.bridge.requestMethod("workspace.renew", {
      session_id: sessionId,
      workspace_id: handle.workspace_id,
      lease_fence: handle.lease_fence,
      actor: handle.actor,
    });
    if (response.state !== "success") {
      const retryable = response.error?.data?.retryable ?? false;
      throw new WorkspaceBindingError(
        response.error?.data?.stable_code ?? "workspace.renew_failed",
        response.error?.message ?? "workspace.renew failed",
        retryable,
      );
    }
  }

  async release(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) {
      return;
    }
    const response = await this.bridge.requestMethod("workspace.release", {
      session_id: sessionId,
      workspace_id: handle.workspace_id,
      lease_fence: handle.lease_fence,
      actor: handle.actor,
    });
    if (response.state !== "success") {
      const retryable = response.error?.data?.retryable ?? false;
      throw new WorkspaceBindingError(
        response.error?.data?.stable_code ?? "workspace.release_failed",
        response.error?.message ?? "workspace.release failed",
        retryable,
      );
    }
    this.handles.delete(sessionId);
  }

  async releaseWithRetry(sessionId: string, maxAttempts = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.release(sessionId);
        return;
      } catch (error) {
        const retryable =
          error instanceof WorkspaceBindingError ? error.retryable : false;
        if (!retryable || attempt === maxAttempts) {
          throw error;
        }
      }
    }
  }

  private validateSubagentScope(request: WorkspaceClaimRequest): void {
    if (!request.parent_session_id) {
      return;
    }
    const parent = this.handles.get(request.parent_session_id);
    if (!parent) {
      throw new WorkspaceBindingError(
        "parent_scope_missing",
        `parent session ${request.parent_session_id} has no workspace lease`,
        false,
      );
    }
    if (request.mode === "linked" && parent.workspace_id !== request.workspace_id) {
      throw new WorkspaceBindingError(
        "subagent_scope_violation",
        "linked subagent cannot claim a different workspace than parent",
        false,
      );
    }
    if (parent.mode === "readonly" && request.mode !== "readonly") {
      throw new WorkspaceBindingError(
        "subagent_scope_violation",
        "subagent cannot escalate beyond parent readonly workspace",
        false,
      );
    }
  }
}
