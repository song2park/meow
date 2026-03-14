import simpleGit, { SimpleGit } from "simple-git";
import * as fs from "fs";
import * as path from "path";
import { config, workspaceRepoPath } from "../config";

/**
 * Ensure the agent branch exists locally and remotely, then check it out.
 * The branch is created from `dev` if it doesn't already exist.
 * Returns the SimpleGit instance configured with the agent's identity.
 */
export async function ensureAgentBranch(branchName: string): Promise<SimpleGit> {
  const git = simpleGit(workspaceRepoPath);

  // Fetch remote so we have up-to-date remote refs
  try {
    await git.fetch("origin");
  } catch {
    // Non-fatal: remote may not be configured in local dev
    console.warn("[git] fetch failed — proceeding without remote sync");
  }

  const branchSummary = await git.branchLocal();
  const localBranches = Object.keys(branchSummary.branches);

  if (localBranches.includes(branchName)) {
    // Branch already exists locally — just check it out
    await git.checkout(branchName);
  } else {
    // Create branch from dev
    await git.checkout("dev");
    await git.checkoutLocalBranch(branchName);
  }

  return git;
}

/**
 * Write file content to `agents/<agentName>/<filename>` inside workspaceRepoPath.
 * Ensures the directory exists before writing.
 * Returns the relative file path written.
 */
export async function writeAgentFile(
  agentName: string,
  filename: string,
  content: string
): Promise<string> {
  const relativePath = path.join("agents", agentName, filename);
  const absolutePath = path.join(workspaceRepoPath, relativePath);

  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(absolutePath, content, "utf-8");
  return relativePath;
}

/**
 * Stage all changes, commit with agent identity, and push to remote.
 * Returns the commit SHA.
 */
export async function commitAndPush(
  git: SimpleGit,
  agentName: string,
  agentRole: string,
  message: string
): Promise<string> {
  // Set per-commit git identity for this agent
  await git.addConfig("user.name", `${agentName} (${agentRole})`, false, "local");
  await git.addConfig(
    "user.email",
    `agent-${agentName.toLowerCase()}@multi-agent-orch`,
    false,
    "local"
  );

  const branchName = `agent/${agentName}`;

  try {
    // Stage everything under agents/<agentName>/
    await git.add(".");

    const commitResult = await git.commit(message);
    const sha = commitResult.commit;

    // Push and set upstream on first push
    await git.push(["--set-upstream", "origin", branchName]);

    return sha;
  } finally {
    // Always return to dev so the working tree is never left on an agent branch
    await git.checkout("dev");
  }
}

/**
 * Create a GitHub PR from `agent/<agentName>` → `dev` via the GitHub REST API.
 * Returns the PR URL, or null if GIT_REPO_URL is not set (local-only repo).
 * Throws if GITHUB_TOKEN is not configured but GIT_REPO_URL is set.
 */
export async function createAgentPR(opts: {
  agentName: string;
  agentRole: string;
  taskDescription: string;
  filesChanged: string[];
  slackThreadUrl?: string;
}): Promise<string | null> {
  if (!config.GIT_REPO_URL) {
    console.log("[git] GIT_REPO_URL not set — skipping PR creation");
    return null;
  }

  const { agentName, agentRole, taskDescription, filesChanged, slackThreadUrl } = opts;

  if (!config.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is not set — cannot create PR");
  }

  const head = `agent/${agentName}`;
  const base = "dev";
  const title = `[${agentName}] Task: ${taskDescription}`;

  const fileList = filesChanged.map((f) => `- \`${f}\``).join("\n");
  const slackSection = slackThreadUrl ? `\n\n**Slack thread:** ${slackThreadUrl}` : "";

  const body = [
    `**Agent:** ${agentName} (${agentRole})`,
    `**Task:** ${taskDescription}`,
    "",
    "**Files changed:**",
    fileList,
    slackSection,
  ]
    .join("\n")
    .trim();

  const apiBase = `https://api.github.com/repos/${config.REPO_OWNER}/${config.REPO_NAME}`;
  const commonHeaders = {
    Authorization: `Bearer ${config.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Check for an existing open PR to avoid GitHub 422 on duplicates
  const existingUrl =
    `${apiBase}/pulls` +
    `?head=${encodeURIComponent(`${config.REPO_OWNER}:${head}`)}` +
    `&base=${encodeURIComponent(base)}&state=open`;

  const existingResponse = await fetch(existingUrl, { headers: commonHeaders });
  if (existingResponse.ok) {
    const existing = (await existingResponse.json()) as { html_url: string }[];
    if (existing.length > 0) {
      return existing[0].html_url;
    }
  }

  const response = await fetch(`${apiBase}/pulls`, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({ title, head, base, body }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as { html_url: string };
  return data.html_url;
}
