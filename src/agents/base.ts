import Anthropic from "@anthropic-ai/sdk";
import { redis } from "../queue";
import { Agent, AgentOutput, AgentRole, AgentStatus } from "../types";
import { getAgentMemory, buildMemoryContext } from "./memory";

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

  async think(systemPrompt: string, userMessage: string, agentId?: string): Promise<string> {
    let fullSystemPrompt = systemPrompt;

    if (agentId) {
      const memory = await getAgentMemory(agentId);
      const memCtx = buildMemoryContext(memory);
      if (memCtx) {
        fullSystemPrompt = `${systemPrompt}\n\n## Your Past Work\n${memCtx}`;
      }
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: fullSystemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = response.content[0];
    if (block.type !== "text") throw new Error("Unexpected response type");
    return block.text;
  }

  abstract systemPrompt(): string;

  /**
   * Try to extract a structured JSON block (```json ... ```) from the response.
   * If the block contains { summary, files }, return it as AgentOutput.
   * Otherwise wrap the raw text as { summary: text }.
   */
  protected parseOutput(text: string): AgentOutput {
    const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1].trim()) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "summary" in parsed &&
          typeof (parsed as Record<string, unknown>).summary === "string"
        ) {
          const obj = parsed as { summary: string; files?: Array<{ filename: string; content: string }> };
          return {
            summary: obj.summary,
            files: Array.isArray(obj.files) ? obj.files : undefined,
          };
        }
      } catch {
        // Fall through to plain text path
      }
    }
    return { summary: text };
  }

  async run(instruction: string, context?: string): Promise<AgentOutput> {
    const fullPrompt = context
      ? `${instruction}\n\nContext:\n${context}`
      : instruction;
    const text = await this.think(this.systemPrompt(), fullPrompt, this.id);
    return this.parseOutput(text);
  }
}
