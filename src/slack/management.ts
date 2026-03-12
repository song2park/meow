/**
 * Slack commands for managing agents and roles.
 *
 * /add-agent <name> <role>     — register a new agent
 * /remove-agent <name>         — remove an agent
 * /add-role <name> <description> — register a new role
 * /list-agents                 — list all configured agents
 * /list-roles                  — list all available roles
 */
import { App } from "@slack/bolt";
import { db } from "../db";
import { redis } from "../queue";

export function registerManagementCommands(app: App): void {

  // /add-agent <name> <role>
  app.command("/add-agent", async ({ command, ack, respond }) => {
    await ack();
    try {
      const parts = command.text.trim().split(/\s+/);
      if (parts.length < 2) {
        await respond("Usage: `/add-agent <name> <role>`\nExample: `/add-agent Alice developer`");
        return;
      }

      const [name, role] = parts;
      const branch = `agent/${name.toLowerCase()}`;

      // Verify role exists
      const roleCheck = await db.query("SELECT name FROM roles WHERE name = $1", [role]);
      if (roleCheck.rows.length === 0) {
        await respond(
          `:x: Role *${role}* doesn't exist. Use \`/list-roles\` to see available roles, or \`/add-role\` to create one.`
        );
        return;
      }

      const result = await db.query<{ id: string }>(
        `INSERT INTO agents (name, role, branch)
         VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET role = EXCLUDED.role, branch = EXCLUDED.branch
         RETURNING id`,
        [name, role, branch]
      );

      const id = result.rows[0].id;
      await redis.hset(`agent:${id}`, { name, role, status: "idle", currentTask: "" });

      await respond(`:white_check_mark: Agent *${name}* (${role}) has been added to the team.`);
    } catch (err) {
      await respond(":x: Something went wrong: " + (err as Error).message);
    }
  });

  // /remove-agent <name>
  app.command("/remove-agent", async ({ command, ack, respond }) => {
    await ack();
    try {
      const name = command.text.trim();
      if (!name) {
        await respond("Usage: `/remove-agent <name>`");
        return;
      }

      const result = await db.query<{ id: string }>(
        "DELETE FROM agents WHERE name = $1 RETURNING id",
        [name]
      );

      if (result.rows.length === 0) {
        await respond(`:x: No agent named *${name}* found.`);
        return;
      }

      const id = result.rows[0].id;
      await redis.del(`agent:${id}`);
      await respond(`:white_check_mark: Agent *${name}* has been removed.`);
    } catch (err) {
      await respond(":x: Something went wrong: " + (err as Error).message);
    }
  });

  // /add-role <name> <description...>
  app.command("/add-role", async ({ command, ack, respond }) => {
    await ack();
    try {
      const text = command.text.trim();
      const spaceIdx = text.indexOf(" ");
      if (spaceIdx === -1) {
        await respond("Usage: `/add-role <name> <description>`\nExample: `/add-role devops Handles deployments and infrastructure`");
        return;
      }

      const name = text.slice(0, spaceIdx).toLowerCase().replace(/\s+/g, "_");
      const description = text.slice(spaceIdx + 1).trim();

      await db.query(
        `INSERT INTO roles (name, description)
         VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description`,
        [name, description]
      );

      await respond(`:white_check_mark: Role *${name}* saved: _${description}_`);
    } catch (err) {
      await respond(":x: Something went wrong: " + (err as Error).message);
    }
  });

  // /list-agents
  app.command("/list-agents", async ({ ack, respond }) => {
    await ack();
    try {
      const result = await db.query<{ name: string; role: string; branch: string }>(
        "SELECT name, role, branch FROM agents ORDER BY role, name"
      );

      if (result.rows.length === 0) {
        await respond("No agents configured yet. Use `/add-agent <name> <role>` to add one.");
        return;
      }

      const lines = result.rows.map((r) => `• *${r.name}* — ${r.role} (\`${r.branch}\`)`);
      await respond(`*Team Members:*\n${lines.join("\n")}`);
    } catch (err) {
      await respond(":x: Something went wrong: " + (err as Error).message);
    }
  });

  // /list-roles
  app.command("/list-roles", async ({ ack, respond }) => {
    await ack();
    try {
      const result = await db.query<{ name: string; description: string }>(
        "SELECT name, description FROM roles ORDER BY name"
      );

      if (result.rows.length === 0) {
        await respond("No roles defined yet.");
        return;
      }

      const lines = result.rows.map((r) => `• *${r.name}* — ${r.description}`);
      await respond(`*Available Roles:*\n${lines.join("\n")}`);
    } catch (err) {
      await respond(":x: Something went wrong: " + (err as Error).message);
    }
  });
}
