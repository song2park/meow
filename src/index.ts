import { slackApp } from "./slack";
import { startWorker } from "./queue/worker";
import { config } from "./config";

async function main(): Promise<void> {
  startWorker();

  await slackApp.start();
  console.log(`[app] Multi-agent orchestrator running (env: ${config.NODE_ENV})`);
}

main().catch((err) => {
  console.error("[app] Fatal error:", err);
  process.exit(1);
});
