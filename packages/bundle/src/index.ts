import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm/message";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { BridgeClient } from "@libra/dsh-bridge-client";
import type { CompletedRequest } from "@libra/dsh-bridge-client";

/** Cordis identity used by the DSH loader. */
export const name = "@libra-tools/dsh-bundle";

/** Only the two lifecycle services used by this adapter are required. */
export const inject = ["agents", "sessions"];

/** Deployment-owned locations. Memory policy remains server-owned by Libra. */
export interface Config {
  libraExecutable?: string;
  repositoryRoot?: string;
}

export const Config: z<Config> = z.object({
  libraExecutable: z.string(),
  repositoryRoot: z.string(),
});

interface LibraMemorySource {
  kind: "libra-memory";
  receiptId: string;
  viewHash: string;
  bundleHash: string;
  selectedCount: number;
  tokenBudget: number;
  form: "snapshot";
  sections: readonly [{ readonly name: "libra-memory"; readonly text: string }];
}

interface LibraMemoryClearSource {
  kind: "libra-memory-clear";
  form: "snapshot";
  sections: readonly [{ readonly name: "libra-memory"; readonly text: string }];
}

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "libra-memory": LibraMemorySource;
    "libra-memory-clear": LibraMemoryClearSource;
  }
}

interface MemoryDelivery {
  promptSection: string;
  receiptId: string;
  viewHash: string;
  bundleHash: string;
  selectedCount: number;
  tokenBudget: number;
}

interface LiveSessionState {
  session: Session;
  opened: boolean;
  opening: Promise<void> | undefined;
  lastQuery: string | undefined;
  lastRefreshTurn: number | undefined;
  lastRefreshGeneration: number | undefined;
  retiring: Promise<void> | undefined;
}

interface ResolvedConfig {
  libraExecutable: string;
  repositoryRoot: string;
}

type PreStepDecision =
  | { kind: "reject" }
  | { kind: "enter"; messages: UserMessage[] };

type RequestErrorAction = { kind: "retry" } | undefined;

interface AdapterAgent {
  readonly session: Session;
}

interface AdapterContext {
  readonly sessions: { list(): Session[] };
  readonly logger: { warn(message: string): unknown };
  on(event: "session/created" | "session/disposed", listener: (session: Session) => void): () => unknown;
  on(
    event: "agent/pre-step",
    listener: (
      payload: { agent: AdapterAgent; step: number; turn: number; signal: AbortSignal },
      next: () => Promise<PreStepDecision>,
    ) => Promise<PreStepDecision>,
    options: { prepend: true },
  ): () => unknown;
  on(
    event: "agent/request-error",
    listener: (
      payload: { agent: AdapterAgent; turn: number; signal: AbortSignal },
      next: () => Promise<RequestErrorAction>,
    ) => Promise<RequestErrorAction>,
  ): () => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`memory.recall returned an invalid ${label}`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`memory.recall returned an invalid ${label}`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) {
    throw new Error(`memory.recall returned an invalid ${label}`);
  }
  return text;
}

function requireNatural(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`memory.recall returned an invalid ${label}`);
  }
  return value;
}

function parseDelivery(result: unknown): MemoryDelivery | null {
  if (!isRecord(result)) throw new Error("memory.recall returned an invalid envelope");
  assertExactKeys(result, ["schema_version", "data"], "envelope");
  if (result.schema_version !== 1 || !isRecord(result.data)) {
    throw new Error("memory.recall returned an unsupported schema version");
  }
  assertExactKeys(result.data, ["delivery"], "data envelope");
  if (result.data.delivery === null) return null;
  if (!isRecord(result.data.delivery)) throw new Error("memory.recall returned an invalid delivery");
  const delivery = result.data.delivery;
  assertExactKeys(delivery, [
    "prompt_section",
    "receipt_id",
    "view_hash",
    "bundle_hash",
    "selected_count",
    "token_budget",
  ], "delivery");
  if (typeof delivery.prompt_section !== "string") {
    throw new Error("memory.recall returned an invalid prompt_section");
  }
  const parsed: MemoryDelivery = {
    promptSection: delivery.prompt_section,
    receiptId: requireString(delivery.receipt_id, "receipt_id"),
    viewHash: requireSha256(delivery.view_hash, "view_hash"),
    bundleHash: requireSha256(delivery.bundle_hash, "bundle_hash"),
    selectedCount: requireNatural(delivery.selected_count, "selected_count"),
    tokenBudget: requireNatural(delivery.token_budget, "token_budget"),
  };
  if (parsed.tokenBudget !== 1600) {
    throw new Error("memory.recall returned an unexpected token_budget");
  }
  if ((parsed.selectedCount === 0) !== (parsed.promptSection.length === 0)) {
    throw new Error("memory.recall returned inconsistent selection content");
  }
  const calculated = `sha256:${createHash("sha256").update(Buffer.from(parsed.promptSection, "utf8")).digest("hex")}`;
  if (calculated !== parsed.bundleHash) {
    throw new Error("memory.recall bundle hash mismatch");
  }
  return parsed;
}

