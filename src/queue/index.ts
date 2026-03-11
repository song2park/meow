import { Queue, Worker, Job } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";
import { JobPayload } from "../types";

// Shared ioredis client for app-level state (agent status, etc.)
export const redis = new IORedis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  maxRetriesPerRequest: null,
});

// BullMQ bundles its own ioredis — pass connection options, not a Redis instance
const bullConnection = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
};

export const agentQueue = new Queue<JobPayload>("agent-tasks", {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

export function createWorker(
  processor: (job: Job<JobPayload>) => Promise<void>
): Worker<JobPayload> {
  return new Worker<JobPayload>("agent-tasks", processor, {
    connection: bullConnection,
    concurrency: 4,
  });
}
