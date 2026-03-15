import { slackApp } from "./slack";
import { startWorker } from "./queue/worker";
import { startDashboardServer } from "./dashboard";
import { config } from "./config";
import { initWorkspace } from "./git/workspace";

async function main(): Promise<void> {
  await initWorkspace();

  startDashboardServer();
  startWorker();

  await slackApp.start();
  console.log(`[app] Multi-agent orchestrator running (env: ${config.NODE_ENV})`);
}

main().catch((err) => {
  console.error("[app] Fatal error:", err);
  process.exit(1);
});
