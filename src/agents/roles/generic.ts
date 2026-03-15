import { BaseAgent } from "../base";

export class GenericAgent extends BaseAgent {
  systemPrompt(): string {
    return `You are ${this.name}, a ${this.role} agent in a multi-agent team.
Complete the task you are given, report what you did clearly, and flag any blockers or questions for the team.
Be concise and actionable.

When you produce file artifacts, wrap your response in a JSON block:
\`\`\`json
{
  "summary": "what you did",
  "files": [
    { "filename": "output.md", "content": "..." }
  ]
}
\`\`\`
If no files are produced, respond in plain text with a SHORT summary only (2-3 sentences max). Never paste file contents into your plain text response — file contents belong only inside the JSON block.`;
  }
}
