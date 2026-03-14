import { Job } from "bullmq";
import { createWorker, agentQueue, redis } from "./index";
import { JobPayload, Agent, AgentRole } from "../types";
import { createAgent } from "../agents";
import { ProjectManagerAgent } from "../agents/roles/project_manager";
import { postToSlack } from "../slack";
import { db } from "../db";
import { v4 as uuid } from "uuid";
import { config } from "../config";
import { ensureAgentBranch, writeAgentFile, commitAndPush, createAgentPR } from "../git";
import { emitAgentUpdate, ROLE_COLORS } from "../dashboard";
import { saveTaskMemory } from "../agents/memory";

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
  const lockKey = `agent:lock:${agentId}`;

  try {
    // Acquire per-agent Redis lock to prevent concurrent jobs for the same agent
    const lockAcquired = await redis.set(lockKey, "1", "EX", 300, "NX");
    if (lockAcquired === null) {
      throw new Error("Agent is busy, will retry");
    }

    await agent.setStatus("busy", instruction);
    emitAgentUpdate({
      agentId: agent.name.toLowerCase().replace(/\s+/g, "-"),
      agentName: agent.name,
      status: "busy",
      currentTask: instruction,
      message: `Started: ${instruction}`,
      color: ROLE_COLORS[agent.role] ?? "#6b7280",
    });
    await db.query("UPDATE agent_tasks SET status = 'in_progress' WHERE id = $1", [taskId]);

    await postToSlack(
      slackChannel,
      `:hourglass_flowing_sand: *${agent.name}* (${agent.role}) is working on: _${instruction}_`,
      slackThreadTs
    );

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
      emitAgentUpdate({
        agentId: agent.name.toLowerCase().replace(/\s+/g, "-"),
        agentName: agent.name,
        status: "idle",
        currentTask: "",
        message: `Orchestration complete: ${plan.summary}`,
        color: ROLE_COLORS[agent.role] ?? "#6b7280",
      });
      await redis.del(lockKey);
      await db.query("UPDATE agent_tasks SET status = 'completed', completed_at = NOW() WHERE id = $1", [taskId]);
      return;
    }

    // All other agents — run task and post result to Slack
    const output = await agent.run(instruction, context);

    await postToSlack(
      slackChannel,
      `:white_check_mark: *${agent.name}* finished:\n${output.summary}`,
      slackThreadTs
    );

    // Persist task memory (non-fatal — failure must not fail the task)
    try {
      await saveTaskMemory(taskId, output.summary);
    } catch (memErr) {
      console.error(`[worker] Memory save failed for task ${taskId}:`, (memErr as Error).message);
    }

    // Handle file artifacts: commit to agent branch and open a PR
    if (output.files && output.files.length > 0) {
      const branchName = `agent/${agent.name}`;
      const writtenFiles: string[] = [];

      try {
        const git = await ensureAgentBranch(branchName);

        for (const file of output.files) {
          const relativePath = await writeAgentFile(agent.name, file.filename, file.content);
          writtenFiles.push(relativePath);
        }

        const shortDescription = instruction.slice(0, 72);
        const commitMessage = `[${agent.name}] ${shortDescription}`;
        await commitAndPush(git, agent.name, agent.role, commitMessage);

        // Attempt PR creation if GITHUB_TOKEN is configured
        let prUrl: string | null = null;
        if (config.GITHUB_TOKEN) {
          try {
            prUrl = await createAgentPR({
              agentName: agent.name,
              agentRole: agent.role,
              taskDescription: shortDescription,
              filesChanged: writtenFiles,
            });
          } catch (prErr) {
            console.error(`[worker] PR creation failed for ${agent.name}:`, (prErr as Error).message);
          }
        } else {
          console.warn(`[worker] GITHUB_TOKEN not set — skipping PR creation for ${agent.name}`);
        }

        const prNote = prUrl ? ` — PR: ${prUrl}` : "";
        await postToSlack(
          slackChannel,
          `:file_folder: *${agent.name}* committed ${writtenFiles.length} file(s)${prNote}`,
          slackThreadTs
        );
      } catch (gitErr) {
        // Git errors are non-fatal for the task itself — log and continue
        console.error(`[worker] Git integration error for ${agent.name}:`, (gitErr as Error).message);
        await postToSlack(
          slackChannel,
          `:warning: *${agent.name}* produced files but git commit failed: ${(gitErr as Error).message}`,
          slackThreadTs
        );
      }
    }

    await agent.setStatus("idle");
    emitAgentUpdate({
      agentId: agent.name.toLowerCase().replace(/\s+/g, "-"),
      agentName: agent.name,
      status: "idle",
      currentTask: "",
      message: `Completed: ${instruction}`,
      color: ROLE_COLORS[agent.role] ?? "#6b7280",
    });
    await redis.del(lockKey);
    await db.query("UPDATE agent_tasks SET status = 'completed', completed_at = NOW() WHERE id = $1", [taskId]);
  } catch (err) {
    await agent.setStatus("idle");
    emitAgentUpdate({
      agentId: agent.name.toLowerCase().replace(/\s+/g, "-"),
      agentName: agent.name,
      status: "idle",
      currentTask: "",
      message: `Error: ${(err as Error).message}`,
      color: ROLE_COLORS[agent.role] ?? "#6b7280",
    });
    await redis.del(lockKey);
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
