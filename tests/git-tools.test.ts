import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GitTools } from "../src/git-tools.js";
import type { RepoConfig } from "../src/types.js";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("GitTools", () => {
  let tools: GitTools;
  let tmpDir: string;
  let repoPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `git-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repoPath = join(tmpDir, "test-repo");
    mkdirSync(repoPath, { recursive: true });

    // Create a real git repo
    execSync("git init", { cwd: repoPath });
    execSync("git config user.email 'test@test.com'", { cwd: repoPath });
    execSync("git config user.name 'Test'", { cwd: repoPath });
    writeFileSync(join(repoPath, "hello.txt"), "Hello World\n");
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "main.ts"), "export const x = 1;\n");
    execSync("git add -A && git commit -m 'initial'", { cwd: repoPath });

    const repos: RepoConfig[] = [
      { name: "test-repo", url: "git@github.com:test/repo.git", branch: "main" },
    ];
    const repoPaths = new Map([["test-repo", repoPath]]);
    tools = new GitTools(repos, repoPaths);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("list_repos returns configured repos", async () => {
    const result = await tools.execute("list_repos", {});
    expect(result).toContain("test-repo");
    expect(result).toContain("git@github.com:test/repo.git");
  });

  it("git_file_read reads a file", async () => {
    const result = await tools.execute("git_file_read", { repo: "test-repo", path: "hello.txt" });
    expect(result).toBe("Hello World\n");
  });

  it("git_file_read rejects path traversal", async () => {
    const result = await tools.execute("git_file_read", { repo: "test-repo", path: "../../etc/passwd" });
    expect(result).toContain("Path traversal denied");
  });

  it("git_search finds matches", async () => {
    const result = await tools.execute("git_search", { repo: "test-repo", query: "export" });
    expect(result).toContain("main.ts");
  });

  it("git_log returns commit history", async () => {
    const result = await tools.execute("git_log", { repo: "test-repo" });
    expect(result).toContain("initial");
  });

  it("returns error for unknown repo", async () => {
    const result = await tools.execute("git_file_read", { repo: "nonexistent", path: "x" });
    expect(result).toContain("Unknown repo");
  });
});
