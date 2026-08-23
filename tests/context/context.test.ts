import { chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { BridgeClient } from "@libra/dsh-bridge-client";
import { ContextInjector } from "@libra/dsh-context";
import { ToolsFacade } from "@libra/dsh-tools";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const wrapper = fileURLToPath(new URL("../fixtures/fake-bridge-wrapper.sh", import.meta.url));
chmodSync(wrapper, 0o755);

const policy = {
  allowRead: true,
  allowWrite: false,
  allowRestore: false,
  allowPushPublish: false,
};

describe("context", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("injects bounded context with anchor metadata", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const tools = new ToolsFacade(bridge, policy);
    const injector = new ContextInjector(tools);
    const slice = await injector.inject("s1", "status");
    expect(slice.anchor.schema_version).toBe("1");
    expect(slice.text.length).toBeLessThanOrEqual(4096);
  });

  it("forwards checkpoint_id for checkpoint-scoped queries", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const tools = new ToolsFacade(bridge, policy);
    const injector = new ContextInjector(tools);
    const slice = await injector.inject("s-checkpoint", "status", "cp-42");
    expect(slice.text).toContain("checkpoint:cp-42");
    const direct = await tools.invoke("libra_context", {
      session_id: "s-checkpoint",
      checkpoint_id: "cp-42",
    });
    expect(direct.data).toMatchObject({ checkpoint_id: "cp-42" });
  });
});

describe("context:budget-and-redaction", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("redacts sensitive context and applies byte budget", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const tools = new ToolsFacade(bridge, policy);
    const injector = new ContextInjector(tools);
    const slice = await injector.inject("s-redact", "status");
    expect(slice.text).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(slice.warnings.some((w) => w.includes("sensitive") || w.includes("redaction"))).toBe(true);
    expect(slice.text.length).toBeLessThanOrEqual(4096);
  });
});

describe("context:compaction-fork-resume", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("rebuilds anchor after compaction without wrong parent", async () => {
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const tools = new ToolsFacade(bridge, policy);
    const injector = new ContextInjector(tools);
    await injector.inject("parent", "status");
    const resumed = injector.resumeAfterCompaction("child", "parent");
    expect(resumed?.anchor_id).toContain("child:resume:");
    expect(injector.resumeAfterCompaction("orphan", "missing")).toBeUndefined();
  });
});
