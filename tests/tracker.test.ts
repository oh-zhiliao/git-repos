import { describe, it, expect, vi, beforeEach } from "vitest";
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
});
