declare module "@deepseek-ai/dsh-llm" {
  export interface TextBlock {
    readonly type: "text";
    readonly text: string;
  }

  export interface MessageSourceMap {
    user: { kind: "user" };
  }

  export type MessageSource = MessageSourceMap[keyof MessageSourceMap];

  export interface UserMessage {
    readonly id: string;
    readonly role: "user";
    readonly content: readonly TextBlock[];
    readonly source: MessageSource;
  }

}

declare module "@deepseek-ai/dsh-llm/message" {
  import type { MessageSource, TextBlock, UserMessage } from "@deepseek-ai/dsh-llm";

  export function createUserMessage(input: {
    readonly content: readonly TextBlock[];
    readonly source: MessageSource;
  }): UserMessage;
}

declare module "@deepseek-ai/dsh-session" {
  import type { UserMessage } from "@deepseek-ai/dsh-llm";

  export interface SessionEvent {
    readonly seq: number;
    readonly type: string;
    readonly data: unknown;
  }

  export interface Session {
    readonly id: string;
    readonly events: readonly SessionEvent[];
    readonly surface: {
      readonly replaceGeneration: number;
      readonly nodes: readonly number[];
    };
    append(type: "user/message", message: UserMessage, options: {
      surfaceOp: "append" | { op: "replace"; start: number; end: number };
      sourceEventSeqs?: number[];
    }): unknown;
  }
}
