// Built-in roles — extended dynamically via /add-role
export type BuiltinRole = "developer" | "designer" | "product_manager" | "project_manager" | "qa_engineer";
export type AgentRole = BuiltinRole | string;

export type AgentStatus = "idle" | "busy";

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  currentTask?: string;
  branch: string; // git branch: agent/<name>
}

export interface AgentTask {
  id: string;
  agentId: string;
  instruction: string;
  context?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  createdAt: Date;
  completedAt?: Date;
}

export interface JobPayload {
  taskId: string;
  agentId: string;
  instruction: string;
  context?: string;
  slackChannel: string;
  slackThreadTs?: string;
}

export interface OrchestratorTask {
  role: AgentRole;
  instruction: string;
}

export interface OrchestratorPlan {
  summary: string;
  tasks: OrchestratorTask[];
}
