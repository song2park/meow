/**
 * Slack commands for managing agents and roles.
 *
 * /add-agent <name> <role>                          — register a new agent
 * /remove-agent <name>                              — remove an agent
 * /edit-agent <name> [name:<new-name>] [role:<role-name>] — edit an agent
 * /add-role <name> <description>                    — register a new role
 * /edit-role <name> [name:<new-name>] [description:<new-description>] — edit a role
 * /list-agents                                      — list all configured agents (grouped by role)
 * /list-roles                                       — list all available roles with agent count
 */
import { App } from "@slack/bolt";
import { db } from "../db";
import { redis } from "../queue";

/**
 * Parse key:value pairs from a command text string.
 * Handles values that contain spaces — the value for a key extends until the
 * next "word:" token or the end of the string.
 *
 * Examples:
 *   "myagent name:alice role:developer"
 *     → { _positional: 'myagent', name: 'alice', role: 'developer' }
 *   "devops description:Manages deployment pipelines"
 *     → { _positional: 'devops', description: 'Manages deployment pipelines' }
 */
function parseKVArgs(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const trimmed = text.trim();
  if (!trimmed) return result;

  // Split into tokens on whitespace, then reassemble key:value pairs.
  // A "key token" matches /^\w+:/ — everything else is positional.
  const tokens = trimmed.split(/\s+/);

  // The first token that does NOT contain a colon is treated as the positional arg.
  let positionalCapured = false;
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    const colonIdx = token.indexOf(":");

    if (colonIdx > 0) {
      // key:rest — value starts after the colon, may continue across following non-key tokens
      const key = token.slice(0, colonIdx);
      const firstPart = token.slice(colonIdx + 1);
      const valueParts: string[] = firstPart ? [firstPart] : [];

      // Consume subsequent tokens that are NOT "key:" tokens
      i++;
      while (i < tokens.length && tokens[i].indexOf(":") < 0) {
        valueParts.push(tokens[i]);
        i++;
      }

      result[key] = valueParts.join(" ");
    } else {
      // Positional argument (no colon, or colon at position 0)
      if (!positionalCapured) {
        result["_positional"] = token;
        positionalCapured = true;
      }
      i++;
    }
  }

  return result;
}

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

      // Count agents in this role (including the new one)
      const countResult = await db.query<{ count: string }>(
        "SELECT COUNT(*) as count FROM agents WHERE role = $1",
        [role]
      );
      const roleCount = parseInt(countResult.rows[0].count, 10);

      let msg = `:white_check_mark: Agent *${name}* (${role}) has been added to the team.`;
      if (roleCount > 1) {
        msg += ` There are now *${roleCount}* agents with the *${role}* role.`;
      }

      await respond(msg);
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

  // /edit-agent <name> [name:<new-name>] [role:<role-name>]
  app.command("/edit-agent", async ({ command, ack, respond }) => {
    await ack();
    try {
      const args = parseKVArgs(command.text);
      const currentName = args["_positional"];

      if (!currentName) {
        await respond(
          "Usage: `/edit-agent <name> [name:<new-name>] [role:<role-name>]`\n" +
          "Example: `/edit-agent Alice name:Alicia role:designer`"
        );
        return;
      }

      const newName = args["name"];
      const newRole = args["role"];

      if (!newName && !newRole) {
        await respond(
          ":x: Provide at least one field to update: `name:<new-name>` or `role:<role-name>`."
        );
        return;
      }

      // Verify current agent exists
      const agentResult = await db.query<{ id: string; name: string; role: string }>(
        "SELECT id, name, role FROM agents WHERE name = $1",
        [currentName]
      );
      if (agentResult.rows.length === 0) {
        await respond(`:x: No agent named *${currentName}* found.`);
        return;
      }

      const agent = agentResult.rows[0];
      // Status lives in Redis, not DB
      const redisStatus = await redis.hget(`agent:${agent.id}`, "status");

      // If renaming, ensure new name is not taken by another agent
      if (newName && newName !== currentName) {
        const nameConflict = await db.query(
          "SELECT id FROM agents WHERE name = $1",
          [newName]
        );
        if (nameConflict.rows.length > 0) {
          await respond(`:x: An agent named *${newName}* already exists.`);
          return;
        }
      }

      // If changing role, ensure the target role exists
      if (newRole) {
        const roleCheck = await db.query("SELECT name FROM roles WHERE name = $1", [newRole]);
        if (roleCheck.rows.length === 0) {
          await respond(
            `:x: Role *${newRole}* doesn't exist. Use \`/list-roles\` to see available roles, or \`/add-role\` to create one.`
          );
          return;
        }
      }

      const resolvedName = newName ?? agent.name;
      const resolvedRole = newRole ?? agent.role;
      const resolvedBranch = `agent/${resolvedName.toLowerCase()}`;

      // UPDATE DB
      await db.query(
        "UPDATE agents SET name = $1, role = $2, branch = $3 WHERE id = $4",
        [resolvedName, resolvedRole, resolvedBranch, agent.id]
      );

      // HSET Redis
      await redis.hset(`agent:${agent.id}`, {
        name: resolvedName,
        role: resolvedRole,
      });

      const changes: string[] = [];
      if (newName && newName !== agent.name) changes.push(`name: *${agent.name}* → *${newName}*`);
      if (newRole && newRole !== agent.role) changes.push(`role: *${agent.role}* → *${newRole}*`);

      let msg = `:white_check_mark: Agent updated — ${changes.join(", ")}.`;
      if (redisStatus === "busy") {
        msg += " :warning: Note: this agent is currently *busy* — changes will take effect when the current task completes.";
      }

      await respond(msg);
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

  // /edit-role <name> [name:<new-name>] [description:<new-description>]
  app.command("/edit-role", async ({ command, ack, respond }) => {
    await ack();
    try {
      const args = parseKVArgs(command.text);
      const currentName = args["_positional"];

      if (!currentName) {
        await respond(
          "Usage: `/edit-role <name> [name:<new-name>] [description:<new-description>]`\n" +
          "Example: `/edit-role devops name:platform description:Manages cloud infrastructure`"
        );
        return;
      }

      const newName = args["name"];
      const newDescription = args["description"];

      if (!newName && !newDescription) {
        await respond(
          ":x: Provide at least one field to update: `name:<new-name>` or `description:<new-description>`."
        );
        return;
      }

      // Verify role exists
      const roleResult = await db.query<{ name: string; description: string }>(
        "SELECT name, description FROM roles WHERE name = $1",
        [currentName]
      );
      if (roleResult.rows.length === 0) {
        await respond(`:x: Role *${currentName}* not found. Use \`/list-roles\` to see available roles.`);
        return;
      }

      const currentRole = roleResult.rows[0];

      // If renaming, ensure new name is not taken by another role
      if (newName && newName !== currentName) {
        const nameConflict = await db.query(
          "SELECT name FROM roles WHERE name = $1",
          [newName]
        );
        if (nameConflict.rows.length > 0) {
          await respond(`:x: A role named *${newName}* already exists.`);
          return;
        }
      }

      const resolvedName = newName ?? currentRole.name;
      const resolvedDescription = newDescription ?? currentRole.description;

      // Use a transaction so role rename + agent updates are atomic
      const client = await db.connect();
      let affectedAgentIds: string[] = [];
      try {
        await client.query("BEGIN");

        await client.query(
          "UPDATE roles SET name = $1, description = $2 WHERE name = $3",
          [resolvedName, resolvedDescription, currentName]
        );

        // If renamed, update all agents that reference the old role name
        if (newName && newName !== currentName) {
          const agentUpdateResult = await client.query<{ id: string }>(
            "UPDATE agents SET role = $1 WHERE role = $2 RETURNING id",
            [resolvedName, currentName]
          );
          affectedAgentIds = agentUpdateResult.rows.map((r) => r.id);
        }

        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK");
        throw txErr;
      } finally {
        client.release();
      }

      // After DB commit, sync Redis for affected agents (best-effort, log on partial failure)
      if (affectedAgentIds.length > 0) {
        const results = await Promise.allSettled(
          affectedAgentIds.map((id) => redis.hset(`agent:${id}`, { role: resolvedName }))
        );
        results.forEach((r, idx) => {
          if (r.status === "rejected") {
            console.error(`[edit-role] Redis sync failed for agent ${affectedAgentIds[idx]}:`, r.reason);
          }
        });
      }

      const changes: string[] = [];
      if (newName && newName !== currentRole.name) changes.push(`name: *${currentRole.name}* → *${newName}*`);
      if (newDescription && newDescription !== currentRole.description) {
        changes.push(`description updated`);
      }

      let msg = `:white_check_mark: Role updated — ${changes.join(", ")}.`;
      if (affectedAgentIds.length > 0) {
        msg += ` *${affectedAgentIds.length}* agent${affectedAgentIds.length === 1 ? "" : "s"} updated to the new role name.`;
      }

      await respond(msg);
    } catch (err) {
      await respond(":x: Something went wrong: " + (err as Error).message);
    }
  });

  // /list-agents — grouped by role, sorted by role name then agent name
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

      // Group by role
      const byRole = new Map<string, Array<{ name: string; branch: string }>>();
      for (const row of result.rows) {
        if (!byRole.has(row.role)) byRole.set(row.role, []);
        byRole.get(row.role)!.push({ name: row.name, branch: row.branch });
      }

      const sections: string[] = [];
      for (const [role, agents] of byRole) {
        const agentLines = agents.map((a) => `  • *${a.name}* (\`${a.branch}\`)`);
        sections.push(`*${role}*\n${agentLines.join("\n")}`);
      }

      await respond(`*Team Members:*\n\n${sections.join("\n\n")}`);
    } catch (err) {
      await respond(":x: Something went wrong: " + (err as Error).message);
    }
  });

  // /list-roles — show roles with agent count
  app.command("/list-roles", async ({ ack, respond }) => {
    await ack();
    try {
      const result = await db.query<{ name: string; description: string; agent_count: string }>(
        `SELECT r.name, r.description, COUNT(a.id) as agent_count
         FROM roles r
         LEFT JOIN agents a ON a.role = r.name
         GROUP BY r.name, r.description
         ORDER BY r.name`
      );

      if (result.rows.length === 0) {
        await respond("No roles defined yet.");
        return;
      }

      const lines = result.rows.map((r) => {
        const count = parseInt(r.agent_count, 10);
        const agentNote = count === 0
          ? "no agents"
          : count === 1
            ? "1 agent"
            : `${count} agents`;
        return `• *${r.name}* — ${r.description} _(${agentNote})_`;
      });

      await respond(`*Available Roles:*\n${lines.join("\n")}`);
    } catch (err) {
      await respond(":x: Something went wrong: " + (err as Error).message);
    }
  });
}
