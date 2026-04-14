import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RepoStore } from "../src/repo-store.js";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("RepoStore", () => {
  let store: RepoStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `repo-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    store = new RepoStore(join(tmpDir, "state.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for unknown repo", () => {
    expect(store.getState("unknown")).toBeNull();
  });

  it("updates and retrieves poll time", () => {
    const now = Date.now();
    store.updatePollTime("my-repo", now, "abc123");
    const state = store.getState("my-repo");
    expect(state).not.toBeNull();
    expect(state!.last_poll_at).toBe(now);
    expect(state!.last_commit_hash).toBe("abc123");
  });

  it("updates scan time", () => {
    const now = Date.now();
    store.updateScanTime("my-repo", now);
    const state = store.getState("my-repo");
    expect(state!.last_scan_at).toBe(now);
  });

  it("upserts on repeated updates", () => {
    store.updatePollTime("my-repo", 1000, "aaa");
    store.updatePollTime("my-repo", 2000, "bbb");
    const state = store.getState("my-repo");
    expect(state!.last_poll_at).toBe(2000);
    expect(state!.last_commit_hash).toBe("bbb");
  });
});
