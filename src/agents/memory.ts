import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";

const anthropic = new Anthropic();

const MEMORY_CHAR_CAP = 8000;
const MEMORY_LIMIT = 10;
const FALLBACK_LIMIT = 3;

export interface MemoryEntry {
  instruction: string;
  responseText: string | null;
  summary: string | null;
  completedAt: Date;
}

/**
 * Fetch last N completed tasks for an agent, most recent first.
 */
export async function getAgentMemory(agentId: string, limit = MEMORY_LIMIT): Promise<MemoryEntry[]> {
  const result = await db.query<{
    instruction: string;
    response_text: string | null;
    summary: string | null;
    completed_at: Date;
  }>(
    `SELECT instruction, response_text, summary, completed_at
     FROM agent_tasks
     WHERE agent_id = $1 AND status = 'completed'
     ORDER BY completed_at DESC
     LIMIT $2`,
    [agentId, limit]
  );

  return result.rows.map((row) => ({
    instruction: row.instruction,
    responseText: row.response_text,
    summary: row.summary,
    completedAt: row.completed_at,
  }));
}

/**
 * Build a context string from memory entries, respecting ~8000 char cap.
 * Uses summary if available, falls back to truncated response_text.
 * If still over cap with all entries, returns only the last 3.
 */
export function buildMemoryContext(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";

  const formatEntry = (entry: MemoryEntry, useSummary: boolean): string => {
    const date = entry.completedAt.toISOString().slice(0, 10);
    const body = useSummary && entry.summary
      ? entry.summary
      : (entry.responseText ?? entry.summary ?? "(no content)");
    return `- [${date}] Task: ${entry.instruction}\n  Result: ${body}`;
  };

  // First pass: use summaries when available
  const lines = entries.map((e) => formatEntry(e, true));
  const joined = lines.join("\n\n");

  if (joined.length <= MEMORY_CHAR_CAP) {
    return joined;
  }

  // Still over cap — fall back to last 3 entries only, with summaries
  const fallbackEntries = entries.slice(0, FALLBACK_LIMIT);
  const fallbackLines = fallbackEntries.map((e) => formatEntry(e, true));
  return fallbackLines.join("\n\n");
}

/**
 * Save response_text and generate a summary via Claude, then persist both.
 */
export async function saveTaskMemory(taskId: string, responseText: string): Promise<void> {
  // Fetch the instruction for this task so we can include it in the summary prompt
  const taskResult = await db.query<{ instruction: string }>(
    "SELECT instruction FROM agent_tasks WHERE id = $1",
    [taskId]
  );

  const instruction = taskResult.rows[0]?.instruction ?? "";

  // Generate a brief summary using a fast/cheap model
  const summaryResponse = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    system: "Summarize this agent task completion in 1-2 sentences.",
    messages: [
      {
        role: "user",
        content: `Task: ${instruction}\nResponse: ${responseText}`,
      },
    ],
  });

  const summaryBlock = summaryResponse.content[0];
  const summary = summaryBlock.type === "text" ? summaryBlock.text.trim() : "";

  await db.query(
    "UPDATE agent_tasks SET response_text = $1, summary = $2 WHERE id = $3",
    [responseText, summary, taskId]
  );
}
