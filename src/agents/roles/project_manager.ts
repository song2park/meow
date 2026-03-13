import { z } from "zod";
import { BaseAgent } from "../base";
import { OrchestratorPlan } from "../../types";

const PlanSchema = z.object({
  summary: z.string(),
  tasks: z.array(
    z.object({
      role: z.string(),
      instruction: z.string(),
    })
  ),
});

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

  static parse(response: string): OrchestratorPlan {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("PM_PARSE_FAILED: No JSON object found in response");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (err) {
      throw new Error(`PM_PARSE_FAILED: Invalid JSON — ${(err as Error).message}`);
    }

    const result = PlanSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`PM_PARSE_FAILED: Schema validation failed — ${result.error.message}`);
    }

    return result.data;
  }

  async orchestrate(instruction: string): Promise<OrchestratorPlan> {
    const output = await this.run(instruction);
    return ProjectManagerAgent.parse(output.summary);
  }
}
