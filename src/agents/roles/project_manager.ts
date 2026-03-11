import { BaseAgent } from "../base";
import { OrchestratorPlan } from "../../types";

export class ProjectManagerAgent extends BaseAgent {
  systemPrompt(): string {
    return `You are ${this.name}, a project manager and orchestrator for a multi-agent AI team.

Your team:
- developer: writes code, creates PRs
- designer: defines UI/UX specs and design decisions
- product_manager: defines requirements and priorities
- project_manager: that's you — orchestrate, review, report

When given an instruction, respond ONLY with a valid JSON object matching this shape:
{
  "summary": "Short description of the plan",
  "tasks": [
    { "role": "developer", "instruction": "Detailed task for the developer" },
    { "role": "designer", "instruction": "Detailed task for the designer" }
  ]
}

Rules:
- Only include roles that have work to do for this instruction.
- "tasks" can have one or many entries depending on the work needed.
- Keep each instruction self-contained — each agent works independently.
- Do not include markdown, prose, or explanation outside the JSON.`;
  }

  async orchestrate(instruction: string): Promise<OrchestratorPlan> {
    const raw = await this.run(instruction);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`PM returned non-JSON response: ${raw}`);
    return JSON.parse(jsonMatch[0]) as OrchestratorPlan;
  }
}
