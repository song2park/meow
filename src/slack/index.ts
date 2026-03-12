import { App } from "@slack/bolt";
import { config } from "../config";
import { agentQueue, redis } from "../queue";
import { JobPayload } from "../types";
import { db } from "../db";
import { registerManagementCommands } from "./management";
import { v4 as uuid } from "uuid";

export const slackApp = new App({
  token: config.SLACK_BOT_TOKEN,
  signingSecret: config.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: config.SLACK_APP_TOKEN,
});

const STATUS_PATTERNS = [
  /what are you doing/i,
  /show me what you('re| are) doing/i,
  /current(ly)? working on/i,
  /agent status/i,
  /team status/i,
];

async function buildStatusReport(): Promise<string> {
  const keys = await redis.keys("agent:*");
  const agentKeys = keys.filter((k) => /^agent:[a-f0-9-]{36}$/.test(k));
  if (agentKeys.length === 0) return "No agents registered yet.";

  const lines = await Promise.all(
    agentKeys.map(async (key) => {
      const data = await redis.hgetall(key);
      const status =
        data.status === "busy"
          ? `:hourglass_flowing_sand: busy — _${data.currentTask}_`
          : ":white_check_mark: idle";
      return `*${data.name}* (${data.role}): ${status}`;
    })
  );
  return `*Team Status:*\n${lines.join("\n")}`;
}

// When user mentions the bot: @bot <instruction>
slackApp.event("app_mention", async ({ event, say }) => {
  const instruction = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!instruction) {
    await say({ text: "Hey! What would you like me to do?", thread_ts: event.ts });
    return;
  }

  // Natural language status queries — respond immediately without queuing
  if (STATUS_PATTERNS.some((p) => p.test(instruction))) {
    try {
      const report = await buildStatusReport();
      await say({ text: report, thread_ts: event.ts });
    } catch (err) {
      console.error("[app_mention] Error building status report:", err);
      await say({ text: ":x: Could not fetch agent status. Please try again.", thread_ts: event.ts });
    }
    return;
  }

  try {
    // Route to project manager (orchestrator) via DB lookup
    const pmResult = await db.query("SELECT id FROM agents WHERE role = 'project_manager' LIMIT 1");
    if (pmResult.rows.length === 0) {
      await say({
        text: ":warning: No project manager configured yet. Add one with `/add-agent <name> project_manager`.",
        thread_ts: event.ts,
      });
      return;
    }

    const pmAgentId = pmResult.rows[0].id as string;
    const taskId = uuid();
    const payload: JobPayload = {
      taskId,
      agentId: pmAgentId,
      instruction,
      slackChannel: event.channel,
      slackThreadTs: event.ts,
    };

    await db.query(
      `INSERT INTO agent_tasks (id, agent_id, instruction, status, slack_channel, slack_thread_ts)
       VALUES ($1, $2, $3, 'pending', $4, $5)`,
      [taskId, pmAgentId, instruction, event.channel, event.ts]
    );

    await agentQueue.add("agent-task", payload);
    await say({
      text: `:hourglass_flowing_sand: Got it! The team is on it. _(task: \`${taskId}\`)_`,
      thread_ts: event.ts,
    });
  } catch (err) {
    console.error("[app_mention] Error handling mention:", err);
    await say({ text: ":x: Something went wrong. Please try again.", thread_ts: event.ts });
  }
});

// /agent-status — show all agents' current status
slackApp.command("/agent-status", async ({ ack, respond }) => {
  await ack();
  const report = await buildStatusReport();
  await respond(report);
});

registerManagementCommands(slackApp);

export async function postToSlack(channel: string, text: string, threadTs?: string): Promise<void> {
  await slackApp.client.chat.postMessage({
    channel,
    text,
    thread_ts: threadTs,
  });
}
