export type AgentRole = "developer" | "designer" | "product_manager" | "project_manager";

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
