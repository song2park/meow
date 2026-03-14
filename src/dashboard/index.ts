import express, { Request, Response, Router } from "express";
import * as path from "path";
import { redis } from "../queue";
import { db } from "../db";
import { agentQueue } from "../queue";
import { config } from "../config";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AgentStatus {
  id: string;
  name: string;
  role: string;
  status: string;
  currentTask: string;
  updatedAt: string;
}

export interface TaskRow {
  id: string;
  agentName: string;
  instruction: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export interface HealthPayload {
  agentsOnline: number;
  queueDepth: number;
  todayCount: number;
}

// ── AgentUpdateEvent (used by worker) ─────────────────────────────────────────

export interface AgentUpdateEvent {
  agentId: string;
  agentName: string;
  status: "idle" | "busy";
  currentTask: string;
  message: string;
  color: string;
}

export const ROLE_COLORS: Record<string, string> = {
  developer: "#f59e0b",
  designer: "#6366f1",
  product_manager: "#3b82f6",
  qa_engineer: "#ec4899",
  project_manager: "#8b5cf6",
};

// ── SSE client set ─────────────────────────────────────────────────────────────

const sseClients = new Set<Response>();
const MAX_SSE_CLIENTS = 50;

/** Broadcast an agent-update event to all connected SSE clients. */
export function emitAgentUpdate(event: AgentUpdateEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ── Data helpers ───────────────────────────────────────────────────────────────

const UUID_PATTERN =
  /^agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AgentRedisData {
  name?: string;
  role?: string;
  status?: string;
  currentTask?: string;
  updatedAt?: string;
}

async function getAllAgentKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(
      cursor,
      "MATCH",
      "agent:*",
      "COUNT",
      100
    );
    keys.push(...batch.filter((k) => UUID_PATTERN.test(k)));
    cursor = nextCursor;
  } while (cursor !== "0");
  return keys;
}

async function getAllAgents(): Promise<AgentStatus[]> {
  const agentKeys = await getAllAgentKeys();
  if (agentKeys.length === 0) return [];

  const agents: AgentStatus[] = [];
  for (const key of agentKeys) {
    const data = (await redis.hgetall(key)) as AgentRedisData;
    if (!data || Object.keys(data).length === 0) continue;
    const id = key.replace("agent:", "");
    agents.push({
      id,
      name: data.name ?? id,
      role: data.role ?? "developer",
      status: data.status ?? "idle",
      currentTask: data.currentTask ?? "",
      updatedAt: data.updatedAt ?? new Date().toISOString(),
    });
  }
  return agents;
}

