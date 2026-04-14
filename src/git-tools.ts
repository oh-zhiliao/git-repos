import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { RepoConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT = 30_000;
const SAFE_COMMIT_RANGE = /^[a-zA-Z0-9~.^\/\-_]+$/;
const MAX_SEARCH_QUERY_LENGTH = 200;

export class GitTools {
  private repos: RepoConfig[];
  private repoPaths: Map<string, string>;

  constructor(repos: RepoConfig[], repoPaths: Map<string, string>) {
    this.repos = repos;
    this.repoPaths = repoPaths;
  }

  async execute(name: string, input: Record<string, any>): Promise<string> {
    try {
      switch (name) {
        case "list_repos":
          return this.listRepos();
        case "git_file_read":
          return this.gitFileRead(input.repo, input.path);
        case "git_search":
          return await this.gitSearch(input.repo, input.query);
        case "git_log":
          return await this.gitLog(input.repo, input.path, input.n);
        case "git_diff":
          return await this.gitDiff(input.repo, input.commit_range);
        case "git_blame":
          return await this.gitBlame(input.repo, input.path, input.lines);
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  private resolveRepoPath(repoName: string): string {
    const path = this.repoPaths.get(repoName);
    if (!path) throw new Error(`Unknown repo: ${repoName}`);
    return path;
  }

  private validatePath(repoPath: string, relativePath: string): string {
    const full = resolve(repoPath, relativePath);
    if (!full.startsWith(repoPath + "/") && full !== repoPath) {
      throw new Error(`Path traversal denied: ${relativePath}`);
    }
    return full;
  }

  private listRepos(): string {
    if (this.repos.length === 0) {
      return "No repositories configured.";
    }
    const lines = this.repos.map((r) => `- ${r.name} (${r.url}) branch=${r.branch}`);
    return `Tracked repositories (${this.repos.length}):\n${lines.join("\n")}`;
  }

  private gitFileRead(repo: string, path: string): string {
    const repoPath = this.resolveRepoPath(repo);
    const fullPath = this.validatePath(repoPath, path);
    try {
      return readFileSync(fullPath, "utf-8");
    } catch {
      return `File not found: ${path}`;
    }
  }

  private async gitSearch(repo: string, query: string): Promise<string> {
    if (query.length > MAX_SEARCH_QUERY_LENGTH) {
      return `Search query too long (max ${MAX_SEARCH_QUERY_LENGTH} chars)`;
    }
    const repoPath = this.resolveRepoPath(repo);
    try {
      const { stdout } = await execFileAsync(
        "git", ["grep", "-n", "--", query],
        { cwd: repoPath, timeout: EXEC_TIMEOUT }
      );
      const lines = stdout.split("\n").slice(0, 50);
      return lines.join("\n") + (stdout.split("\n").length > 50 ? "\n... (truncated)" : "");
    } catch {
      return "No matches found.";
    }
  }

  private async gitLog(repo: string, path?: string, n?: number): Promise<string> {
    const repoPath = this.resolveRepoPath(repo);
    if (path) this.validatePath(repoPath, path);
    const count = String(n ?? 10);
    const args = ["log", `--max-count=${count}`, "--format=%H %s (%an, %ar)"];
    if (path) args.push("--", path);
    const { stdout } = await execFileAsync("git", args, { cwd: repoPath, timeout: EXEC_TIMEOUT });
    return stdout.trim() || "No commits found.";
  }

  private async gitDiff(repo: string, commitRange: string): Promise<string> {
    if (!SAFE_COMMIT_RANGE.test(commitRange)) {
      return `Invalid commit range: ${commitRange}`;
    }
    const repoPath = this.resolveRepoPath(repo);
    const { stdout } = await execFileAsync(
      "git", ["diff", commitRange],
      { cwd: repoPath, timeout: EXEC_TIMEOUT }
    );
    if (stdout.length > 10000) {
      return stdout.slice(0, 10000) + "\n... (truncated, diff too large)";
    }
    return stdout.trim() || "No diff.";
  }

  private async gitBlame(repo: string, path: string, lines?: string): Promise<string> {
    if (lines && !/^\d+,\d+$/.test(lines)) {
      return `Invalid line range: ${lines}`;
    }
    const repoPath = this.resolveRepoPath(repo);
    this.validatePath(repoPath, path);
    const args = ["blame", "--porcelain"];
    if (lines) args.push(`-L${lines}`);
    args.push("--", path);
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: repoPath, timeout: EXEC_TIMEOUT });
      return stdout.trim();
    } catch {
      return `Cannot blame: ${path}`;
    }
  }
}
