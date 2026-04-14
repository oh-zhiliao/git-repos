import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { RepoConfig } from "./types.js";
import type { RepoStore } from "./repo-store.js";

const EXCLUDED_DIRS = new Set([
  "node_modules",
  "vendor",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
]);

export interface ScannerDeps {
  repos: RepoConfig[];
  repoPaths: Map<string, string>;
  store: RepoStore;
  memoUrl: string;
}

export class Scanner {
  private deps: ScannerDeps;
  private timerId: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: ScannerDeps) {
    this.deps = deps;
  }

  startDaily(cronHour: number = 2): void {
    const scheduleNext = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(cronHour, 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);

      const delay = next.getTime() - now.getTime();
      console.log(`[git-repos] Scanner: next scan at ${next.toISOString()}`);

      this.timerId = setTimeout(() => {
        this.scanOnce()
          .catch((e) => console.error("[git-repos] Scan error:", e))
          .finally(scheduleNext);
      }, delay);
    };

    scheduleNext();
  }

  stop(): void {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  async scanOnce(): Promise<void> {
    console.log(`[git-repos] Scanner: scanning ${this.deps.repos.length} repos`);

    for (const repo of this.deps.repos) {
      const repoPath = this.deps.repoPaths.get(repo.name);
      if (!repoPath) continue;

      try {
        // Trigger memo to scan
        await fetch(`${this.deps.memoUrl}/index/scan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo_name: repo.name, repo_path: repoPath }),
          signal: AbortSignal.timeout(60_000),
        });

        // Collect file list for decay
        const files = this.listFiles(repoPath);
        await fetch(`${this.deps.memoUrl}/index/decay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo_name: repo.name, existing_files: files }),
          signal: AbortSignal.timeout(60_000),
        });

        this.deps.store.updateScanTime(repo.name, Date.now());
      } catch (e: any) {
        console.error(`[git-repos] Scanner error for ${repo.name}: ${e.message}`);
      }
    }
  }

  /** Exposed for testing */
  listFiles(dir: string): string[] {
    const files: string[] = [];
    try {
      this.walkDir(dir, dir, files);
    } catch {
      // Directory doesn't exist
    }
    return files;
  }

  private walkDir(baseDir: string, currentDir: string, files: string[]): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || EXCLUDED_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        this.walkDir(baseDir, fullPath, files);
      } else {
        files.push(relative(baseDir, fullPath));
      }
    }
  }
}
