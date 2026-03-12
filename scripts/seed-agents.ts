/**
 * Seeds default roles and the three core agents (Mary, Charles, Tara) into PostgreSQL and Redis.
 * Run with: npm run seed
 */
import dotenv from "dotenv";
dotenv.config();

import { db } from "../src/db";
import { redis } from "../src/queue";

const DEFAULT_ROLES = [
  { name: "developer",        description: "Writes and reviews code, creates pull requests" },
  { name: "designer",         description: "Creates UI/UX designs and design specifications" },
  { name: "product_manager",  description: "Defines requirements, priorities, and user stories" },
  { name: "project_manager",  description: "Orchestrates the team, reviews progress, merges PRs" },
  { name: "qa_engineer",      description: "Tests features, reports bugs, validates agent output" },
] as const;

const DEFAULT_AGENTS = [
  { name: "Alex",    role: "project_manager",  branch: "agent/alex" },
  { name: "Mary",    role: "designer",         branch: "agent/mary" },
  { name: "Charles", role: "product_manager",  branch: "agent/charles" },
  { name: "Tara",    role: "developer",        branch: "agent/tara" },
  { name: "Clare",   role: "qa_engineer",      branch: "agent/clare" },
] as const;

async function seed(): Promise<void> {
  console.log("Seeding default roles...");

  for (const role of DEFAULT_ROLES) {
    await db.query(
      `INSERT INTO roles (name, description)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description`,
      [role.name, role.description]
    );
    console.log(`  ✓ role: ${role.name}`);
  }

  console.log("\nSeeding agents...");

  for (const agent of DEFAULT_AGENTS) {
    const result = await db.query<{ id: string }>(
      `INSERT INTO agents (name, role, branch)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET role = EXCLUDED.role, branch = EXCLUDED.branch
       RETURNING id`,
      [agent.name, agent.role, agent.branch]
    );
    const id = result.rows[0].id;

    await redis.hset(`agent:${id}`, {
      name: agent.name,
      role: agent.role,
      status: "idle",
      currentTask: "",
    });

    console.log(`  ✓ agent: ${agent.name} (${agent.role}) — id: ${id}`);
  }

  console.log("\nDone.");
}

seed()
  .catch((err) => { console.error("Seed failed:", err); process.exit(1); })
  .finally(async () => {
    await db.end();
    redis.disconnect();
  });
