/**
 * Seeds default roles into PostgreSQL.
 * Agents are added by users via Slack commands (/add-agent).
 * Run with: npm run seed
 */
import dotenv from "dotenv";
dotenv.config();

import { db } from "../src/db";

const DEFAULT_ROLES = [
  { name: "developer",        description: "Writes and reviews code, creates pull requests" },
  { name: "designer",         description: "Creates UI/UX designs and design specifications" },
  { name: "product_manager",  description: "Defines requirements, priorities, and user stories" },
  { name: "project_manager",  description: "Orchestrates the team, reviews progress, merges PRs" },
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

  console.log("\nDone. Add agents via Slack: /add-agent <name> <role>");
}

seed()
  .catch((err) => { console.error("Seed failed:", err); process.exit(1); })
  .finally(() => db.end());
