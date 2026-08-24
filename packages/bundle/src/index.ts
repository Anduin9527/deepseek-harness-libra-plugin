import { BridgeClient } from "@libra/dsh-bridge-client";
import { ContextInjector } from "@libra/dsh-context";
import type { ContextHost, ContextSlice } from "@libra/dsh-context";
import { loadProtocolReceiver } from "@libra/dsh-protocol";
import { OutboxStore, SessionProjectionService } from "@libra/dsh-session";
import type { HarnessSessionEvent } from "@libra/dsh-session";
import { ToolsFacade } from "@libra/dsh-tools";
import type { ApprovalPolicy } from "@libra/dsh-tools";
import { UiCardService } from "@libra/dsh-ui";
import type { UiHost } from "@libra/dsh-ui";
import { WorkspaceBindingService } from "@libra/dsh-workspace";
import type { WorkspaceMode } from "@libra/dsh-workspace";

export interface LibraBundleConfig {
  libraExecutable: string;
  repositoryRoot: string;
  outboxRoot: string;
  policy?: ApprovalPolicy;
  host?: LibraHarnessHost;
}

export interface WorkspaceLifecycleInput {
  path?: string;
  worktree_id?: string;
  lease_ttl_ms?: number;
  mode?: WorkspaceMode;
}

export interface SessionLifecycleInput {
  session_id: string;
  parent_session_id?: string;
  workspace?: WorkspaceLifecycleInput;
}

export interface CompactionLifecycleInput {
  session_id: string;
  parent_session_id: string;
  intent?: string;
}

export type BundleDisposer = () => void | Promise<void>;

export interface LibraBundleHandlers {
  onSessionOpen: (input: SessionLifecycleInput) => Promise<void>;
  onSessionEvent: (event: HarnessSessionEvent) => Promise<void>;
  onSessionClose: (input: Pick<SessionLifecycleInput, "session_id">) => Promise<void>;
  onAgentCreate: (input: SessionLifecycleInput) => Promise<void>;
  onAgentDispose: (input: Pick<SessionLifecycleInput, "session_id">) => Promise<void>;
  onSubagentCreate: (input: SessionLifecycleInput) => Promise<void>;
  onSubagentDispose: (input: Pick<SessionLifecycleInput, "session_id">) => Promise<void>;
  onCompaction: (input: CompactionLifecycleInput) => Promise<ContextSlice | undefined>;
}

/**
 * The small, versioned adapter surface expected from the pinned DSH host.
 * The DSH-specific loader owns the implementation; domain packages never
 * import a DSH global or invent a host event API.
 */
export interface LibraHarnessHost extends ContextHost, UiHost {
  registerBundleHandlers?: (
    handlers: LibraBundleHandlers,
  ) => void | BundleDisposer | Promise<void | BundleDisposer>;
}

export type BundleIntegrationState = "degraded-no-host" | "registered";

export interface LibraBundleRuntime {
  bridge: BridgeClient;
  projection: SessionProjectionService;
  tools: ToolsFacade;
  workspace: WorkspaceBindingService;
  context: ContextInjector;
  ui: UiCardService;
  integrationState: BundleIntegrationState;
  registerHost: (host: LibraHarnessHost) => Promise<void>;
  close: () => Promise<void>;
}

