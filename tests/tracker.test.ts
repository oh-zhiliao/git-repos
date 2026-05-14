import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracker, type TrackerDeps } from "../src/tracker.js";
import type { RepoStore } from "../src/repo-store.js";
import type { Notifier } from "../src/notifier.js";

function makeDeps(overrides?: Partial<TrackerDeps>): TrackerDeps {
  return {
    repos: [],
    repoPaths: new Map(),
    store: {
      updatePollTime: vi.fn(),
      updateScanTime: vi.fn(),
      getState: vi.fn(),
    } as unknown as RepoStore,
    memoUrl: "http://localhost:8090",
    notifications: {},
    notifier: { notify: vi.fn() } as unknown as Notifier,
    sshKeyPath: "/tmp/key",
    ...overrides,
  };
}

describe("Tracker", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `tracker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts and stops interval without error", () => {
    const tracker = new Tracker(makeDeps());
    tracker.start(5);
    tracker.stop();
  });

  it("pollOnce with empty repos resolves immediately", async () => {
    const tracker = new Tracker(makeDeps());
    await tracker.pollOnce();
    // No error = success
  });

  it("pollOnce skips repo with no local path", async () => {
    const deps = makeDeps({
      repos: [{ name: "missing", url: "git@github.com:x/y.git", branch: "main" }],
      repoPaths: new Map(), // no path for "missing"
    });
    const tracker = new Tracker(deps);
    await tracker.pollOnce();
    expect(deps.store.updatePollTime).not.toHaveBeenCalled();
  });

  it("resets diverged local branch to origin and continues indexing", async () => {
    const remotePath = join(tmpDir, "remote.git");
    const seedClone = join(tmpDir, "seed");
    const localPath = join(tmpDir, "local");
    const remoteClone = join(tmpDir, "remote-work");

    mkdirSync(remotePath, { recursive: true });
    execSync("git init --bare", { cwd: remotePath });

    execSync(`git clone ${remotePath} ${seedClone}`);
    execSync("git config user.email 'test@example.com'", { cwd: seedClone });
    execSync("git config user.name 'Test User'", { cwd: seedClone });
    writeFileSync(join(seedClone, "app.txt"), "base\n");
    execSync("git add app.txt && git commit -m 'base'", { cwd: seedClone });
    execSync("git branch -M main", { cwd: seedClone });
    execSync("git push origin main", { cwd: seedClone });

    execSync(`git clone --branch main ${remotePath} ${localPath}`);
    execSync("git config user.email 'test@example.com'", { cwd: localPath });
    execSync("git config user.name 'Test User'", { cwd: localPath });
    writeFileSync(join(localPath, "app.txt"), "base\nlocal\n");
    execSync("git add app.txt && git commit -m 'local only'", { cwd: localPath });

    execSync(`git clone --branch main ${remotePath} ${remoteClone}`);
    execSync("git config user.email 'test@example.com'", { cwd: remoteClone });
    execSync("git config user.name 'Test User'", { cwd: remoteClone });
    writeFileSync(join(remoteClone, "app.txt"), "base\nremote\n");
    execSync("git add app.txt && git commit -m 'remote only'", { cwd: remoteClone });
    execSync("git push origin main", { cwd: remoteClone });

    const remoteHead = execSync("git rev-parse HEAD", { cwd: remoteClone }).toString().trim();
    const deps = makeDeps({
      repos: [{ name: "demo", url: remotePath, branch: "main" }],
      repoPaths: new Map([["demo", localPath]]),
    });

    const tracker = new Tracker(deps);
    await tracker.pollOnce();

    const localHead = execSync("git rev-parse HEAD", { cwd: localPath }).toString().trim();
    const originHead = execSync("git rev-parse origin/main", { cwd: localPath }).toString().trim();

    expect(localHead).toBe(originHead);
    expect(localHead).toBe(remoteHead);
    expect(deps.store.updatePollTime).toHaveBeenCalledWith("demo", expect.any(Number), remoteHead);
    expect(deps.notifier.notify).toHaveBeenCalledOnce();
  });
});
