import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import type { Agent } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { mountAgentLoopTestDependencies } from "@deepseek-ai/dsh-agent-loop-testkit";
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";

class CaptureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const text = "captured";
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "usage", usage: { inputTokens: 8, outputTokens: 1 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on("agent/status", ({ agent: subject, status }) => {
      if (subject === agent && status === "idle") {
        dispose();
        resolve();
      }
    });
  });
}

function memoryMessage(messages: readonly Message[]): Message | undefined {
  return messages.find((message) => message.source.kind === "libra-memory");
}

function messageText(message: Message): string {
  return message.content
    .map((block) => block.type === "text" ? block.text : "")
    .join("");
}

interface LibraMemorySource {
  kind: "libra-memory";
  receiptId: string;
  viewHash: string;
  bundleHash: string;
  selectedCount: number;
  tokenBudget: number;
  form: "snapshot";
  sections: Array<{ name: "libra-memory"; text: string }>;
}

describe("DSH alpha.1 runtime gate", () => {
  let ctx: Context | undefined;

  afterEach(async () => {
    await ctx?.fiber.dispose();
    ctx = undefined;
  });

  it("loads the bundle through the real Loader and injects the exact snapshot into Session and AgentLoop", async () => {
    const libraExecutable = process.env.LIBRA_BINARY ?? process.env.LIBRA_FAKE_BRIDGE;
    const repositoryRoot = process.env.LIBRA_REPO;
    if (!libraExecutable || !repositoryRoot) {
      throw new Error("LIBRA_BINARY (or LIBRA_FAKE_BRIDGE) and LIBRA_REPO are required");
    }
    const query = process.env.LIBRA_GATE_QUERY ?? "unique gate fact";
    const expectedSubstring =
      process.env.LIBRA_GATE_EXPECTED_SUBSTRING ?? "Memory for unique gate fact";
    const sessionId = process.env.LIBRA_GATE_SESSION_ID ?? "libra-dsh-alpha1-gate";

    ctx = new Context();
    await mountAgentLoopTestDependencies(ctx);
    await ctx.plugin(AgentLoop, { agents: [] });
    const capture = new CaptureAdapter();
    ctx.llm.registerAdapter(["capture"], capture);

    await ctx.plugin(Loader, { baseUrl: import.meta.url });
    const entryId = await ctx.loader.create({
      name: "@libra-tools/dsh-bundle",
      config: { libraExecutable, repositoryRoot },
    });
    await ctx.loader.await();
    expect(ctx.loader.resolve(entryId)?.fiber).toBeDefined();

    const agent = ctx.agentLoop.create(SessionId(sessionId), {
      provider: "capture",
      model: "capture",
    });
    agent.followup(createUserMessage({
      content: [{ type: "text", text: query }],
      source: { kind: "user" },
    }));
    await waitForIdle(ctx, agent);

    expect(capture.requests).toHaveLength(1);
    const requestMemory = memoryMessage(capture.requests[0]!.messages);
    expect(requestMemory).toBeDefined();

    const loggedMessages = agent.session.events
      .filter((event) => event.type === "user/message")
      .map((event) => event.data as Message);
    const sessionMemory = memoryMessage(loggedMessages);
    expect(sessionMemory).toBeDefined();

    const requestText = messageText(requestMemory!);
    expect(requestText).toContain(expectedSubstring);
    expect(sessionMemory!.content).toEqual(requestMemory!.content);
    expect(sessionMemory).toEqual(requestMemory);
    const source = requestMemory!.source as unknown as LibraMemorySource;
    expect(requestMemory!.source).toMatchObject({
      kind: "libra-memory",
      selectedCount: 1,
      tokenBudget: 1600,
      form: "snapshot",
      sections: [{ name: "libra-memory", text: requestText }],
    });
    expect(source.receiptId).not.toHaveLength(0);
    expect(source.bundleHash).toBe(
      `sha256:${createHash("sha256").update(requestText, "utf8").digest("hex")}`,
    );
    const receipt = {
      kind: "libra-gate-receipt",
      receiptId: source.receiptId,
      bundleHash: source.bundleHash,
      selectedCount: source.selectedCount,
      tokenBudget: source.tokenBudget,
    };
    console.info(JSON.stringify(receipt));
    if (process.env.LIBRA_GATE_RECEIPT_FILE) {
      writeFileSync(process.env.LIBRA_GATE_RECEIPT_FILE, JSON.stringify(receipt));
    }

    await ctx.loader.remove(entryId);
    await ctx.loader.await();
  });
});
