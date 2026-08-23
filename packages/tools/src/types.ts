export type ToolRisk = "read" | "write" | "restore" | "push_publish";

export interface ToolDefinition {
  name: string;
  bridge_method: string;
  risk: ToolRisk;
  schema_version: string;
  retryable: boolean;
}

export interface ToolInput {
  operation_id?: string;
}

export interface ToolResult {
  schema_version: string;
  operation_id: string;
  status: "ok" | "error";
  data?: unknown;
  error?: {
    code: number;
    message: string;
    retryable: boolean;
    stable_code?: string;
  };
  warnings?: string[];
}

export interface ApprovalPolicy {
  allowRead: boolean;
  allowWrite: boolean;
  allowRestore: boolean;
  allowPushPublish: boolean;
}
