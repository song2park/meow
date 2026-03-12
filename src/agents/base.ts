import Anthropic from "@anthropic-ai/sdk";
import { redis } from "../queue";
import { Agent, AgentRole, AgentStatus } from "../types";

const anthropic = new Anthropic();

export abstract class BaseAgent {
  readonly id: string;
  readonly name: string;
  readonly role: AgentRole;
  readonly branch: string;

  constructor(agent: Agent) {
    this.id = agent.id;
    this.name = agent.name;
    this.role = agent.role;
    this.branch = agent.branch;
  }

  async getStatus(): Promise<AgentStatus> {
    const status = await redis.hget(`agent:${this.id}`, "status");
    return (status as AgentStatus) ?? "idle";
  }

  async getCurrentTask(): Promise<string | null> {
    return redis.hget(`agent:${this.id}`, "currentTask");
  }

  async setStatus(status: AgentStatus, currentTask?: string): Promise<void> {
    await redis.hset(`agent:${this.id}`, {
      status,
      currentTask: currentTask ?? "",
      name: this.name,
      role: this.role,
    });
  }

  async think(systemPrompt: string, userMessage: string): Promise<string> {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = response.content[0];
    if (block.type !== "text") throw new Error("Unexpected response type");
    return block.text;
  }

  abstract systemPrompt(): string;

  async run(instruction: string, context?: string): Promise<string> {
    const fullPrompt = context
      ? `${instruction}\n\nContext:\n${context}`
      : instruction;
    return this.think(this.systemPrompt(), fullPrompt);
  }
}
