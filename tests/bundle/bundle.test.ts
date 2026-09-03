import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";

import { apply, inject, name } from "@libra/dsh-bundle";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const wrapper = fileURLToPath(new URL("../fixtures/fake-bridge-wrapper.sh", import.meta.url));
chmodSync(wrapper, 0o755);

interface TestMessage {
  id: string;
  role: "user";
  content: Array<{ type: string; text?: string }>;
  source: Record<string, unknown> & { kind: string };
}

interface TestSession {
  id: string;
  events: Array<{ seq: number; type: string; data: TestMessage }>;
  surface: { replaceGeneration: number; nodes: number[] };
  appended: TestMessage[];
  append: (
    type: string,
    message: TestMessage,
    options: {
      surfaceOp: "append" | { op: "replace"; start: number; end: number };
      sourceEventSeqs?: number[];
    },
  ) => void;
}

type TestDecision =
  | { kind: "reject" }
  | { kind: "enter"; messages: TestMessage[] };

type PreStepListener = (
  payload: {
    agent: { session: TestSession };
    step: number;
    turn: number;
    signal: AbortSignal;
  },
  next: () => Promise<TestDecision>,
) => Promise<TestDecision>;

type RequestErrorListener = (
  payload: {
    agent: { session: TestSession };
    step?: number;
    turn: number;
    signal: AbortSignal;
  },
  next: () => Promise<{ kind: "retry" } | undefined>,
) => Promise<{ kind: "retry" } | undefined>;

type StoredListener = (...args: never[]) => unknown;

interface TestHarness {
  ctx: Context;
  listener(name: "agent/pre-step"): PreStepListener;
  listener(name: "agent/request-error"): RequestErrorListener;
  emit(name: "session/created" | "session/disposed", session: TestSession): void;
}

function makeSession(id: string): TestSession {
  const session: TestSession = {
    id,
    events: [],
    surface: { replaceGeneration: 0, nodes: [] },
    appended: [],
    append: (type, message, options) => {
      const sequence = session.events.length;
      session.events.push({ seq: sequence, type, data: message });
      session.appended.push(message);
      if (options.surfaceOp === "append") {
        session.surface.nodes.push(sequence);
        return;
      }
      const start = session.surface.nodes.indexOf(options.surfaceOp.start);
      const end = session.surface.nodes.indexOf(options.surfaceOp.end);
      if (start < 0 || end < start) throw new Error("invalid test surface replacement");
      session.surface.nodes.splice(start, end - start + 1, sequence);
      session.surface.replaceGeneration += 1;
    },
  };
  return session;
}

