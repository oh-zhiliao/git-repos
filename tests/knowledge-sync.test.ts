import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KnowledgeSync } from "../src/knowledge-sync.js";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("KnowledgeSync", () => {
  let tmpDir: string;
  let bareRepoPath: string;
  let localDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `knowledge-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    bareRepoPath = join(tmpDir, "knowledge.git");
    localDir = join(tmpDir, "knowledge-local");

    // Create a bare git repo to act as remote
    mkdirSync(bareRepoPath, { recursive: true });
    execSync("git init --bare", { cwd: bareRepoPath });

    // Clone, add content, push
    const cloneTmp = join(tmpDir, "clone-tmp");
    execSync(`git clone ${bareRepoPath} ${cloneTmp}`);
    execSync("git config user.email 'test@test.com'", { cwd: cloneTmp });
    execSync("git config user.name 'Test'", { cwd: cloneTmp });
    mkdirSync(join(cloneTmp, "test-repo"), { recursive: true });
    writeFileSync(
      join(cloneTmp, "test-repo", "index.md"),
      "---\ntitle: Test\ndescription: Test repo\ngenerated_at: 2026-04-14T00:00:00Z\ngenerator_model: test\n---\n# Test\n"
    );
    execSync("git add -A && git commit -m 'init knowledge'", { cwd: cloneTmp });
    execSync("git push", { cwd: cloneTmp });
    rmSync(cloneTmp, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clones knowledge repo on init if local dir does not exist", async () => {
    const sync = new KnowledgeSync({
      repoUrl: bareRepoPath,
      branch: "master",
      localDir,
      sshKeyPath: "",
      pullIntervalMinutes: 0,
      onReload: () => {},
    });

    await sync.init();

    expect(existsSync(join(localDir, "test-repo", "index.md"))).toBe(true);
  });

  it("pulls new changes on sync", async () => {
    const reloadSpy = vi.fn();
    const sync = new KnowledgeSync({
      repoUrl: bareRepoPath,
      branch: "master",
      localDir,
      sshKeyPath: "",
      pullIntervalMinutes: 0,
      onReload: reloadSpy,
    });
    await sync.init();

    // Push new content to bare repo
    const cloneTmp = join(tmpDir, "clone-tmp2");
    execSync(`git clone ${bareRepoPath} ${cloneTmp}`);
    execSync("git config user.email 'test@test.com'", { cwd: cloneTmp });
    execSync("git config user.name 'Test'", { cwd: cloneTmp });
    writeFileSync(join(cloneTmp, "test-repo", "modules.md"), "---\ntitle: Modules\n---\n# Modules\n");
    execSync("git add -A && git commit -m 'add modules'", { cwd: cloneTmp });
    execSync("git push", { cwd: cloneTmp });
    rmSync(cloneTmp, { recursive: true, force: true });

    const changed = await sync.pullOnce();

    expect(changed).toBe(true);
    expect(existsSync(join(localDir, "test-repo", "modules.md"))).toBe(true);
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it("returns false when no changes on pull", async () => {
    const reloadSpy = vi.fn();
    const sync = new KnowledgeSync({
      repoUrl: bareRepoPath,
      branch: "master",
      localDir,
      sshKeyPath: "",
      pullIntervalMinutes: 0,
      onReload: reloadSpy,
    });
    await sync.init();

    const changed = await sync.pullOnce();

    expect(changed).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("getKnowledgeDir returns the local dir", async () => {
    const sync = new KnowledgeSync({
      repoUrl: bareRepoPath,
      branch: "master",
      localDir,
      sshKeyPath: "",
      pullIntervalMinutes: 0,
      onReload: () => {},
    });
    await sync.init();

    expect(sync.getKnowledgeDir()).toBe(localDir);
  });
});
