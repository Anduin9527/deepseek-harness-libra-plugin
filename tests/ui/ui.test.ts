import { chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { BridgeClient } from "@libra/dsh-bridge-client";
import { ToolsFacade } from "@libra/dsh-tools";
import { UiCardService } from "@libra/dsh-ui";
import { WorkspaceBindingService } from "@libra/dsh-workspace";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const wrapper = fileURLToPath(new URL("../fixtures/fake-bridge-wrapper.sh", import.meta.url));
chmodSync(wrapper, 0o755);

const readOnlyPolicy = {
  allowRead: true,
  allowWrite: false,
  allowRestore: false,
  allowPushPublish: false,
};

describe("ui", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("routes read actions and deduplicates operation_id", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const tools = new ToolsFacade(bridge, readOnlyPolicy);
    const ui = new UiCardService(tools);
    const op = "op-1";
    const first = await ui.runAction("s1", "read", op);
    const second = await ui.runAction("s1", "read", op);
    expect(first.status).toBe("ok");
    expect(second.data).toEqual({ deduplicated: true });
    ui.dispose();
  });

  it("projects all card kinds with redacted summaries", () => {
    const tools = new ToolsFacade({} as BridgeClient, readOnlyPolicy);
    const ui = new UiCardService(tools);
    expect(ui.projectEvent("s1", "session/diff", '{"files":1}')?.kind).toBe("diff");
    expect(ui.projectEvent("s1", "session/commit", '{"sha":"abc"}')?.kind).toBe("commit");
    expect(ui.projectEvent("s1", "session/approval", '{"state":"pending"}')?.kind).toBe("approval");
    expect(ui.projectEvent("s1", "session/checkpoint", '{"id":"cp1"}')?.kind).toBe("checkpoint");
    ui.dispose();
  });
});

describe("ui:approval-and-idempotency", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("denies commit without write approval", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const tools = new ToolsFacade(bridge, readOnlyPolicy);
    const ui = new UiCardService(tools);
    const result = await ui.runAction("s1", "commit", "commit-op");
    expect(result.status).toBe("error");
    expect(result.error?.message).toMatch(/approval denied/);
  });

  it("redacts secret payloads in projected cards", () => {
    const tools = new ToolsFacade({} as BridgeClient, readOnlyPolicy);
    const ui = new UiCardService(tools);
    const card = ui.projectEvent("s1", "tool/result", "token sk-abcdefghijklmnopqrstuvwxyz");
    expect(card?.summary).not.toMatch(/sk-/);
    expect(card?.warnings.length).toBeGreaterThan(0);
  });

  it("routes workspace_create through workspace binding with approval", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const tools = new ToolsFacade(bridge, { ...readOnlyPolicy, allowWrite: true });
    const workspace = new WorkspaceBindingService(bridge);
    const ui = new UiCardService(tools, { workspace });
    const result = await ui.runAction("ws-session", "workspace_create", "ws-op", {
      workspace_id: "ws-ui",
      mode: "linked",
    });
    expect(result.status).toBe("ok");
    expect(result.data).toMatchObject({ workspace_id: "ws-ui" });
    await workspace.release("ws-session");
  });

  it("clears pending state on dispose", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const tools = new ToolsFacade(bridge, readOnlyPolicy);
    const ui = new UiCardService(tools);
    await ui.runAction("s1", "read", "dispose-op");
    ui.projectEvent("s1", "tool/result", '{"ok":true}');
    expect(ui.listCards("s1").length).toBe(1);
    ui.dispose();
    expect(ui.listCards("s1").length).toBe(0);
    const afterDispose = await ui.runAction("s1", "read", "dispose-op");
    expect(afterDispose.status).toBe("ok");
    expect(afterDispose.data).not.toEqual({ deduplicated: true });
  });
});

describe("ui:offline-and-stale-state", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("returns actionable errors when bridge is offline", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const tools = new ToolsFacade(bridge, readOnlyPolicy);
    const ui = new UiCardService(tools);
    await bridge.close();
    const result = await ui.runAction("s1", "read", "offline-op");
    expect(result.status).toBe("error");
    expect(result.error?.message).toMatch(/not connected|closed/i);
  });

  it("surfaces bridge stale/offline tool errors", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const tools = new ToolsFacade(bridge, readOnlyPolicy);
    const stale = await tools.invoke("libra_status", { kind: "offline" });
    expect(stale.status).toBe("error");
    expect(stale.error?.message).toBe("bridge offline");
    expect(stale.error?.retryable).toBe(false);
  });
});
