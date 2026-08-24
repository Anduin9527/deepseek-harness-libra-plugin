import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { BridgeClient } from "@libra/dsh-bridge-client";
import {
  OutboxCorruptionError,
  OutboxStore,
  SessionProjectionService,
  redactPayload,
} from "@libra/dsh-session";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const wrapper = fileURLToPath(new URL("../fixtures/fake-bridge-wrapper.sh", import.meta.url));
chmodSync(wrapper, 0o755);

function makeProjection(): { service: SessionProjectionService; bridge: BridgeClient; outboxRoot: string } {
  const outboxRoot = mkdtempSync(join(tmpdir(), "dsh-outbox-"));
  const bridge = new BridgeClient({
    executable: wrapper,
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "" },
  });
  const service = new SessionProjectionService(new OutboxStore(outboxRoot), bridge);
  return { service, bridge, outboxRoot };
}

describe("session-projection", () => {
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("projects a batch through the bridge", async () => {
    const { service, bridge: client } = makeProjection();
    bridge = client;
    await bridge.connect();
    service.capture({
      session_id: "s1",
      event_seq: 1,
      event_type: "tool/result",
      payload: '{"tool":"libra_status","ok":true}',
    });
    const acked = await service.flush("s1");
    expect(acked).toBe(1);
    expect(service.resumeFromAck("s1")).toBe(1);
  });

  it("stores parent_session_id for subagent lineage", async () => {
    const { service, bridge: client, outboxRoot } = makeProjection();
    bridge = client;
    await bridge.connect();
    service.capture({
      session_id: "child",
      parent_session_id: "parent",
      event_seq: 1,
      event_type: "tool/result",
      payload: '{"ok":true}',
    });
    const outbox = new OutboxStore(outboxRoot);
    expect(outbox.load("child").parent_session_id).toBe("parent");
    await service.flush("child");
  });

  it("emits drain warning when dispose times out with pending events", async () => {
    const { service, bridge: client } = makeProjection();
    bridge = client;
    await bridge.connect();
    service.capture({
      session_id: "slow",
      event_seq: 1,
      event_type: "message",
      payload: '{"kind":"assistant"}',
    });
    const result = await service.dispose("slow", 0);
    expect(result.drained).toBe(false);
    expect(result.warnings.some((w) => w.includes("drain incomplete"))).toBe(true);
  });

  it("concurrent session limit does not pause other sessions", () => {
    const service = new SessionProjectionService(
      new OutboxStore(mkdtempSync(join(tmpdir(), "dsh-outbox-conc-"))),
      { connect: async () => ({}) } as unknown as BridgeClient,
      { maxConcurrentSessions: 1 },
    );
    service.capture({
      session_id: "s1",
      event_seq: 1,
      event_type: "message",
      payload: '{"a":1}',
    });
    expect(() =>
      service.capture({
        session_id: "s2",
        event_seq: 1,
        event_type: "message",
        payload: '{"b":1}',
      }),
    ).toThrow(/concurrent session limit/);
    expect(() =>
      service.capture({
        session_id: "s1",
        event_seq: 2,
        event_type: "message",
        payload: '{"a":2}',
      }),
    ).not.toThrow();
  });
});

describe("session-projection:duplicate-and-replay", () => {
  it("deduplicates identical (session_id,event_seq)", () => {
    const outbox = new OutboxStore(mkdtempSync(join(tmpdir(), "dsh-outbox-dup-")));
    const event = {
      session_id: "s1",
      event_seq: 1,
      event_type: "message",
      payload: '{"kind":"assistant"}',
    };
    outbox.enqueue(event);
    outbox.enqueue(event);
    const snapshot = outbox.load("s1");
    expect(snapshot.entries.filter((e) => e.event_seq === 1).length).toBe(1);
  });

  it("rejects corrupt snapshots and traversal session ids", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-outbox-corrupt-"));
    writeFileSync(join(root, "broken.outbox.json"), "{not-json", "utf8");
    const outbox = new OutboxStore(root);
    expect(() => outbox.load("broken")).toThrow(OutboxCorruptionError);
    expect(() => outbox.load("../escape")).toThrow(OutboxCorruptionError);
  });

  it("applies partial acknowledgements by per-event status", () => {
    const outbox = new OutboxStore(mkdtempSync(join(tmpdir(), "dsh-outbox-partial-")));
    for (const event_seq of [1, 2]) {
      outbox.enqueue({ session_id: "partial", event_seq, event_type: "message", payload: `event-${event_seq}` });
    }
    outbox.applyAppendResult("partial", 2, [
      { seq: 1, status: "accepted" },
      { seq: 2, status: "conflict" },
    ]);
    const snapshot = outbox.load("partial");
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.state).toBe("rejected");
    expect(snapshot.last_acked_seq).toBe(2);
  });
});

describe("session-projection:crash-and-resume", () => {
  it("resumes from last ack after reloading outbox", async () => {
    const outboxRoot = mkdtempSync(join(tmpdir(), "dsh-outbox-crash-"));
    const outbox = new OutboxStore(outboxRoot);
    outbox.enqueue({
      session_id: "s1",
      event_seq: 1,
      event_type: "message",
      payload: '{"kind":"assistant"}',
    });
    outbox.markAcked("s1", 1);
    const reloaded = new OutboxStore(outboxRoot);
    expect(reloaded.load("s1").last_acked_seq).toBe(1);
  });
});

describe("session-projection:redaction", () => {
  it("fail-closes on secret payloads", () => {
    const result = redactPayload('token sk-abcdefghijklmnopqrstuvwxyz');
    expect(result.ok).toBe(false);
  });

  it("prunes excess rejected diagnostic entries", () => {
    const outbox = new OutboxStore(mkdtempSync(join(tmpdir(), "dsh-outbox-rej-")), 1024 * 1024, 2);
    for (let i = 1; i <= 5; i++) {
      outbox.enqueue({
        session_id: "s1",
        event_seq: i,
        event_type: "message",
        payload: `sk-${"a".repeat(24)}`,
      });
    }
    outbox.markAcked("s1", 0);
    const snapshot = outbox.load("s1");
    expect(snapshot.entries.filter((e) => e.state === "rejected").length).toBeLessThanOrEqual(2);
  });
});
