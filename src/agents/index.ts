import { Agent, AgentRole } from "../types";
import { BaseAgent } from "./base";
import { DeveloperAgent } from "./roles/developer";
import { DesignerAgent } from "./roles/designer";
import { ProductManagerAgent } from "./roles/product_manager";
import { ProjectManagerAgent } from "./roles/project_manager";
import { QAEngineerAgent } from "./roles/qa_engineer";
import { GenericAgent } from "./roles/generic";

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
    case "qa_engineer":
      return new QAEngineerAgent(agent);
    default:
      // Custom user-defined role — use BaseAgent with a generic prompt
      return new GenericAgent(agent);
  }
}

export { BaseAgent };
export type { AgentRole };
