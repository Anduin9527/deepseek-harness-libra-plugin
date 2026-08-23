import { BridgeClient } from "@libra/dsh-bridge-client";
import { ContextInjector } from "@libra/dsh-context";
import { loadProtocolReceiver } from "@libra/dsh-protocol";
import { OutboxStore, SessionProjectionService } from "@libra/dsh-session";
import { ToolsFacade } from "@libra/dsh-tools";
import { UiCardService } from "@libra/dsh-ui";
import { WorkspaceBindingService } from "@libra/dsh-workspace";

export interface LibraBundleConfig {
  libraExecutable: string;
  repositoryRoot: string;
  outboxRoot: string;
}

export interface LibraBundleRuntime {
  bridge: BridgeClient;
  projection: SessionProjectionService;
  tools: ToolsFacade;
  workspace: WorkspaceBindingService;
  context: ContextInjector;
  ui: UiCardService;
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
  await bridge.connect();
  const tools = new ToolsFacade(bridge, {
    allowRead: true,
    allowWrite: false,
    allowRestore: false,
    allowPushPublish: false,
  });
  const projection = new SessionProjectionService(new OutboxStore(config.outboxRoot), bridge);
  const workspace = new WorkspaceBindingService(bridge);
  const context = new ContextInjector(tools);
  const ui = new UiCardService(tools, { workspace });
  return {
    bridge,
    projection,
    tools,
    workspace,
    context,
    ui,
    close: async () => {
      ui.dispose();
      await bridge.close();
    },
  };
}

export const bundlePluginName = "@libra/dsh-bundle";
