import type { BridgeClient } from "@libra/dsh-bridge-client";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type WorkspaceMode = "linked" | "isolated" | "readonly";

export interface WorkspaceClaimRequest {
  session_id: string;
  path?: string;
  worktree_id?: string;
  lease_ttl_ms?: number;
  parent_session_id?: string;
  /** @deprecated only used to validate legacy local parent scope; never sent to Libra. */
  workspace_id?: string;
  /** @deprecated local UI hint; the bridge derives workspace kind from path/worktree_id. */
  mode?: WorkspaceMode;
}

export interface WorkspaceHandle {
  workspace_id: string;
  session_id: string;
  owner: string;
  fence: number;
  expires_at: number | null | undefined;
  lease_ttl_ms?: number;
  /** Compatibility aliases for existing UI consumers. */
  lease_fence: number;
  actor: string;
  mode?: WorkspaceMode;
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
  private readonly repositoryRoot: string;
  private readonly handles: Map<string, WorkspaceHandle> = new Map();

  constructor(bridge: BridgeClient, repositoryRoot = process.cwd()) {
    this.bridge = bridge;
    this.repositoryRoot = resolve(repositoryRoot);
  }

  getHandle(sessionId: string): WorkspaceHandle | undefined {
    return this.handles.get(sessionId);
  }

  async claim(request: WorkspaceClaimRequest): Promise<WorkspaceHandle> {
    this.validateSubagentScope(request);
    const path = this.validatePath(request.path ?? this.repositoryRoot);
    const response = await this.bridge.requestMethod("workspace.claim", {
      session_id: request.session_id,
      path,
      ...(request.worktree_id ? { worktree_id: request.worktree_id } : {}),
      ...(request.lease_ttl_ms !== undefined ? { lease_ttl_ms: request.lease_ttl_ms } : {}),
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
    const result = this.parseLeaseResult(response.result, "workspace.claim");
    const handle: WorkspaceHandle = {
      workspace_id: result.workspace_id,
      session_id: request.session_id,
      owner: result.owner,
      fence: result.fence,
      expires_at: result.expires_at,
      ...(request.lease_ttl_ms !== undefined ? { lease_ttl_ms: request.lease_ttl_ms } : {}),
      lease_fence: result.fence,
      actor: result.owner,
      ...(request.mode ? { mode: request.mode } : {}),
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
    const fence = handle.fence === handle.lease_fence ? handle.fence : handle.lease_fence;
    const response = await this.bridge.requestMethod("workspace.renew", {
      session_id: sessionId,
      workspace_id: handle.workspace_id,
      owner: handle.owner,
      fence,
      ...(handle.lease_ttl_ms !== undefined ? { lease_ttl_ms: handle.lease_ttl_ms } : {}),
    });
    if (response.state !== "success") {
      const retryable = response.error?.data?.retryable ?? false;
      throw new WorkspaceBindingError(
        response.error?.data?.stable_code ?? "workspace.renew_failed",
        response.error?.message ?? "workspace.renew failed",
        retryable,
      );
    }
    const renewed = this.parseLeaseResult(response.result, "workspace.renew");
    handle.owner = renewed.owner;
    handle.fence = renewed.fence;
    handle.lease_fence = renewed.fence;
    handle.expires_at = renewed.expires_at;
  }

  async release(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) {
      return;
    }
    const response = await this.bridge.requestMethod("workspace.release", {
      session_id: sessionId,
      workspace_id: handle.workspace_id,
      owner: handle.owner,
      fence: handle.fence,
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
    const requestedScope = request.workspace_id ?? request.worktree_id;
    if (request.mode === "linked" && requestedScope && parent.workspace_id !== requestedScope) {
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

  private validatePath(path: string): string {
    if (!isAbsolute(path)) {
      throw new WorkspaceBindingError("invalid_workspace_path", "workspace path must be absolute", false);
    }
    const resolved = resolve(path);
    const escaped = relative(this.repositoryRoot, resolved);
    if (escaped === ".." || escaped.startsWith(`..${requireSeparator()}`) || isAbsolute(escaped)) {
      throw new WorkspaceBindingError("workspace_scope_mismatch", "workspace path escapes repository root", false);
    }
    try {
      const real = realpathSync.native(resolved);
      const realRoot = realpathSync.native(this.repositoryRoot);
      const realRelative = relative(realRoot, real);
      if (realRelative === ".." || realRelative.startsWith(`..${requireSeparator()}`) || isAbsolute(realRelative)) {
        throw new WorkspaceBindingError("workspace_scope_mismatch", "workspace symlink escapes repository root", false);
      }
    } catch (error) {
      if (error instanceof WorkspaceBindingError) {
        throw error;
      }
      // A new worktree path may not exist until the server creates it. The
      // lexical containment check above remains mandatory for that case.
    }
    return resolved;
  }

  private parseLeaseResult(value: unknown, action: string): {
    workspace_id: string;
    owner: string;
    fence: number;
    expires_at: number | null | undefined;
  } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new WorkspaceBindingError("invalid_bridge_result", `${action} returned a malformed lease`, false);
    }
    const result = value as Record<string, unknown>;
    const fence = result.fence ?? result.lease_fence;
    if (
      typeof result.workspace_id !== "string" ||
      typeof result.owner !== "string" ||
      typeof fence !== "number" ||
      !Number.isSafeInteger(fence)
    ) {
      throw new WorkspaceBindingError("invalid_bridge_result", `${action} returned an incomplete lease`, false);
    }
    return {
      workspace_id: result.workspace_id,
      owner: result.owner,
      fence,
      expires_at: typeof result.expires_at === "number" || result.expires_at === null
        ? result.expires_at
        : undefined,
    };
  }
}

function requireSeparator(): string {
  return process.platform === "win32" ? "\\\\" : "/";
}