function user(text: string): TestMessage {
  return {
    id: `user-${text}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function makeContext(seed: TestSession[] = []): TestHarness {
  const listeners = new Map<string, StoredListener[]>();
  const ctx = {
    sessions: { list: () => [...seed] },
    logger: { warn: () => undefined },
    on: (event: string, listener: StoredListener) => {
      const entries = listeners.get(event) ?? [];
      entries.push(listener);
      listeners.set(event, entries);
      return () => {
        const index = entries.indexOf(listener);
        if (index >= 0) entries.splice(index, 1);
        return index >= 0;
      };
    },
  };

  function listener(event: "agent/pre-step"): PreStepListener;
  function listener(event: "agent/request-error"): RequestErrorListener;
  function listener(event: string): StoredListener {
    const entry = listeners.get(event)?.at(-1);
    if (!entry) throw new Error(`missing ${event} listener`);
    return entry;
  }

  return {
    ctx: ctx as unknown as Context,
    listener,
    emit: (event, session) => {
      for (const entry of listeners.get(event) ?? []) {
        (entry as unknown as (value: TestSession) => unknown)(session);
      }
    },
  };
}

function entered(decision: TestDecision): Extract<TestDecision, { kind: "enter" }> {
  if (decision.kind !== "enter") throw new Error("expected an enter decision");
  return decision;
}

function commitDecision(session: TestSession, decision: TestDecision): void {
  if (decision.kind === "reject") return;
  for (const message of decision.messages) {
    session.append("user/message", message, { surfaceOp: "append" });
  }
}

function visibleSourceKinds(session: TestSession): string[] {
  return session.surface.nodes.map((sequence) => session.events[sequence]?.data.source.kind ?? "missing");
}

describe("Cordis memory adapter", () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  it("exports the narrow DSH plugin interface", () => {
    expect(name).toBe("@libra-tools/dsh-bundle");
    expect(inject).toEqual(["agents", "sessions"]);
  });

  it("seeds an existing session, extracts accepted user text, and injects an exact snapshot", async () => {
    const session = makeSession("resume-s1");
    const harness = makeContext([session]);
    dispose = await apply(harness.ctx, {
      libraExecutable: wrapper,
      repositoryRoot: repoRoot,
    });
    const original: TestMessage[] = [
      user("first"),
      {
        id: "plugin-context",
        role: "user" as const,
        content: [{ type: "text", text: "ignore me" }],
        source: { kind: "plugin" },
      },
      user("second"),
    ];

    const decision = await harness.listener("agent/pre-step")(
      { agent: { session }, step: 1, turn: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: original }),
    );

    expect(decision.kind).toBe("enter");
    expect(entered(decision).messages.slice(0, 3)).toEqual(original);
    const memory = entered(decision).messages.at(-1);
    expect(memory.content).toEqual([{ type: "text", text: "Memory for first\nsecond" }]);
    expect(memory.source).toEqual(expect.objectContaining({
      kind: "libra-memory",
      receiptId: "receipt-resume-s1",
      selectedCount: 1,
      tokenBudget: 1600,
      form: "snapshot",
      sections: [{ name: "libra-memory", text: "Memory for first\nsecond" }],
    }));
  });

  it("does not recall after downstream rejection or cancellation", async () => {
    const session = makeSession("reject-s1");
    const harness = makeContext([session]);
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot });
    const preStep = harness.listener("agent/pre-step");

    await expect(preStep(
      { agent: { session }, step: 1, turn: 1, signal: new AbortController().signal },
      async () => ({ kind: "reject" }),
    )).resolves.toEqual({ kind: "reject" });

    const controller = new AbortController();
    controller.abort();
    const accepted: TestDecision = { kind: "enter", messages: [user("cancelled")] };
    await expect(preStep(
      { agent: { session }, step: 1, turn: 2, signal: controller.signal },
      async () => accepted,
    )).resolves.toEqual(accepted);
  });

  it("refreshes once after replaceGeneration changes and appends before overflow retry", async () => {
    const session = makeSession("compact-s1");
    const harness = makeContext([session]);
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot });
    const preStep = harness.listener("agent/pre-step");

    await preStep(
      { agent: { session }, step: 1, turn: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [user("remember compact")] }),
    );
    const refreshed = await preStep(
      { agent: { session }, step: 2, turn: 1, signal: new AbortController().signal },
      async () => {
        session.surface.replaceGeneration = 1;
        return { kind: "enter", messages: [] };
      },
    );
    expect(entered(refreshed).messages.at(-1)?.content[0]?.text).toBe("Memory for remember compact");

    const duplicate = await preStep(
      { agent: { session }, step: 3, turn: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [] }),
    );
    expect(entered(duplicate).messages).toEqual([]);

    const action = await harness.listener("agent/request-error")(
      { agent: { session }, step: 3, turn: 1, signal: new AbortController().signal },
      async () => {
        session.surface.replaceGeneration = 2;
        return { kind: "retry" };
      },
    );
    expect(action).toEqual({ kind: "retry" });
    expect(session.appended.at(-1)?.content[0]?.text).toBe("Memory for remember compact");
  });

  it("allows zero-hit delivery but fail-closes on invalid Memory content", async () => {
    const session = makeSession("edge-s1");
    const harness = makeContext([session]);
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot });
    const preStep = harness.listener("agent/pre-step");

    const firstHit = await preStep(
      { agent: { session }, step: 1, turn: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [user("retained-memory")] }),
    );
    commitDecision(session, firstHit);
    expect(visibleSourceKinds(session)).toContain("libra-memory");

    const zero = await preStep(
      { agent: { session }, step: 1, turn: 2, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [user("zero-hit")] }),
    );
    expect(entered(zero).messages).toHaveLength(1);
    expect(visibleSourceKinds(session)).not.toContain("libra-memory");
    expect(visibleSourceKinds(session)).toContain("libra-memory-clear");

    const secondHit = await preStep(
      { agent: { session }, step: 1, turn: 3, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [user("retained-again")] }),
    );
    commitDecision(session, secondHit);
    expect(visibleSourceKinds(session)).toContain("libra-memory");

    const noDelivery = await preStep(
      { agent: { session }, step: 1, turn: 4, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [user("null-delivery")] }),
    );
    expect(entered(noDelivery).messages).toHaveLength(1);
    expect(visibleSourceKinds(session)).not.toContain("libra-memory");
    expect(session.events.some((event) =>
      event.data.source.kind === "libra-memory"
      && event.data.content[0]?.text === "Memory for retained-again"
    )).toBe(true);

    await expect(preStep(
      { agent: { session }, step: 1, turn: 5, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [user("hash-mismatch")] }),
    )).rejects.toThrow(/bundle hash mismatch/);

    await expect(preStep(
      { agent: { session }, step: 1, turn: 6, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [user("empty-selection")] }),
    )).rejects.toThrow(/inconsistent selection content/);
  });

  it("fail-closes on bridge errors and does not refresh without a prior query", async () => {
    const session = makeSession("fail-closed-s1");
    const harness = makeContext([session]);
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot });
    const preStep = harness.listener("agent/pre-step");

    const noHistory = await preStep(
      { agent: { session }, step: 2, turn: 1, signal: new AbortController().signal },
      async () => {
        session.surface.replaceGeneration = 1;
        return { kind: "enter", messages: [] };
      },
    );
    expect(entered(noHistory).messages).toEqual([]);

    await expect(preStep(
      { agent: { session }, step: 1, turn: 2, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [user("bridge-error")] }),
    )).rejects.toThrow(/LBR-MEMORY-005/);
  });

  it("retires disposed sessions without treating plugin unload as session close", async () => {
    const live = makeSession("live-s1");
    const retired = makeSession("retired-s1");
    const harness = makeContext([live, retired]);
    dispose = await apply(harness.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot });
    const preStep = harness.listener("agent/pre-step");
    await preStep(
      { agent: { session: retired }, step: 1, turn: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [user("open retirement")] }),
    );
    harness.emit("session/disposed", retired);

    await dispose();
    dispose = undefined;

    const remounted = makeContext([live]);
    dispose = await apply(remounted.ctx, { libraExecutable: wrapper, repositoryRoot: repoRoot });
    await expect(remounted.listener("agent/pre-step")(
      { agent: { session: live }, step: 1, turn: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [user("resume after HMR")] }),
    )).resolves.toMatchObject({ kind: "enter" });
  });
});
