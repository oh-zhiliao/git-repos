import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoConfig, CommitInfo, MemoCommitEntry } from "./types.js";
import type { RepoStore } from "./repo-store.js";
import type { Notifier } from "./notifier.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

interface RepoFailureState {
  count: number;
  backoffUntil: number;
}

export interface TrackerDeps {
  repos: RepoConfig[];
  repoPaths: Map<string, string>;
  store: RepoStore;
  memoUrl: string;
  notifications: Record<string, string[]>;
  notifier: Notifier;
  sshKeyPath: string;
}

export class Tracker {
  private deps: TrackerDeps;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private repoFailures = new Map<string, RepoFailureState>();

  constructor(deps: TrackerDeps) {
    this.deps = deps;
  }

  start(intervalMinutes: number): void {
    console.log(`[git-repos] Tracker started (polling every ${intervalMinutes}min)`);
    this.intervalId = setInterval(
      () => this.pollOnce().catch((e) => console.error("[git-repos] Poll error:", e)),
      intervalMinutes * 60 * 1000
    );
    this.pollOnce().catch((e) => console.error("[git-repos] Initial poll error:", e));
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async pollOnce(): Promise<void> {
    await Promise.allSettled(
      this.deps.repos.map((repo) => this.pollRepoWithCircuitBreaker(repo))
    );
  }

  private async pollRepoWithCircuitBreaker(repo: RepoConfig): Promise<void> {
    const failure = this.repoFailures.get(repo.name);
    if (failure && Date.now() < failure.backoffUntil) return;

    try {
      await this.pollRepo(repo);
      this.repoFailures.delete(repo.name);
    } catch (e: any) {
      const prev = this.repoFailures.get(repo.name) ?? { count: 0, backoffUntil: 0 };
      prev.count++;
      const backoffMs = Math.min(prev.count * prev.count * 60_000, MAX_BACKOFF_MS);
      prev.backoffUntil = Date.now() + backoffMs;
      this.repoFailures.set(repo.name, prev);
      console.error(
        `[git-repos] Error polling ${repo.name}: ${e.message} (failure #${prev.count}, backoff ${backoffMs / 1000}s)`
      );
    }
  }

  private gitEnv(): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      GIT_SSH_COMMAND: `ssh -i ${this.deps.sshKeyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3`,
    };
  }

  private async pollRepo(repo: RepoConfig): Promise<void> {
    const repoPath = this.deps.repoPaths.get(repo.name);
    if (!repoPath) return;

    // Fetch
    await execFileAsync("git", ["fetch", "origin", repo.branch], {
      cwd: repoPath,
      timeout: GIT_TIMEOUT,
      env: this.gitEnv(),
    });

    // Detect new commits (use \x1e record separator — pipe breaks on commit messages containing |)
    const SEP = "\x1e";
    const { stdout } = await execFileAsync(
      "git",
      ["log", `HEAD..origin/${repo.branch}`, `--format=%H${SEP}%s${SEP}%an${SEP}%aI`],
      { cwd: repoPath, timeout: GIT_TIMEOUT }
    );

    const newCommits: CommitInfo[] = stdout
      .trim()
      .split("\n")
      .filter((line) => line.includes(SEP))
      .map((line) => {
        const [hash, message, author, date] = line.split(SEP);
        return { hash, message, author, date };
      });

    if (newCommits.length === 0) return;

    // Pull (fast-forward)
    await execFileAsync("git", ["merge", "--ff-only", `origin/${repo.branch}`], {
      cwd: repoPath,
      timeout: GIT_TIMEOUT,
    });

    // Build memo entries with diff stats
    const memoEntries: MemoCommitEntry[] = [];
    for (const commit of newCommits) {
      let diffStat = "";
      try {
        const result = await execFileAsync(
          "git",
          ["diff", "--stat", `${commit.hash}~1`, commit.hash],
          { cwd: repoPath, timeout: GIT_TIMEOUT }
        );
        diffStat = result.stdout;
      } catch {
        // First commit or edge case
      }
      memoEntries.push({ ...commit, diff_stat: diffStat });
    }

    // Index to memo service
    try {
      const resp = await fetch(`${this.deps.memoUrl}/index/commits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_name: repo.name, commits: memoEntries }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        console.error(`[git-repos] Memo index failed for ${repo.name}: ${resp.status}`);
      }
    } catch (e: any) {
      console.error(`[git-repos] Failed to index commits for ${repo.name}: ${e.message}`);
    }

    // Update tracking state
    const latestHash = newCommits[0]?.hash ?? "";
    this.deps.store.updatePollTime(repo.name, Date.now(), latestHash);

    // Notify
    const chatIds = this.deps.notifications[repo.name] ?? [];
    await this.deps.notifier.notify(repo.name, newCommits, chatIds);
  }
}
