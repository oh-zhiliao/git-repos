import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Scanner, type ScannerDeps } from "../src/scanner.js";
import type { RepoStore } from "../src/repo-store.js";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Scanner", () => {
  describe("listFiles", () => {
    let tmpDir: string;
    let scanner: Scanner;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `scanner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tmpDir, { recursive: true });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

      scanner = new Scanner({
        repos: [],
        repoPaths: new Map(),
        store: { updateScanTime: vi.fn() } as unknown as RepoStore,
        memoUrl: "http://localhost:8090",
      });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    });

    it("lists files recursively", () => {
      mkdirSync(join(tmpDir, "src"), { recursive: true });
      writeFileSync(join(tmpDir, "README.md"), "hello");
      writeFileSync(join(tmpDir, "src", "main.ts"), "code");

      const files = scanner.listFiles(tmpDir);
      expect(files).toContain("README.md");
      expect(files).toContain(join("src", "main.ts"));
    });

    it("excludes node_modules and other blacklisted dirs", () => {
      mkdirSync(join(tmpDir, "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(tmpDir, "dist"), { recursive: true });
      mkdirSync(join(tmpDir, "src"), { recursive: true });
      writeFileSync(join(tmpDir, "node_modules", "pkg", "index.js"), "x");
      writeFileSync(join(tmpDir, "dist", "bundle.js"), "x");
      writeFileSync(join(tmpDir, "src", "app.ts"), "x");

      const files = scanner.listFiles(tmpDir);
      expect(files).toContain(join("src", "app.ts"));
      expect(files).not.toContain(expect.stringContaining("node_modules"));
      expect(files).not.toContain(expect.stringContaining("dist"));
    });

    it("excludes dotfiles and dotdirs", () => {
      mkdirSync(join(tmpDir, ".git", "objects"), { recursive: true });
      writeFileSync(join(tmpDir, ".gitignore"), "x");
      writeFileSync(join(tmpDir, ".git", "objects", "abc"), "x");
      writeFileSync(join(tmpDir, "visible.txt"), "x");

      const files = scanner.listFiles(tmpDir);
      expect(files).toEqual(["visible.txt"]);
    });

    it("skips symlinks", () => {
      writeFileSync(join(tmpDir, "real.txt"), "x");
      symlinkSync(join(tmpDir, "real.txt"), join(tmpDir, "link.txt"));

      const files = scanner.listFiles(tmpDir);
      expect(files).toContain("real.txt");
      expect(files).not.toContain("link.txt");
    });

    it("returns empty array for nonexistent dir", () => {
      const files = scanner.listFiles("/nonexistent/path");
      expect(files).toEqual([]);
    });
  });

  it("starts and stops daily timer", () => {
    const scanner = new Scanner({
      repos: [],
      repoPaths: new Map(),
      store: { updateScanTime: vi.fn() } as unknown as RepoStore,
      memoUrl: "http://localhost:8090",
    });
    scanner.startDaily(3);
    scanner.stop();
  });

  it("authenticates scan and decay requests to memo", async () => {
    const tmpDir = join(tmpdir(), `scanner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "README.md"), "hello");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    try {
      const store = { updateScanTime: vi.fn() } as unknown as RepoStore;
      const scanner = new Scanner({
        repos: [{ name: "app", url: "git@example.com:org/app.git", branch: "main" }],
        repoPaths: new Map([["app", tmpDir]]),
        store,
        memoUrl: "http://localhost:8090",
        memoAuthToken: "scanner-token",
      } as any);

      await scanner.scanOnce();

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:8090/index/scan",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer scanner-token",
          }),
        })
      );
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:8090/index/decay",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer scanner-token",
          }),
        })
      );
    } finally {
      vi.unstubAllGlobals();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