export async function createLibraBundleRuntime(config: LibraBundleConfig): Promise<LibraBundleRuntime> {
  const receiver = loadProtocolReceiver();
  const bridge = new BridgeClient(
    {
      executable: config.libraExecutable,
      cwd: config.repositoryRoot,
      env: {
        PATH: process.env.PATH ?? "",
        LIBRA_SKIP_WEB_BUILD: "1",
      },
    },
    receiver,
  );

  try {
    await bridge.connect();
    const policy: ApprovalPolicy = config.policy ?? {
      allowRead: true,
      allowWrite: false,
      allowRestore: false,
      allowPushPublish: false,
    };
    const tools = new ToolsFacade(bridge, policy);
    const projection = new SessionProjectionService(new OutboxStore(config.outboxRoot), bridge);
    const workspace = new WorkspaceBindingService(bridge, config.repositoryRoot);
    let activeHost: LibraHarnessHost | undefined = config.host;
    const hostAdapter: ContextHost & UiHost = {
      isAvailable: () => Boolean(activeHost?.publishCard),
      injectContext: async (input) => {
        if (!activeHost?.injectContext) {
          throw new Error("DSH context injection capability is unavailable");
        }
        await activeHost.injectContext(input);
      },
      publishCard: async (sessionId, card) => {
        if (!activeHost?.publishCard) {
          throw new Error("DSH UI card capability is unavailable");
        }
        await activeHost.publishCard(sessionId, card);
      },
      removeSession: async (sessionId) => {
        if (!activeHost?.removeSession) {
          throw new Error("DSH UI dispose capability is unavailable");
        }
        await activeHost.removeSession(sessionId);
      },
    };
    const context = new ContextInjector(tools, { host: hostAdapter });
    const ui = new UiCardService(tools, { workspace, host: hostAdapter });
    const openSessions = new Set<string>();
    let hostDisposer: BundleDisposer | undefined;
    let hostRegistered = false;
    let integrationState: BundleIntegrationState = config.host ? "registered" : "degraded-no-host";
    let closing = false;
    let closed = false;

    const handlers: LibraBundleHandlers = {
      onSessionOpen: async (input) => {
        assertRuntimeOpen(closed);
        if (openSessions.has(input.session_id)) {
          return;
        }
        await projection.open(input.session_id, input.parent_session_id);
        try {
          if (input.workspace) {
            await workspace.claim({
              session_id: input.session_id,
              ...(input.parent_session_id ? { parent_session_id: input.parent_session_id } : {}),
              ...(input.workspace.path ? { path: input.workspace.path } : {}),
              ...(input.workspace.worktree_id ? { worktree_id: input.workspace.worktree_id } : {}),
              ...(input.workspace.lease_ttl_ms !== undefined
                ? { lease_ttl_ms: input.workspace.lease_ttl_ms }
                : {}),
              ...(input.workspace.mode ? { mode: input.workspace.mode } : {}),
            });
          }
          openSessions.add(input.session_id);
        } catch (error) {
          await projection.dispose(input.session_id).catch(() => undefined);
          throw error;
        }
      },
      onSessionEvent: async (event) => {
        assertRuntimeOpen(closed);
        if (!openSessions.has(event.session_id)) {
          throw new Error(`session ${event.session_id} is not open in the Harness adapter`);
        }
        projection.capture(event);
        ui.projectEvent(event.session_id, event.event_type, event.payload);
      },
      onSessionClose: async ({ session_id }) => {
        if (closed || !openSessions.has(session_id)) {
          return;
        }
        let firstError: unknown;
        try {
          await projection.dispose(session_id);
        } catch (error) {
          firstError = error;
        }
        try {
          await workspace.releaseWithRetry(session_id);
        } catch (error) {
          firstError ??= error;
        }
        context.disposeSession(session_id);
        ui.disposeSession(session_id);
        openSessions.delete(session_id);
        if (firstError) {
          throw firstError;
        }
      },
      onAgentCreate: async (input) => handlers.onSessionOpen(input),
      onAgentDispose: async (input) => handlers.onSessionClose(input),
      onSubagentCreate: async (input) => handlers.onSessionOpen(input),
      onSubagentDispose: async (input) => handlers.onSessionClose(input),
      onCompaction: async (input) => {
        assertRuntimeOpen(closed);
        return context.resumeAfterCompactionAsync(
          input.session_id,
          input.parent_session_id,
          input.intent ?? "resume",
        );
      },
    };

    const registerHost = async (host: LibraHarnessHost): Promise<void> => {
      assertRuntimeOpen(closed);
      if (hostRegistered) {
        return;
      }
      if (typeof host.registerBundleHandlers !== "function") {
        throw new Error("DSH host does not expose registerBundleHandlers; refusing fake ready state");
      }
      const previousHost = activeHost;
      activeHost = host;
      let disposer: void | BundleDisposer | Promise<void | BundleDisposer>;
      try {
        disposer = await host.registerBundleHandlers(handlers);
      } catch (error) {
        activeHost = previousHost;
        throw error;
      }
      hostDisposer = typeof disposer === "function" ? disposer : undefined;
      hostRegistered = true;
      integrationState = "registered";
    };

    const runtime: LibraBundleRuntime = {
      bridge,
      projection,
      tools,
      workspace,
      context,
      ui,
      get integrationState() {
        return integrationState;
      },
      registerHost,
      close: async () => {
        if (closed || closing) {
          return;
        }
        closing = true;
        let firstError: unknown;
        for (const sessionId of [...openSessions]) {
          try {
            await handlers.onSessionClose({ session_id: sessionId });
          } catch (error) {
            firstError ??= error;
          }
        }
        try {
          await hostDisposer?.();
        } catch (error) {
          firstError ??= error;
        }
        hostDisposer = undefined;
        hostRegistered = false;
        ui.dispose();
        context.dispose();
        activeHost = undefined;
        try {
          await bridge.close();
        } catch (error) {
          firstError ??= error;
        }
        if (firstError) {
          closed = true;
          throw firstError;
        }
        closed = true;
      },
    };

    if (config.host) {
      await runtime.registerHost(config.host);
    }
    return runtime;
  } catch (error) {
    await bridge.close().catch(() => undefined);
    throw error;
  }
}

export const bundlePluginName = "@libra-tools/dsh-bundle";

function assertRuntimeOpen(closed: boolean): void {
  if (closed) {
    throw new Error("Libra bundle runtime is closed");
  }
}
