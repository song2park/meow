import Anthropic from "@anthropic-ai/sdk";
import simpleGit from "simple-git";
import { db } from "../db";

const anthropic = new Anthropic();

const MEMORY_CHAR_CAP = 8000;
const MEMORY_LIMIT = 10;
const FALLBACK_LIMIT = 3;
const FILE_CONTENT_CAP = 2000;
const FILES_TOTAL_CAP = 6000;

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
 * Read files from an agent's git branch without checking out.
 * Uses `git ls-tree` to list files and `git show` to read content.
 * Returns [] if the branch doesn't exist yet.
 * Caps total content at ~6000 chars; truncates individual files at 2000 chars.
 */
export async function getAgentFiles(agentName: string): Promise<Array<{ filename: string; content: string }>> {
  const git = simpleGit(process.cwd());
  const branch = `agent/${agentName}`;
  const treePrefix = `agents/${agentName}/`;

  let filenames: string[];
  try {
    const lsOutput = await git.raw(["ls-tree", "--name-only", branch, "--", treePrefix]);
    filenames = lsOutput
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
      // Strip the directory prefix to get just the base filename
      .map((f) => f.replace(treePrefix, ""));
  } catch {
    // Branch doesn't exist yet
    return [];
  }

  if (filenames.length === 0) return [];

  // Determine file order from newest to oldest using git log
  let orderedFilenames: string[] = filenames;
  try {
    const logOutput = await git.raw([
      "log",
      "--name-only",
      "--pretty=format:",
      branch,
      "--",
      treePrefix,
    ]);
    const logFiles = logOutput
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
      .map((f) => f.replace(treePrefix, ""))
      .filter((f) => filenames.includes(f));

    // Deduplicate while preserving first-seen order (newest first)
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const f of logFiles) {
      if (!seen.has(f)) {
        seen.add(f);
        deduped.push(f);
      }
    }
    // Any files not captured by log go at the end
    for (const f of filenames) {
      if (!seen.has(f)) deduped.push(f);
    }
    orderedFilenames = deduped;
  } catch {
    // Fall back to ls-tree order
  }

  const result: Array<{ filename: string; content: string }> = [];
  let totalChars = 0;

  for (const filename of orderedFilenames) {
    if (totalChars >= FILES_TOTAL_CAP) break;

    try {
      let content = await git.raw(["show", `${branch}:${treePrefix}${filename}`]);
      if (content.length > FILE_CONTENT_CAP) {
        content = content.slice(0, FILE_CONTENT_CAP) + "\n[truncated]";
      }
      totalChars += content.length;
      result.push({ filename, content });
    } catch {
      // Skip unreadable files
    }
  }

  return result;
}

/**
 * Build a context string from memory entries, respecting ~8000 char cap.
 * Uses summary if available, falls back to truncated response_text.
 * If still over cap with all entries, returns only the last 3.
 * Appends a "Your Previous Files" section if files are provided.
 */
export function buildMemoryContext(entries: MemoryEntry[], files: Array<{ filename: string; content: string }> = []): string {
  const formatEntry = (entry: MemoryEntry, useSummary: boolean): string => {
    const date = entry.completedAt.toISOString().slice(0, 10);
    const body = useSummary && entry.summary
      ? entry.summary
      : (entry.responseText ?? entry.summary ?? "(no content)");
    return `- [${date}] Task: ${entry.instruction}\n  Result: ${body}`;
  };

  let taskHistorySection = "";

  if (entries.length > 0) {
    // First pass: use summaries when available
    const lines = entries.map((e) => formatEntry(e, true));
    const joined = lines.join("\n\n");

    if (joined.length <= MEMORY_CHAR_CAP) {
      taskHistorySection = joined;
    } else {
      // Still over cap — fall back to last 3 entries only, with summaries
      const fallbackEntries = entries.slice(0, FALLBACK_LIMIT);
      const fallbackLines = fallbackEntries.map((e) => formatEntry(e, true));
      taskHistorySection = fallbackLines.join("\n\n");
    }
  }

  let filesSection = "";
  if (files.length > 0) {
    const fileParts = files.map(
      ({ filename, content }) => `### ${filename}\n\`\`\`\n${content}\n\`\`\``
    );
    filesSection = `## Your Previous Files\n\n${fileParts.join("\n\n")}`;
  }

  const parts: string[] = [];
  if (taskHistorySection) parts.push(taskHistorySection);
  if (filesSection) parts.push(filesSection);

  return parts.join("\n\n");
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
