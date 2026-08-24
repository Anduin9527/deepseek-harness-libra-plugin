import { chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { BridgeClient } from "@libra/dsh-bridge-client";
import { WorkspaceBindingError, WorkspaceBindingService } from "@libra/dsh-workspace";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const wrapper = fileURLToPath(new URL("../fixtures/fake-bridge-wrapper.sh", import.meta.url));
chmodSync(wrapper, 0o755);

describe("workspace", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("binds actor from session id", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const workspace = new WorkspaceBindingService(bridge);
    const handle = await workspace.claim({
      session_id: "parent",
      workspace_id: "ws1",
      mode: "linked",
    });
    expect(handle.actor).toBe("deepseek-harness:parent");
    await workspace.release("parent");
  });
});

describe("workspace:actor-binding", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("never trusts model-supplied actor on claim", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const workspace = new WorkspaceBindingService(bridge);
    const handle = await workspace.claim({
      session_id: "actor-test",
      workspace_id: "ws-actor",
      mode: "isolated",
    });
    expect(handle.actor).toBe("deepseek-harness:actor-test");
    await workspace.release("actor-test");
  });
});

describe("workspace:subagent-scope", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("requires parent lease before child claim", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const workspace = new WorkspaceBindingService(bridge);
    await expect(
      workspace.claim({
        session_id: "child",
        workspace_id: "ws1",
        mode: "isolated",
        parent_session_id: "missing-parent",
      }),
    ).rejects.toThrow(WorkspaceBindingError);
  });

  it("allows isolated child under parent workspace", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const workspace = new WorkspaceBindingService(bridge);
    await workspace.claim({
      session_id: "parent",
      workspace_id: "ws-shared",
      mode: "linked",
    });
    const child = await workspace.claim({
      session_id: "child",
      workspace_id: "ws-child",
      mode: "isolated",
      parent_session_id: "parent",
    });
    expect(child.parent_session_id).toBe("parent");
    await workspace.release("child");
    await workspace.release("parent");
  });

  it("rejects linked child claiming different workspace than parent", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const workspace = new WorkspaceBindingService(bridge);
    await workspace.claim({
      session_id: "parent",
      workspace_id: "ws-parent",
      mode: "linked",
    });
    await expect(
      workspace.claim({
        session_id: "child",
        workspace_id: "ws-other",
        mode: "linked",
        parent_session_id: "parent",
      }),
    ).rejects.toThrow(/linked subagent cannot claim/);
    await workspace.release("parent");
  });
});

describe("workspace:lease-conflict-and-expiry", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("surfaces lease conflict on renew with stale fence", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const workspace = new WorkspaceBindingService(bridge);
    const handle = await workspace.claim({
      session_id: "lease",
      workspace_id: "ws-lease",
      mode: "readonly",
    });
    const validFence = handle.lease_fence;
    const stored = workspace.getHandle("lease");
    if (stored) {
      stored.lease_fence = 0;
    }
    await expect(workspace.renew("lease")).rejects.toThrow(WorkspaceBindingError);
    if (stored) {
      stored.lease_fence = validFence;
    }
    await workspace.release("lease");
  });

  it("conflicts when workspace already held", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const workspace = new WorkspaceBindingService(bridge);
    await workspace.claim({
      session_id: "holder",
      workspace_id: "ws-busy",
      mode: "linked",
    });
    await expect(
      workspace.claim({
        session_id: "intruder",
        workspace_id: "ws-busy",
        mode: "linked",
      }),
    ).rejects.toThrow(WorkspaceBindingError);
    await workspace.release("holder");
  });
});
