import { Agent, AgentRole } from "../types";
import { BaseAgent } from "./base";
import { DeveloperAgent } from "./roles/developer";
import { DesignerAgent } from "./roles/designer";
import { ProductManagerAgent } from "./roles/product_manager";
import { ProjectManagerAgent } from "./roles/project_manager";

export function createAgent(agent: Agent): BaseAgent {
  switch (agent.role) {
    case "developer":
      return new DeveloperAgent(agent);
    case "designer":
      return new DesignerAgent(agent);
    case "product_manager":
      return new ProductManagerAgent(agent);
    case "project_manager":
      return new ProjectManagerAgent(agent);
    default:
      throw new Error(`Unknown role: ${agent.role satisfies never}`);
  }
}

export { BaseAgent };
export type { AgentRole };
