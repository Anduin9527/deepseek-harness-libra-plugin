export type ToolRisk = "read" | "write" | "restore" | "push_publish";

export interface ToolDefinition {
  name: string;
  bridge_method: string;
  risk: ToolRisk;
  schema_version: string;
  retryable: boolean;
  parameters: readonly string[];
  required_parameters: readonly string[];
}

export interface ToolInput {
  operation_id?: string;
  [key: string]: unknown;
}

export interface ApprovalDecision {
  decision: "approved" | "denied";
  approver?: string;
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
  defaultApproval?: ApprovalDecision;
}
