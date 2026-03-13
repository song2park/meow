import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { redis } from "../queue";
import { db } from "../db";
import { config } from "../config";

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

const UUID_PATTERN = /^agent:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const sseClients = new Set<http.ServerResponse>();
const MAX_SSE_CLIENTS = 50;

export function emitAgentUpdate(event: AgentUpdateEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      // Dead socket — remove it
      sseClients.delete(client);
    }
  }
}

interface AgentRedisData {
  name?: string;
  role?: string;
  status?: string;
  currentTask?: string;
}

interface TaskRow {
  agent_id: string;
  instruction: string;
  status: string;
  created_at: Date;
}

interface AgentInfo {
  agentId: string;
  agentName: string;
  role: string;
  status: string;
  currentTask: string;
  color: string;
  taskHistory: Array<{ ts: string; desc: string; status: string }>;
}

async function getAgents(): Promise<AgentInfo[]> {
  const keys = await redis.keys("agent:*");
  const agentKeys = keys.filter((k) => UUID_PATTERN.test(k));

  if (agentKeys.length === 0) return [];

  const agentDataList: Array<{ key: string; data: AgentRedisData }> = [];

  for (const key of agentKeys) {
    const data = await redis.hgetall(key);
    if (data && Object.keys(data).length > 0) {
      agentDataList.push({ key, data: data as AgentRedisData });
    }
  }

  // Extract UUIDs for DB query
  const agentIds = agentDataList.map(({ key }) => key.replace("agent:", ""));

  let taskRows: TaskRow[] = [];
  if (agentIds.length > 0) {
    // Fetch last 5 tasks per agent using a lateral join
    const placeholders = agentIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await db.query<TaskRow>(
      `SELECT DISTINCT ON (agent_id) agent_id, instruction, status, created_at
       FROM (
         SELECT agent_id, instruction, status, created_at,
                ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY created_at DESC) AS rn
         FROM agent_tasks
         WHERE agent_id = ANY(ARRAY[${placeholders}]::uuid[])
       ) sub
       WHERE rn <= 5
       ORDER BY agent_id, created_at DESC`,
      agentIds
    );
    taskRows = result.rows;
  }

  // Group tasks by agent_id
  const tasksByAgent: Record<string, TaskRow[]> = {};
  for (const row of taskRows) {
    const aid = row.agent_id;
    if (!tasksByAgent[aid]) tasksByAgent[aid] = [];
    tasksByAgent[aid].push(row);
  }

  return agentDataList.map(({ key, data }) => {
    const agentId = key.replace("agent:", "");
    const role = data.role ?? "developer";
    const name = data.name ?? agentId;
    const tasks = tasksByAgent[agentId] ?? [];

    return {
      agentId: name.toLowerCase().replace(/\s+/g, "-"),
      agentName: name,
      role,
      status: data.status ?? "idle",
      currentTask: data.currentTask ?? "",
      color: ROLE_COLORS[role] ?? "#6b7280",
      taskHistory: tasks.map((t) => ({
        ts: t.created_at instanceof Date ? t.created_at.toISOString() : String(t.created_at),
        desc: t.instruction,
        status: t.status,
      })),
    };
  });
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export function startDashboardServer(): void {
  const server = http.createServer((req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "/";

    // Serve dashboard HTML
    if (url === "/" || url === "/index.html") {
      try {
        const html = fs.readFileSync(path.join(__dirname, "../../public", "dashboard.html"), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Dashboard HTML not found");
      }
      return;
    }

    // Agent list API
    if (url === "/api/agents") {
      getAgents()
        .then((agents) => {
          const json = JSON.stringify(agents);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(json);
        })
        .catch((err: unknown) => {
          console.error("[dashboard] /api/agents error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        });
      return;
    }

    // SSE endpoint
    if (url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      // Reject if at client cap
      if (sseClients.size >= MAX_SSE_CLIENTS) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("Too many SSE clients");
        return;
      }

      res.write("retry: 3000\n\n");
      sseClients.add(res);

      req.on("close", () => sseClients.delete(res));
      req.on("error", () => sseClients.delete(res));

      return;
    }

    // 404 fallback
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(config.PORT, () => {
    console.log(`[dashboard] Server running on http://localhost:${config.PORT}`);
  });
}
