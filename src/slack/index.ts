import { App } from "@slack/bolt";
import { config } from "../config";
import { agentQueue, redis } from "../queue";
import { JobPayload } from "../types";
import { v4 as uuid } from "uuid";

export const slackApp = new App({
  token: config.SLACK_BOT_TOKEN,
  signingSecret: config.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: config.SLACK_APP_TOKEN,
});

// When user mentions the bot: @bot <instruction>
slackApp.event("app_mention", async ({ event, say }) => {
  const instruction = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!instruction) {
    await say({ text: "Hey! What would you like me to do?", thread_ts: event.ts });
    return;
  }

  // Route to project manager agent by default (orchestrator decides)
  const pmAgentId = await redis.get("agent:role:project_manager");
  if (!pmAgentId) {
    await say({ text: ":warning: No project manager agent configured yet.", thread_ts: event.ts });
    return;
  }

  const taskId = uuid();
  const payload: JobPayload = {
    taskId,
    agentId: pmAgentId,
    instruction,
    slackChannel: event.channel,
    slackThreadTs: event.ts,
  };

  await agentQueue.add("agent-task", payload);
  await say({ text: `:hourglass: Got it! The team is on it. _(task: ${taskId})_`, thread_ts: event.ts });
});

// /status — show all agents' current status
slackApp.command("/agent-status", async ({ command, ack, respond }) => {
  await ack();

  const keys = await redis.keys("agent:*");
  const agentKeys = keys.filter((k) => k.match(/^agent:[a-f0-9-]{36}$/));

  if (agentKeys.length === 0) {
    await respond("No agents registered yet.");
    return;
  }

  const lines = await Promise.all(
    agentKeys.map(async (key) => {
      const data = await redis.hgetall(key);
      const status = data.status === "busy" ? `:hourglass: busy — _${data.currentTask}_` : ":white_check_mark: idle";
      return `*${data.name}* (${data.role}): ${status}`;
    })
  );

  await respond(`*Agent Status:*\n${lines.join("\n")}`);
});

export async function postToSlack(channel: string, text: string, threadTs?: string): Promise<void> {
  await slackApp.client.chat.postMessage({
    channel,
    text,
    thread_ts: threadTs,
  });
}
