import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 60_000;

export interface KnowledgeSyncDeps {
  repoUrl: string;
  branch: string;
  localDir: string;
  sshKeyPath: string;
  pullIntervalMinutes: number;
  onReload: () => void;
}

export class KnowledgeSync {
  private deps: KnowledgeSyncDeps;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(deps: KnowledgeSyncDeps) {
    this.deps = deps;
  }

  getKnowledgeDir(): string {
    return this.deps.localDir;
  }

  /** Clone or pull the knowledge repo. Call once at startup. */
  async init(): Promise<void> {
    if (existsSync(join(this.deps.localDir, ".git"))) {
      try {
        await this.gitExec(["pull", "--ff-only", "origin", this.deps.branch], this.deps.localDir);
      } catch {
        console.warn("[git-repos] Knowledge pull failed on init, re-cloning");
        rmSync(this.deps.localDir, { recursive: true, force: true });
        await this.gitExec([
          "clone", "--single-branch", "-b", this.deps.branch,
          this.deps.repoUrl, this.deps.localDir,
        ]);
      }
    } else {
      await this.gitExec([
        "clone", "--single-branch", "-b", this.deps.branch,
        this.deps.repoUrl, this.deps.localDir,
      ]);
    }
  }

  /** Start periodic pull. */
  startPeriodicPull(): void {
    if (this.deps.pullIntervalMinutes <= 0) return;
    const intervalMs = this.deps.pullIntervalMinutes * 60 * 1000;
    this.intervalId = setInterval(() => {
      this.pullOnce().catch((e) => console.error("[git-repos] Knowledge pull error:", e));
    }, intervalMs);
    console.log(`[git-repos] Knowledge sync started (pull every ${this.deps.pullIntervalMinutes}min)`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Pull once. Returns true if files changed and reload was triggered. */
  async pullOnce(): Promise<boolean> {
    const dir = this.deps.localDir;
    if (!existsSync(join(dir, ".git"))) return false;

    // Check for unpushed local commits (from internal generation)
    try {
      const { stdout: unpushed } = await this.gitExec(
        ["log", `origin/${this.deps.branch}..HEAD`, "--oneline"],
        dir
      );
      if (unpushed.trim().length > 0) {
        console.log("[git-repos] Knowledge repo has unpushed local commits, skipping pull");
        return false;
      }
    } catch {
      // origin might not be set up, skip check
    }

    // Record HEAD before pull
    const { stdout: headBefore } = await this.gitExec(["rev-parse", "HEAD"], dir);

    // Fetch and merge
    await this.gitExec(["fetch", "origin", this.deps.branch], dir);
    try {
      await this.gitExec(["merge", "--ff-only", `origin/${this.deps.branch}`], dir);
    } catch {
      // ff-only failed — reset to remote (external changes win)
      console.warn("[git-repos] Knowledge pull ff-only failed, resetting to remote");
      await this.gitExec(["reset", "--hard", `origin/${this.deps.branch}`], dir);
    }

    // Check if HEAD changed
    const { stdout: headAfter } = await this.gitExec(["rev-parse", "HEAD"], dir);
    if (headBefore.trim() !== headAfter.trim()) {
      this.deps.onReload();
      return true;
    }

    return false;
  }

  /** Commit and push local changes (after generation). */
  async commitAndPush(message: string): Promise<void> {
    const dir = this.deps.localDir;
    await this.gitExec(["add", "-A"], dir);

    // Check if there's anything to commit
    try {
      await this.gitExec(["diff", "--cached", "--quiet"], dir);
      return; // Nothing staged
    } catch {
      // diff --quiet exits 1 when there are changes — this is expected
    }

    await this.gitExec(["commit", "-m", message], dir);
    // Pull --rebase before push to handle remote changes
    try {
      await this.gitExec(["pull", "--rebase", "origin", this.deps.branch], dir);
    } catch {
      console.warn("[git-repos] Pull --rebase failed before push, attempting push anyway");
    }
    await this.gitExec(["push", "origin", this.deps.branch], dir);
  }

  private async gitExec(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (this.deps.sshKeyPath) {
      env.GIT_SSH_COMMAND = `ssh -i ${this.deps.sshKeyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3`;
    }
    return execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT,
      env,
    });
  }
}
