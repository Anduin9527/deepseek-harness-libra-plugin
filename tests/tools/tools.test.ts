import { chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { BridgeClient } from "@libra/dsh-bridge-client";
import { ToolsFacade } from "@libra/dsh-tools";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const wrapper = fileURLToPath(new URL("../fixtures/fake-bridge-wrapper.sh", import.meta.url));
chmodSync(wrapper, 0o755);

const defaultPolicy = {
  allowRead: true,
  allowWrite: false,
  allowRestore: false,
  allowPushPublish: false,
};

async function connectTools(policy = defaultPolicy): Promise<{ tools: ToolsFacade; bridge: BridgeClient }> {
  const bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
  await bridge.connect();
  return { tools: new ToolsFacade(bridge, policy), bridge };
}

describe("tools", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("maps read tools to bridge methods", async () => {
    const connected = await connectTools();
    bridge = connected.bridge;
    const result = await connected.tools.invoke("libra_status", {});
    expect(result.status).toBe("ok");
  });

  it("denies write tools by default", async () => {
    const connected = await connectTools();
    bridge = connected.bridge;
    const result = await connected.tools.invoke("libra_commit", {});
    expect(result.status).toBe("error");
  });
});

describe("tools:approval-matrix", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("allows read tools when read policy is enabled", async () => {
    const connected = await connectTools({ ...defaultPolicy, allowRead: true });
    bridge = connected.bridge;
    const result = await connected.tools.invoke("libra_diff", {});
    expect(result.status).toBe("ok");
  });

  it("denies restore tools unless restore policy is enabled", async () => {
    const connected = await connectTools({ ...defaultPolicy, allowRestore: false });
    bridge = connected.bridge;
    const denied = await connected.tools.invoke("libra_restore_checkpoint", { session_id: "s1" });
    expect(denied.status).toBe("error");

    await bridge.close();
    bridge = new BridgeClient({ executable: wrapper, cwd: repoRoot, env: { PATH: process.env.PATH ?? "" } });
    await bridge.connect();
    const allowedTools = new ToolsFacade(bridge, { ...defaultPolicy, allowRestore: true });
    const allowed = await allowedTools.invoke("libra_restore_checkpoint", { session_id: "s1" });
    expect(allowed.status).toBe("ok");
  });

  it("denies write tools unless write policy is enabled", async () => {
    const connected = await connectTools({ ...defaultPolicy, allowWrite: true });
    bridge = connected.bridge;
    const result = await connected.tools.invoke("libra_commit", { session_id: "s1" });
    expect(result.status).toBe("ok");
  });
});

describe("tools:invalid-input-and-error-mapping", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("rejects forbidden identity parameters", async () => {
    const connected = await connectTools();
    bridge = connected.bridge;
    const actor = await connected.tools.invoke("libra_status", { actor: "evil" });
    expect(actor.status).toBe("error");
    const db = await connected.tools.invoke("libra_status", { database_path: "/tmp/db" });
    expect(db.status).toBe("error");
  });

  it("maps bridge fatal errors without swallowing them", async () => {
    const connected = await connectTools();
    bridge = connected.bridge;
    const fatal = await connected.tools.invoke("libra_status", { kind: "fatal" });
    expect(fatal.status).toBe("error");
    expect(fatal.error?.retryable).toBe(false);
    expect(fatal.error?.stable_code).toBe("LBR-AGENT-032");
  });

  it("maps retryable bridge errors", async () => {
    const connected = await connectTools();
    bridge = connected.bridge;
    const retryable = await connected.tools.invoke("libra_status", { kind: "retryable" });
    expect(retryable.status).toBe("error");
    expect(retryable.error?.retryable).toBe(true);
  });

  it("maps transport failures to tool errors", async () => {
    const connected = await connectTools();
    bridge = connected.bridge;
    await bridge.close();
    const offline = await connected.tools.invoke("libra_status", {});
    expect(offline.status).toBe("error");
    expect(offline.error?.message).toMatch(/not connected|closed/i);
  });
});