function completedResult(request: CompletedRequest): unknown {
  if (request.state === "success" && request.error === undefined) return request.result;
  const stableCode = request.error?.data?.stable_code ?? "LBR-AGENT-UNKNOWN";
  const retryable = request.error?.data?.retryable === true;
  throw new Error(`${request.method} failed (${stableCode}, retryable=${String(retryable)})`);
}

function memoryMessage(delivery: MemoryDelivery): UserMessage {
  const text = delivery.promptSection;
  return createUserMessage({
    content: [{ type: "text", text }],
    source: {
      kind: "libra-memory",
      receiptId: delivery.receiptId,
      viewHash: delivery.viewHash,
      bundleHash: delivery.bundleHash,
      selectedCount: delivery.selectedCount,
      tokenBudget: delivery.tokenBudget,
      form: "snapshot",
      sections: [{ name: "libra-memory", text }],
    },
  });
}

const MEMORY_CLEAR_TEXT = "Libra Memory snapshot cleared. Earlier Libra Memory snapshots no longer apply.";

function memoryClearMessage(): UserMessage {
  return createUserMessage({
    content: [{ type: "text", text: MEMORY_CLEAR_TEXT }],
    source: {
      kind: "libra-memory-clear",
      form: "snapshot",
      sections: [{ name: "libra-memory", text: MEMORY_CLEAR_TEXT }],
    },
  });
}

function visibleMemorySequences(session: Session): number[] {
  return session.surface.nodes.filter((sequence) => {
    const event = session.events[sequence];
    return event?.type === "user/message"
      && isRecord(event.data)
      && isRecord(event.data.source)
      && event.data.source.kind === "libra-memory";
  });
}

function retireVisibleMemory(session: Session): void {
  for (const sequence of visibleMemorySequences(session)) {
    session.append("user/message", memoryClearMessage(), {
      surfaceOp: { op: "replace", start: sequence, end: sequence },
      sourceEventSeqs: [sequence],
    });
  }
}

function acceptedUserQuery(messages: readonly UserMessage[]): string | undefined {
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.source.kind !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text") blocks.push(block.text);
    }
  }
  return blocks.length === 0 ? undefined : blocks.join("\n");
}

async function resolveConfig(config: Config): Promise<ResolvedConfig> {
  const configuredBinary = config.libraExecutable ?? process.env.LIBRA_BINARY;
  if (!configuredBinary) {
    throw new Error("libraExecutable or LIBRA_BINARY must be configured");
  }
  if (!isAbsolute(configuredBinary)) {
    throw new Error("libraExecutable must be an absolute path");
  }
  const libraExecutable = await realpath(configuredBinary);
  const executableStat = await stat(libraExecutable);
  if (!executableStat.isFile()) throw new Error("libraExecutable must name a file");
  await access(libraExecutable, constants.X_OK);

  const configuredRepository = config.repositoryRoot ?? process.env.LIBRA_REPO ?? process.cwd();
  const repositoryRoot = await realpath(resolve(configuredRepository));
  const repositoryStat = await stat(repositoryRoot);
  if (!repositoryStat.isDirectory()) throw new Error("repositoryRoot must name a directory");
  return { libraExecutable, repositoryRoot };
}

