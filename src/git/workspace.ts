import simpleGit from "simple-git";
import * as fs from "fs";
import { config, workspaceRepoPath } from "../config";

/**
 * Initialise the agent workspace repo once at startup, before accepting jobs.
 *
 * - If the directory does not exist:
 *     - GIT_REPO_URL set  → clone the remote repo into workspaceRepoPath
 *     - GIT_REPO_URL unset → mkdir + git init + empty initial commit
 * - If the directory exists and GIT_REPO_URL is set:
 *     → ensure remote `origin` points to GIT_REPO_URL (set-url)
 */
export async function initWorkspace(): Promise<void> {
  const exists = fs.existsSync(workspaceRepoPath);

  if (!exists) {
    if (config.GIT_REPO_URL) {
      console.log(`[workspace] Cloning ${config.GIT_REPO_URL} → ${workspaceRepoPath}`);
      const git = simpleGit();
      await git.clone(config.GIT_REPO_URL, workspaceRepoPath);
      console.log("[workspace] Clone complete.");
    } else {
      console.log(`[workspace] Initialising local repo at ${workspaceRepoPath}`);
      fs.mkdirSync(workspaceRepoPath, { recursive: true });
      const git = simpleGit(workspaceRepoPath);
      await git.init();
      // Create an initial empty commit so branches can be created from it
      await git.addConfig("user.name", "multi-agent-orch", false, "local");
      await git.addConfig("user.email", "bot@multi-agent-orch", false, "local");
      await git.commit("chore: initial empty commit", [], { "--allow-empty": null });
      console.log("[workspace] Local repo initialised.");
    }
  } else {
    // Directory exists — ensure it's a git repo
    const isGitRepo = fs.existsSync(`${workspaceRepoPath}/.git`);
    if (!isGitRepo) {
      console.log(`[workspace] Directory exists but is not a git repo — initialising at ${workspaceRepoPath}`);
      const git = simpleGit(workspaceRepoPath);
      await git.init();
      await git.addConfig("user.name", "multi-agent-orch", false, "local");
      await git.addConfig("user.email", "bot@multi-agent-orch", false, "local");
      await git.commit("chore: initial empty commit", [], { "--allow-empty": null });
    }

    if (config.GIT_REPO_URL) {
      console.log(`[workspace] Ensuring remote origin → ${config.GIT_REPO_URL}`);
      const git = simpleGit(workspaceRepoPath);
      try {
        await git.remote(["set-url", "origin", config.GIT_REPO_URL]);
      } catch {
        await git.addRemote("origin", config.GIT_REPO_URL);
      }
      console.log("[workspace] Remote origin configured.");
    } else {
      console.log(`[workspace] Workspace ready at ${workspaceRepoPath} (local-only mode).`);
    }
  }
}