async function getRecentTasks(limit = 20): Promise<TaskRow[]> {
  const safeLimit = Math.min(Math.max(1, limit), 50);
  const result = await db.query<{
    id: string;
    agent_name: string;
    instruction: string;
    status: string;
    created_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT t.id, a.name AS agent_name, t.instruction, t.status,
            t.created_at, t.completed_at
     FROM agent_tasks t
     JOIN agents a ON a.id = t.agent_id
     ORDER BY t.created_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return result.rows.map((r) => ({
    id: r.id,
    agentName: r.agent_name,
    instruction: r.instruction,
    status: r.status,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    completedAt:
      r.completed_at instanceof Date
        ? r.completed_at.toISOString()
        : r.completed_at
        ? String(r.completed_at)
        : null,
  }));
}

async function getQueueDepth(): Promise<number> {
  const [waiting, active] = await Promise.all([
    agentQueue.getWaitingCount(),
    agentQueue.getActiveCount(),
  ]);
  return waiting + active;
}

async function getTodayCount(): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM agent_tasks
     WHERE status = 'completed'
       AND created_at >= CURRENT_DATE`
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

// ── Path resolution ────────────────────────────────────────────────────────────
// In dev (ts-node): __filename = .../src/dashboard/index.ts → resolve relative to __dirname
// In prod (compiled): __filename = .../dist/dashboard/index.js → go up to src via process.cwd()

function resolveDashboardHtml(): string {
  const isDist = __filename.endsWith(".js") && __filename.includes("dist");
  if (isDist) {
    // dist/dashboard/index.js → ../../src/dashboard/index.html
    return path.join(__dirname, "../../src/dashboard/index.html");
  }
  // src/dashboard/index.ts → same dir
  return path.join(__dirname, "index.html");
}

function resolvePublicDir(): string {
  const isDist = __filename.endsWith(".js") && __filename.includes("dist");
  if (isDist) {
    return path.join(__dirname, "../../public");
  }
  return path.join(process.cwd(), "public");
}

// ── SSE helper ────────────────────────────────────────────────────────────────

function attachSSEClient(req: Request, res: Response): void {
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    res.status(503).send("Too many SSE clients");
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  res.write("retry: 3000\n\n");
  sseClients.add(res);

  const sendSnapshot = async (): Promise<void> => {
    try {
      const [agents, tasks, queueDepth, todayCount] = await Promise.all([
        getAllAgents(),
        getRecentTasks(20),
        getQueueDepth(),
        getTodayCount(),
      ]);
      const agentsOnline = agents.filter(
        (a) => a.status === "idle" || a.status === "busy"
      ).length;
      const health: HealthPayload = { agentsOnline, queueDepth, todayCount };
      if (!res.writableEnded) {
        res.write(`event: agents\ndata: ${JSON.stringify(agents)}\n\n`);
        res.write(`event: tasks\ndata: ${JSON.stringify(tasks)}\n\n`);
        res.write(`event: health\ndata: ${JSON.stringify(health)}\n\n`);
      }
    } catch (err) {
      console.error("[dashboard] SSE send error:", err);
    }
  };

  void sendSnapshot();
  const interval = setInterval(async () => {
    if (res.writableEnded) {
      clearInterval(interval);
      sseClients.delete(res);
      return;
    }
    await sendSnapshot();
  }, 2500);

  req.on("close", () => {
    clearInterval(interval);
    sseClients.delete(res);
  });

  req.on("error", () => {
    clearInterval(interval);
    sseClients.delete(res);
  });
}

// ── createDashboardRouter ─────────────────────────────────────────────────────

export function createDashboardRouter(): Router {
  const router = Router();

  // GET /dashboard — serve the SPA HTML
  router.get("/dashboard", (_req: Request, res: Response) => {
    res.sendFile(resolveDashboardHtml());
  });

  // GET /api/agents — snapshot from Redis
  router.get("/api/agents", async (_req: Request, res: Response) => {
    try {
      const agents = await getAllAgents();
      res.json(agents);
    } catch (err) {
      console.error("[dashboard] /api/agents error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/tasks?limit=50 — recent tasks from PostgreSQL
  router.get("/api/tasks", async (req: Request, res: Response) => {
    try {
      const raw = parseInt(String(req.query["limit"] ?? "20"), 10);
      const limit = Number.isNaN(raw) ? 20 : raw;
      const tasks = await getRecentTasks(limit);
      res.json(tasks);
    } catch (err) {
      console.error("[dashboard] /api/tasks error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /events — SSE stream
  router.get("/events", (req: Request, res: Response) => {
    attachSSEClient(req, res);
  });

  return router;
}

// ── startDashboardServer (legacy — called from src/index.ts) ──────────────────

export function startDashboardServer(): void {
  const app = express();
  const publicDir = resolvePublicDir();

  // Serve static assets from public/
  app.use(express.static(publicDir));

  // Mount the new router (covers /dashboard, /api/agents, /api/tasks, /events)
  app.use("/", createDashboardRouter());

  // Legacy: GET / → index.html from public/
  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  // Legacy SSE path /api/events for existing public/dashboard.js
  app.get("/api/events", (req: Request, res: Response) => {
    attachSSEClient(req, res);
  });

  app.listen(config.PORT, () => {
    console.log(`[dashboard] Server running on http://localhost:${config.PORT}`);
    console.log(`[dashboard] Live dashboard at http://localhost:${config.PORT}/dashboard`);
  });
}
