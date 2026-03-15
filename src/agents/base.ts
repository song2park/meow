import Anthropic from "@anthropic-ai/sdk";
import { redis } from "../queue";
import { Agent, AgentOutput, AgentRole, AgentStatus } from "../types";
import { getAgentMemory, getAgentFiles, buildMemoryContext } from "./memory";

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

  async think(systemPrompt: string, userMessage: string, agentId?: string, agentName?: string): Promise<string> {
    let fullSystemPrompt = systemPrompt;

    if (agentId || agentName) {
      const [memory, files] = await Promise.all([
        agentId ? getAgentMemory(agentId) : Promise.resolve([]),
        agentName ? getAgentFiles(agentName) : Promise.resolve([]),
      ]);
      const memCtx = buildMemoryContext(memory, files);
      if (memCtx) {
        fullSystemPrompt = `${systemPrompt}\n\n## Your Past Work\n${memCtx}`;
      }
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: fullSystemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = response.content[0];
    if (block.type !== "text") throw new Error("Unexpected response type");
    return block.text;
  }

  abstract systemPrompt(): string;

  protected parseOutput(text: string): AgentOutput {
    // Format: conversational text first, then optional <FILES>[...]</FILES>
    const filesMarker = text.indexOf("<FILES>");
    if (filesMarker !== -1) {
      const summary = text.slice(0, filesMarker).trim();
      const filesBlock = text.match(/<FILES>\s*([\s\S]*?)\s*<\/FILES>/);
      if (filesBlock) {
        try {
          const files = JSON.parse(filesBlock[1]) as Array<{ filename: string; content: string }>;
          if (Array.isArray(files)) return { summary, files };
        } catch {
          // malformed JSON — return summary only
        }
      }
      return { summary };
    }

    // Plain text fallback — first paragraph only, max 400 chars
    const firstParagraph = text.split(/\n\n+/).find((p) => p.trim().length > 0) ?? text;
    const summary = firstParagraph.length > 400
      ? firstParagraph.slice(0, 400).trimEnd() + "…"
      : firstParagraph;
    return { summary };
  }

  async run(instruction: string, context?: string): Promise<AgentOutput> {
    const fullPrompt = context
      ? `${instruction}\n\nContext:\n${context}`
      : instruction;
    const text = await this.think(this.systemPrompt(), fullPrompt, this.id, this.name);
    return this.parseOutput(text);
  }
}
