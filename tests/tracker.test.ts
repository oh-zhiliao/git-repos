import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Tracker, type TrackerDeps } from "../src/tracker.js";
import type { RepoStore } from "../src/repo-store.js";
import type { Notifier } from "../src/notifier.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

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
  beforeEach(() => {
    execFileMock.mockReset();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("authenticates commit indexing requests to memo", async () => {
    const sep = "\x1e";
    execFileMock.mockImplementation((_cmd, args: string[], _opts, cb) => {
      if (args[0] === "log") {
        cb(null, { stdout: `abc123${sep}fix auth${sep}alice${sep}2026-05-28T00:00:00Z\n`, stderr: "" });
        return;
      }
      if (args[0] === "diff") {
        cb(null, { stdout: " src/index.ts | 2 +-\n", stderr: "" });
        return;
      }
      cb(null, { stdout: "", stderr: "" });
    });

    const deps = makeDeps({
      repos: [{ name: "app", url: "git@example.com:org/app.git", branch: "main" }],
      repoPaths: new Map([["app", "/tmp/app"]]),
      memoAuthToken: "tracker-token",
    } as any);
    const tracker = new Tracker(deps);

    await tracker.pollOnce();

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8090/index/commits",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer tracker-token",
        }),
      })
    );
  });
});
