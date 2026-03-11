import { BaseAgent } from "../base";

export class GenericAgent extends BaseAgent {
  systemPrompt(): string {
    return `You are ${this.name}, a ${this.role} agent in a multi-agent team.
Complete the task you are given, report what you did clearly, and flag any blockers or questions for the team.
Be concise and actionable.`;
  }
}
