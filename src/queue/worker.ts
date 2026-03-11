import { Job } from "bullmq";
import { createWorker, agentQueue } from "./index";
import { JobPayload, Agent, AgentRole } from "../types";
import { createAgent } from "../agents";
import { ProjectManagerAgent } from "../agents/roles/project_manager";
import { postToSlack } from "../slack";
import { db } from "../db";
import { v4 as uuid } from "uuid";

async function getAgentByRole(role: AgentRole): Promise<(Agent & { id: string }) | null> {
  const result = await db.query<Agent & { id: string }>(
    "SELECT id, name, role, branch FROM agents WHERE role = $1 LIMIT 1",
    [role]
  );
  return result.rows[0] ?? null;
}

async function processJob(job: Job<JobPayload>): Promise<void> {
  const { taskId, agentId, instruction, context, slackChannel, slackThreadTs } = job.data;

  const result = await db.query<Agent & { id: string }>(
    "SELECT id, name, role, branch FROM agents WHERE id = $1",
    [agentId]
  );
  if (result.rows.length === 0) throw new Error(`Agent ${agentId} not found`);
  const agentData = result.rows[0];

  const agent = createAgent({ ...agentData, status: "busy" });

  await agent.setStatus("busy", instruction);
  await db.query("UPDATE agent_tasks SET status = 'in_progress' WHERE id = $1", [taskId]);

  await postToSlack(
    slackChannel,
    `:hourglass_flowing_sand: *${agent.name}* (${agent.role}) is working on: _${instruction}_`,
    slackThreadTs
  );

  try {
    // Project manager orchestrates — dispatch sub-tasks to the team
    if (agent.role === "project_manager") {
      const pm = agent as ProjectManagerAgent;
      const plan = await pm.orchestrate(instruction);

      await postToSlack(
        slackChannel,
        `:clipboard: *${agent.name}*: ${plan.summary}\n_Dispatching ${plan.tasks.length} task(s) to the team..._`,
        slackThreadTs
      );

      for (const task of plan.tasks) {
        const assignee = await getAgentByRole(task.role);
        if (!assignee) {
          await postToSlack(
            slackChannel,
            `:warning: No agent found for role *${task.role}* — skipping.`,
            slackThreadTs
          );
          continue;
        }

        const subTaskId = uuid();
        await db.query(
          `INSERT INTO agent_tasks (id, agent_id, instruction, status, slack_channel, slack_thread_ts)
           VALUES ($1, $2, $3, 'pending', $4, $5)`,
          [subTaskId, assignee.id, task.instruction, slackChannel, slackThreadTs]
        );

        await agentQueue.add("agent-task", {
          taskId: subTaskId,
          agentId: assignee.id,
          instruction: task.instruction,
          slackChannel,
          slackThreadTs,
        });
      }

      await agent.setStatus("idle");
      await db.query("UPDATE agent_tasks SET status = 'completed', completed_at = NOW() WHERE id = $1", [taskId]);
      return;
    }

    // All other agents — run task and post result to Slack
    const response = await agent.run(instruction, context);

    await postToSlack(
      slackChannel,
      `:white_check_mark: *${agent.name}* finished:\n${response}`,
      slackThreadTs
    );

    await agent.setStatus("idle");
    await db.query("UPDATE agent_tasks SET status = 'completed', completed_at = NOW() WHERE id = $1", [taskId]);
  } catch (err) {
    await agent.setStatus("idle");
    await db.query("UPDATE agent_tasks SET status = 'failed' WHERE id = $1", [taskId]);
    await postToSlack(
      slackChannel,
      `:x: *${agent.name}* encountered an error: ${(err as Error).message}`,
      slackThreadTs
    );
    throw err;
  }
}

export function startWorker(): void {
  const worker = createWorker(processJob);

  worker.on("completed", (job) => {
    console.log(`[worker] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[worker] Job ${job?.id} failed:`, err.message);
  });

  console.log("[worker] Agent task worker started");
}
