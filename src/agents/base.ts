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

  /**
   * Try to extract a structured JSON block (```json ... ```) from the response.
   * If the block contains { summary, files }, return it as AgentOutput.
   * Otherwise wrap the raw text as { summary: text }.
   */
  protected parseOutput(text: string): AgentOutput {
    // 1. Try fenced code block: ```json ... ```
    // 2. Try truncated block (response cut off before closing ```): ```json ... EOF
    // 3. Try raw JSON object anywhere in the text
    const candidates: string[] = [];

    const fencedMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (fencedMatch) candidates.push(fencedMatch[1].trim());

    const truncatedMatch = text.match(/```json\s*([\s\S]+)$/);
    if (truncatedMatch) candidates.push(truncatedMatch[1].trim());

    const rawJsonMatch = text.match(/(\{[\s\S]*\})/);
    if (rawJsonMatch) candidates.push(rawJsonMatch[1].trim());

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
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
        // Try next candidate
      }
    }

    // Plain text fallback — first paragraph only, max 400 chars for Slack.
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
