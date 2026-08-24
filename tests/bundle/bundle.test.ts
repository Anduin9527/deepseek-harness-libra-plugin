import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLibraBundleRuntime,
  bundlePluginName,
  type LibraBundleHandlers,
} from "@libra/dsh-bundle";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const wrapper = fileURLToPath(new URL("../fixtures/fake-bridge-wrapper.sh", import.meta.url));
chmodSync(wrapper, 0o755);

describe("bundle runtime", () => {
  let runtime: Awaited<ReturnType<typeof createLibraBundleRuntime>> | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.close();
      runtime = undefined;
    }
  });

  it("loads all Libra integration packages", async () => {
    runtime = await createLibraBundleRuntime({
      libraExecutable: wrapper,
      repositoryRoot: repoRoot,
      outboxRoot: mkdtempSync(join(tmpdir(), "dsh-bundle-outbox-")),
    });
    expect(bundlePluginName).toBe("@libra-tools/dsh-bundle");
    const tools = runtime.tools.listTools();
    expect(tools.map((tool) => tool.name)).toContain("libra_status");
    expect(runtime.integrationState).toBe("degraded-no-host");
  });

  it("registers lifecycle handlers and disposes host resources", async () => {
    let handlers: LibraBundleHandlers | undefined;
    let unregistered = false;
    const cards: string[] = [];
    const injected: string[] = [];
    const host = {
      registerBundleHandlers: (registered: LibraBundleHandlers) => {
        handlers = registered;
        return () => {
          unregistered = true;
        };
      },
      publishCard: (sessionId: string) => {
        cards.push(sessionId);
      },
      injectContext: ({ session_id }: { session_id: string }) => {
        injected.push(session_id);
      },
    };
    runtime = await createLibraBundleRuntime({
      libraExecutable: wrapper,
      repositoryRoot: repoRoot,
      outboxRoot: mkdtempSync(join(tmpdir(), "dsh-bundle-host-")),
      host,
    });
    expect(runtime.integrationState).toBe("registered");
    expect(handlers).toBeDefined();
    await handlers!.onSessionOpen({
      session_id: "bundle-s1",
      workspace: { path: repoRoot },
    });
    await handlers!.onSessionEvent({
      session_id: "bundle-s1",
      event_seq: 1,
      event_type: "session/diff",
      payload: "{\"files\":1}",
    });
    await runtime.context.inject("bundle-s1");
    const resumed = await handlers!.onCompaction({
      session_id: "bundle-s2",
      parent_session_id: "bundle-s1",
    });
    expect(resumed?.anchor.anchor_id).toContain("bundle-s2");
    expect(cards).toEqual(["bundle-s1"]);
    expect(injected).toEqual(["bundle-s1", "bundle-s2"]);
    await handlers!.onSessionClose({ session_id: "bundle-s1" });
    await runtime.close();
    runtime = undefined;
    expect(unregistered).toBe(true);
  });
});
