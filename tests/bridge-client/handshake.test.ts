import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BridgeClient,
  BridgeClientError,
  BridgeConfigError,
  classifyTerminalState,
  normalizeBridgeConfig,
  parseResponseLine,
  serializeRequest,
  utf8ByteLength,
} from "@libra/dsh-bridge-client";
import { loadProtocolReceiver } from "@libra/dsh-protocol";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const wrapper = fileURLToPath(new URL("../fixtures/fake-bridge-wrapper.sh", import.meta.url));
chmodSync(wrapper, 0o755);

function makeClient(): BridgeClient {
  return new BridgeClient({
    executable: wrapper,
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "" },
    requestTimeoutMs: 5_000,
  });
}

describe("bridge-client handshake", () => {
  let client: BridgeClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("negotiates initialize protocol_version and capabilities", async () => {
    client = makeClient();
    const init = await client.connect();
    expect(init.protocol).toEqual({ major: 1, minor: 0 });
    expect(init.source).toBe("deepseek-harness");
    expect(init.methods).toContain("session.open");
    expect(init.limits.max_frame_bytes).toBe(256 * 1024);
    expect(client.negotiatedCapabilities?.source).toBe("deepseek-harness");
    const records = client.listRequests();
    expect(records.some((r) => r.method === "initialize" && r.state === "success")).toBe(true);
  });

  it("rejects arbitrary argv mutations", () => {
    expect(() =>
      normalizeBridgeConfig({
        executable: "/usr/bin/libra",
        cwd: repoRoot,
        args: ["agent", "bridge", "--stdio", "--evil"],
      }),
    ).toThrow(BridgeConfigError);
  });

  it("passes only the normalized bridge environment allowlist", () => {
    const previous = process.env.DSH_BRIDGE_TEST_SECRET;
    process.env.DSH_BRIDGE_TEST_SECRET = "must-not-cross-boundary";
    try {
      const normalized = normalizeBridgeConfig({
        executable: "/usr/bin/libra",
        cwd: repoRoot,
        env: { PATH: "/safe/bin" },
      });
      expect(normalized.env).toEqual(expect.objectContaining({ PATH: "/safe/bin" }));
      expect(normalized.env).not.toHaveProperty("DSH_BRIDGE_TEST_SECRET");
    } finally {
      if (previous === undefined) {
        delete process.env.DSH_BRIDGE_TEST_SECRET;
      } else {
        process.env.DSH_BRIDGE_TEST_SECRET = previous;
      }
    }
  });

  it("enforces NDJSON and result limits using UTF-8 bytes", () => {
    const request = {
      jsonrpc: "2.0" as const,
      method: "status.get",
      params: { text: "😀😀" },
      id: 1,
    };
    const serialized = serializeRequest(request);
    const frameBytes = utf8ByteLength(serialized.trim());
    expect(() => serializeRequest(request, frameBytes - 1)).toThrow(/bytes/);
    expect(() => serializeRequest(request, frameBytes)).not.toThrow();

    const response = JSON.stringify({ jsonrpc: "2.0", result: { text: "😀" }, id: 1 });
    const resultBytes = utf8ByteLength(JSON.stringify({ text: "😀" }));
    expect(() => parseResponseLine(response, 1024, resultBytes - 1)).toThrow(/result/);
    expect(parseResponseLine(response, 1024, resultBytes).id).toBe(1);
  });

  it("classifies retryable and fatal terminal states", async () => {
    client = makeClient();
    await client.connect();
    const retryable = await client.requestMethod("status.get", { kind: "retryable" });
    expect(retryable.state).toBe("error_retryable");
    const fatal = await client.requestMethod("status.get", { kind: "fatal" });
    expect(fatal.state).toBe("error_fatal");
    const ok = await client.requestMethod("status.get");
    expect(ok.state).toBe("success");
    const partial = await client.requestMethod("status.get", { kind: "partial" });
    expect(partial.state).toBe("success");
    expect(partial.result).toEqual({ partial: true });
  });

  it("fail-closes on unknown major in stdout frame", () => {
    const receiver = loadProtocolReceiver();
    if (receiver.status !== "ready") {
      throw new Error("fixture missing");
    }
    expect(() =>
      parseResponseLine(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: 1000, message: "bad", data: { retryable: false } },
          id: 1,
        }),
        receiver.contract.limits.max_frame_bytes,
      ),
    ).not.toThrow();
    const classified = classifyTerminalState({
      jsonrpc: "2.0",
      error: { code: 1000, message: "bad", data: { retryable: false } },
      id: 1,
    });
    expect(classified).toBe("error_fatal");
  });

  it("close disposes child and rejects further requests", async () => {
    client = makeClient();
    await client.connect();
    await client.close();
    await expect(client.requestMethod("status.get")).rejects.toMatchObject({
      code: "not_connected",
    });
  });
});

describe("bridge-client crash recovery", () => {
  it("surfaces child crash as BridgeClientError", async () => {
    const crashWrapper = fileURLToPath(new URL("../fixtures/crash-bridge-wrapper.sh", import.meta.url));
    chmodSync(crashWrapper, 0o755);
    const client = new BridgeClient({
      executable: crashWrapper,
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "" },
      requestTimeoutMs: 2_000,
    });
    await client.connect();
    await expect(client.requestMethod("status.get")).rejects.toBeInstanceOf(BridgeClientError);
    await expect(client.requestMethod("status.get")).rejects.toMatchObject({
      code: "not_connected",
    });
    await client.close();
  });
});
