import express, { Request, Response } from "express";
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

// ── Legacy event emitter (used by worker to push updates) ─────────────────────

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

/** Broadcast a raw agent-update event to all connected SSE clients (legacy push path). */
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

async function getRecentTasks(): Promise<TaskRow[]> {
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
     LIMIT 20`
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

// ── Public path resolution ─────────────────────────────────────────────────────
// When compiled: dist/dashboard/index.js → public is ../../public
// When run via ts-node from cwd: use process.cwd()/public

function resolvePublicDir(): string {
  // ts-node sets __filename to the .ts path; compiled sets it to .js inside dist/
  const isDist = __filename.endsWith(".js") && __filename.includes("dist");
  if (isDist) {
    return path.join(__dirname, "../../public");
  }
  return path.join(process.cwd(), "public");
}

// ── Express app ────────────────────────────────────────────────────────────────

export function startDashboardServer(): void {
  const app = express();
  const publicDir = resolvePublicDir();

  // Serve static assets (style.css, dashboard.js, etc.)
  app.use(express.static(publicDir));

  // GET / → index.html
  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  // GET /api/events → SSE
  app.get("/api/events", (req: Request, res: Response) => {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      res.status(503).send("Too many SSE clients");
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();

    // Acknowledge connection
    res.write("retry: 3000\n\n");

    sseClients.add(res);

    const sendAll = async (): Promise<void> => {
      try {
        const [agents, tasks, queueDepth, todayCount] = await Promise.all([
          getAllAgents(),
          getRecentTasks(),
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

    // Send immediately, then every 2.5 s
    void sendAll();
    const interval = setInterval(async () => {
      if (res.writableEnded) {
        clearInterval(interval);
        sseClients.delete(res);
        return;
      }
      await sendAll();
    }, 2500);

    req.on("close", () => {
      clearInterval(interval);
      sseClients.delete(res);
    });

    req.on("error", () => {
      clearInterval(interval);
      sseClients.delete(res);
    });
  });

  // Legacy endpoints kept for backwards compat
  app.get("/api/agents", async (_req: Request, res: Response) => {
    try {
      const agents = await getAllAgents();
      res.json(agents);
    } catch (err) {
      console.error("[dashboard] /api/agents error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.listen(config.PORT, () => {
    console.log(`[dashboard] Server running on http://localhost:${config.PORT}`);
  });
}
