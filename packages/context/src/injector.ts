import { redactPayload } from "@libra/dsh-session";
import { utf8ByteLength } from "@libra/dsh-bridge-client";
import type { ToolsFacade } from "@libra/dsh-tools";

export interface ContextAnchor {
  anchor_id: string;
  source: string;
  schema_version: string;
  token_budget: number;
}

export interface ContextSlice {
  text: string;
  anchor: ContextAnchor;
  warnings: string[];
}

export interface ContextHost {
  injectContext?: (input: {
    session_id: string;
    text: string;
    anchor: ContextAnchor;
  }) => Promise<void> | void;
}

export interface ContextInjectorOptions {
  host?: ContextHost;
  maxTokens?: number;
  maxBytes?: number;
}

interface ContextPart {
  source: string;
  priority: number;
  privacy: "public" | "internal" | "sensitive";
  text: string;
}

const PRIVACY_RANK: Record<ContextPart["privacy"], number> = {
  public: 0,
  internal: 1,
  sensitive: 2,
};

export class ContextInjector {
  private readonly tools: ToolsFacade;
  private readonly host: ContextHost | undefined;
  private readonly maxTokens: number;
  private readonly maxBytes: number;
  private readonly anchors: Map<string, ContextAnchor> = new Map();

  constructor(tools: ToolsFacade, options?: ContextInjectorOptions) {
    this.tools = tools;
    this.host = options?.host;
    this.maxTokens = options?.maxTokens ?? 1500;
    this.maxBytes = options?.maxBytes ?? 4096;
  }

  async inject(sessionId: string, intent?: string, checkpointId?: string): Promise<ContextSlice> {
    const result = await this.tools.invoke("libra_context", {
      session_id: sessionId,
      ...(intent ? { intent } : {}),
      ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
    });
    if (result.status === "error") {
      return {
        text: "",
        anchor: {
          anchor_id: sessionId,
          source: "libra_context",
          schema_version: "1",
          token_budget: 0,
        },
        warnings: [result.error?.message ?? "context query failed"],
      };
    }
    const parts = this.extractParts(result.data);
    const { text, warnings } = this.truncateParts(parts);
    const anchor: ContextAnchor = {
      anchor_id: `${sessionId}:${intent ?? "default"}`,
      source: "libra_context",
      schema_version: "1",
      token_budget: Math.min(this.maxTokens, Math.ceil(utf8ByteLength(text) / 4)),
    };
    this.anchors.set(sessionId, anchor);
    if (this.host?.injectContext) {
      try {
        await this.host.injectContext({ session_id: sessionId, text, anchor });
      } catch (error) {
        warnings.push(`context injection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { text, anchor, warnings };
  }

  async resumeAfterCompactionAsync(
    sessionId: string,
    parentSessionId: string,
    intent = "resume",
  ): Promise<ContextSlice | undefined> {
    if (!this.anchors.has(parentSessionId)) {
      return undefined;
    }
    return this.inject(sessionId, intent);
  }

  disposeSession(sessionId: string): void {
    this.anchors.delete(sessionId);
  }

  dispose(): void {
    this.anchors.clear();
  }

  resumeAfterCompaction(sessionId: string, parentSessionId: string): ContextAnchor | undefined {
    const parent = this.anchors.get(parentSessionId);
    if (!parent) {
      return undefined;
    }
    const resumed: ContextAnchor = {
      ...parent,
      anchor_id: `${sessionId}:resume:${parent.anchor_id}`,
    };
    this.anchors.set(sessionId, resumed);
    return resumed;
  }

  private extractParts(data: unknown): ContextPart[] {
    if (!data || typeof data !== "object") {
      return [{ source: "libra_context", priority: 1, privacy: "internal", text: JSON.stringify(data ?? {}) }];
    }
    const record = data as Record<string, unknown>;
    const parts: ContextPart[] = [];
    const buckets: Array<{ key: string; priority: number; privacy: ContextPart["privacy"] }> = [
      { key: "sessions", priority: 1, privacy: "internal" },
      { key: "recent_checkpoints", priority: 2, privacy: "internal" },
      { key: "history", priority: 1, privacy: "internal" },
      { key: "decisions", priority: 2, privacy: "internal" },
      { key: "evidence", priority: 3, privacy: "public" },
      { key: "skills", priority: 4, privacy: "public" },
      { key: "sensitive", priority: 5, privacy: "sensitive" },
    ];
    for (const bucket of buckets) {
      const value = record[bucket.key];
      if (value === undefined) {
        continue;
      }
      parts.push({
        source: bucket.key,
        priority: bucket.priority,
        privacy: bucket.privacy,
        text: typeof value === "string" ? value : JSON.stringify(value),
      });
    }
    if (parts.length === 0) {
      parts.push({
        source: "libra_context",
        priority: 1,
        privacy: "internal",
        text: JSON.stringify(record),
      });
    }
    return parts;
  }

  private truncateParts(parts: ContextPart[]): { text: string; warnings: string[] } {
    const warnings: string[] = [];
    const sorted = [...parts].sort((a, b) => {
      const privacyDiff = PRIVACY_RANK[a.privacy] - PRIVACY_RANK[b.privacy];
      if (privacyDiff !== 0) {
        return privacyDiff;
      }
      return a.priority - b.priority;
    });
    const redactedParts: string[] = [];
    let bytes = 0;
    for (const part of sorted) {
      const redacted = redactPayload(part.text);
      if (!redacted.ok) {
        warnings.push(`${part.source}: redaction failed (${redacted.reason})`);
        continue;
      }
      const slice = redacted.payload;
      const nextBytes = bytes + utf8ByteLength(slice);
      if (nextBytes > this.maxBytes) {
        warnings.push(`${part.source}: truncated by byte budget`);
        const remaining = this.maxBytes - bytes;
        if (remaining > 0) {
          redactedParts.push(sliceByUtf8Bytes(slice, remaining));
          bytes = this.maxBytes;
        }
        break;
      }
      redactedParts.push(slice);
      bytes = nextBytes;
    }
    let text = redactedParts.join("\n");
    const tokenEstimate = Math.ceil(utf8ByteLength(text) / 4);
    if (tokenEstimate > this.maxTokens) {
      warnings.push("context truncated by token budget");
      text = sliceByUtf8Bytes(text, this.maxTokens * 4);
    }
    return { text, warnings };
  }
}

function sliceByUtf8Bytes(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) {
    return value;
  }
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && utf8ByteLength(value.slice(0, end)) > maxBytes) {
    end--;
  }
  return value.slice(0, end);
}