/**
 * Mount one bridge-backed Memory recall adapter into a real Cordis composition.
 * The returned disposer preserves still-live DSH sessions across HMR.
 */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const adapterCtx = ctx as unknown as AdapterContext;
  const resolved = await resolveConfig(config);
  const bridge = new BridgeClient({
    executable: resolved.libraExecutable,
    cwd: resolved.repositoryRoot,
    env: {
      PATH: process.env.PATH ?? "",
      LIBRA_SKIP_WEB_BUILD: "1",
    },
  });
  let stopping = false;
  const sessions = new Map<string, LiveSessionState>();
  const retirements = new Set<Promise<void>>();
  const listenerDisposers: Array<() => unknown> = [];

  const trackSession = (session: Session): LiveSessionState => {
    const id = String(session.id);
    const existing = sessions.get(id);
    if (existing !== undefined) {
      existing.session = session;
      return existing;
    }
    const created: LiveSessionState = {
      session,
      opened: false,
      opening: undefined,
      lastQuery: undefined,
      lastRefreshTurn: undefined,
      lastRefreshGeneration: undefined,
      retiring: undefined,
    };
    sessions.set(id, created);
    return created;
  };

  const openSession = async (state: LiveSessionState): Promise<void> => {
    if (stopping) throw new Error("Libra Memory adapter is stopping");
    if (state.retiring !== undefined) throw new Error("DSH session is retiring");
    if (state.opened) return;
    if (state.opening !== undefined) return state.opening;
    const id = String(state.session.id);
    const opening = bridge.requestMethod("session.open", { session_id: id })
      .then((request) => {
        completedResult(request);
        state.opened = true;
      })
      .finally(() => {
        if (state.opening === opening) state.opening = undefined;
      });
    state.opening = opening;
    return opening;
  };

  const recall = async (state: LiveSessionState, queryText: string): Promise<MemoryDelivery | null> => {
    await openSession(state);
    const result = completedResult(await bridge.requestMethod("memory.recall", {
      session_id: String(state.session.id),
      query_text: queryText,
    }));
    return parseDelivery(result);
  };

  const markRefreshed = (state: LiveSessionState, turn: number, generation: number): void => {
    state.lastRefreshTurn = turn;
    state.lastRefreshGeneration = generation;
  };

  const alreadyRefreshed = (state: LiveSessionState, turn: number, generation: number): boolean =>
    state.lastRefreshTurn === turn && state.lastRefreshGeneration === generation;

  const retire = (session: Session): void => {
    const state = sessions.get(String(session.id));
    if (state === undefined || state.retiring !== undefined) return;
    const retirement = (async () => {
      try {
        await state.opening;
        if (state.opened) {
          completedResult(await bridge.requestMethod("session.close", {
            session_id: String(session.id),
          }));
        }
      } finally {
        sessions.delete(String(session.id));
      }
    })();
    state.retiring = retirement;
    retirements.add(retirement);
    const forget = (): void => {
      retirements.delete(retirement);
    };
    void retirement.then(forget, forget);
    void retirement.catch((error: unknown) => {
      adapterCtx.logger.warn(`libra-memory: session retirement failed: ${String(error)}`);
    });
  };

  try {
    const negotiated = await bridge.connect();
    if (!negotiated.methods.includes("memory.recall")) {
      throw new Error("Libra bridge does not advertise memory.recall");
    }

    listenerDisposers.push(adapterCtx.on("session/created", (session) => {
      if (!stopping) trackSession(session);
    }));
    listenerDisposers.push(adapterCtx.on("session/disposed", (session) => {
      if (!stopping) retire(session);
    }));
    listenerDisposers.push(adapterCtx.on("agent/pre-step", async (
      { agent, step, turn, signal },
      next,
    ): Promise<PreStepDecision> => {
      const beforeGeneration = agent.session.surface.replaceGeneration;
      const decision = await next();
      if (decision.kind === "reject" || signal.aborted) return decision;
      const state = trackSession(agent.session);
      const generation = agent.session.surface.replaceGeneration;
      let queryText: string | undefined;
      let refreshDue = false;
      if (step === 1) {
        refreshDue = true;
        queryText = acceptedUserQuery(decision.messages);
        state.lastQuery = queryText;
      } else if (generation > beforeGeneration) {
        refreshDue = true;
        queryText = state.lastQuery;
      }
      if (!refreshDue || alreadyRefreshed(state, turn, generation)) return decision;
      const delivery = queryText === undefined ? null : await recall(state, queryText);
      if (signal.aborted) return decision;
      retireVisibleMemory(state.session);
      markRefreshed(state, turn, state.session.surface.replaceGeneration);
      if (delivery === null || delivery.promptSection.length === 0) return decision;
      return { kind: "enter", messages: [...decision.messages, memoryMessage(delivery)] };
    }, { prepend: true }));
    listenerDisposers.push(adapterCtx.on("agent/request-error", async (
      { agent, turn, signal },
      next,
    ): Promise<RequestErrorAction> => {
      const beforeGeneration = agent.session.surface.replaceGeneration;
      const action = await next();
      const generation = agent.session.surface.replaceGeneration;
      if (signal.aborted || action?.kind !== "retry" || generation <= beforeGeneration) return action;
      const state = trackSession(agent.session);
      if (state.lastQuery === undefined || alreadyRefreshed(state, turn, generation)) return action;
      const delivery = await recall(state, state.lastQuery);
      if (signal.aborted) return action;
      retireVisibleMemory(state.session);
      if (delivery !== null && delivery.promptSection.length > 0) {
        agent.session.append("user/message", memoryMessage(delivery), { surfaceOp: "append" });
      }
      markRefreshed(state, turn, state.session.surface.replaceGeneration);
      return action;
    }));

    for (const session of adapterCtx.sessions.list()) trackSession(session);
  } catch (error) {
    for (const dispose of listenerDisposers.reverse()) dispose();
    await bridge.close().catch(() => undefined);
    throw error;
  }

  return async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    for (const dispose of listenerDisposers.reverse()) dispose();
    await Promise.allSettled([...retirements]);
    await bridge.close();
  };
}
