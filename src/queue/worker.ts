import { Job } from "bullmq";
import { createWorker, redis } from "./index";
import { JobPayload, Agent } from "../types";
import { createAgent } from "../agents";
import { postToSlack } from "../slack";
import { db } from "../db";

async function processJob(job: Job<JobPayload>): Promise<void> {
  const { taskId, agentId, instruction, context, slackChannel, slackThreadTs } = job.data;

  // Load agent from DB
  const result = await db.query<Agent & { id: string }>(
    "SELECT id, name, role, branch FROM agents WHERE id = $1",
    [agentId]
  );
  if (result.rows.length === 0) throw new Error(`Agent ${agentId} not found`);
  const agentData = result.rows[0];

  const agent = createAgent({ ...agentData, status: "busy" });

  // Update status to busy
  await agent.setStatus("busy", instruction);
  await db.query(
    "UPDATE agent_tasks SET status = 'in_progress' WHERE id = $1",
    [taskId]
  );

  await postToSlack(
    slackChannel,
    `:hourglass: *${agent.name}* (${agent.role}) is working on: _${instruction}_`,
    slackThreadTs
  );

  try {
    const response = await agent.run(instruction, context);

    // Post result to Slack
    await postToSlack(
      slackChannel,
      `:white_check_mark: *${agent.name}* finished:\n${response}`,
      slackThreadTs
    );

    await agent.setStatus("idle");
    await db.query(
      "UPDATE agent_tasks SET status = 'completed', completed_at = NOW() WHERE id = $1",
      [taskId]
    );
  } catch (err) {
    await agent.setStatus("idle");
    await db.query(
      "UPDATE agent_tasks SET status = 'failed' WHERE id = $1",
      [taskId]
    );
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
