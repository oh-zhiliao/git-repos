import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KnowledgeGenerator } from "../src/knowledge-generator.js";
import { execSync } from "child_process";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** Creates a minimal git repo with a commit so that git ls-tree works. */
function createGitRepo(dir: string, files: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir });
  execSync("git config user.email 'test@test.com'", { cwd: dir });
  execSync("git config user.name 'Test'", { cwd: dir });

  // Write provided files (or a default one)
  const fileEntries = Object.entries(files);
  if (fileEntries.length === 0) {
    writeFileSync(join(dir, "README.md"), "# Test Repo\n");
  } else {
    for (const [rel, content] of fileEntries) {
      const fullPath = join(dir, rel);
      mkdirSync(fullPath.replace(/\/[^/]+$/, ""), { recursive: true });
      writeFileSync(fullPath, content);
    }
  }

  execSync("git add -A && git commit -m 'initial'", { cwd: dir });
}

const VALID_INDEX = `---
title: Test Repo Knowledge
description: Overview of test-repo
generated_at: 2026-04-14T00:00:00Z
generator_model: test-model
---

# Test Repo

A simple test repository.

## Architecture

Uses a modular design.

TOPIC_PLAN:
- architecture.md: Deep dive into the architecture
- api.md: API reference documentation
`;

const ARCHITECTURE_DOC = `---
title: Architecture
description: Architecture deep-dive
topic: architecture
generated_at: 2026-04-14T00:00:00Z
generator_model: test-model
---

# Architecture

This repo uses a layered architecture with clear separation of concerns.
`;

const API_DOC = `---
title: API Reference
description: API reference documentation
topic: api
generated_at: 2026-04-14T00:00:00Z
generator_model: test-model
---

# API Reference

Public API surface for test-repo.
`;

describe("KnowledgeGenerator", () => {
  let tmpDir: string;
  let repoPath: string;
  let knowledgeDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `kg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    repoPath = join(tmpDir, "source-repo");
    knowledgeDir = join(tmpDir, "knowledge");

    createGitRepo(repoPath, {
      "README.md": "# My Project\nA sample project.\n",
      "package.json": JSON.stringify(
        { name: "my-project", version: "1.0.0" },
        null,
        2
      ),
      "src/index.ts": "export const hello = () => 'Hello World';\n",
    });

    mkdirSync(knowledgeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Test 1: Full successful generation
  // ---------------------------------------------------------------------------
  it("generates index.md and topic docs from valid LLM response", async () => {
    let callCount = 0;
    const mockLLM = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return VALID_INDEX; // Pass 1: index
      if (callCount === 2) return ARCHITECTURE_DOC; // Pass 2: architecture.md
      return API_DOC; // Pass 2: api.md
    });

    const generator = new KnowledgeGenerator(knowledgeDir, {
      callLLM: mockLLM,
    });
    await generator.generate("test-repo", repoPath, 10);

    const repoKnowledgeDir = join(knowledgeDir, "test-repo");
    expect(existsSync(repoKnowledgeDir)).toBe(true);

    // index.md should exist and not contain TOPIC_PLAN section
    const indexPath = join(repoKnowledgeDir, "index.md");
    expect(existsSync(indexPath)).toBe(true);
    const indexContent = readFileSync(indexPath, "utf-8");
    expect(indexContent).toContain("Test Repo Knowledge");
    expect(indexContent).not.toContain("TOPIC_PLAN:");

    // Topic docs should exist
    const archPath = join(repoKnowledgeDir, "architecture.md");
    expect(existsSync(archPath)).toBe(true);
    const archContent = readFileSync(archPath, "utf-8");
    expect(archContent).toContain("Architecture");

    const apiPath = join(repoKnowledgeDir, "api.md");
    expect(existsSync(apiPath)).toBe(true);
    const apiContent = readFileSync(apiPath, "utf-8");
    expect(apiContent).toContain("API Reference");

    // LLM should have been called 3 times (1 index + 2 topics)
    expect(mockLLM).toHaveBeenCalledTimes(3);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Keep existing knowledge if index generation fails
  // ---------------------------------------------------------------------------
  it("keeps existing knowledge dir untouched if index generation fails", async () => {
    // Pre-populate the knowledge dir
    const existingDir = join(knowledgeDir, "my-repo");
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(
      join(existingDir, "index.md"),
      "---\ntitle: Old\n---\n# Old Knowledge\n"
    );
    writeFileSync(
      join(existingDir, "old-topic.md"),
      "---\ntitle: Old Topic\n---\n# Old Topic\n"
    );

    const mockLLM = vi.fn(async () => {
      throw new Error("LLM service unavailable");
    });

    const generator = new KnowledgeGenerator(knowledgeDir, {
      callLLM: mockLLM,
    });

    await expect(
      generator.generate("my-repo", repoPath, 10)
    ).rejects.toThrow("LLM service unavailable");

    // Old content should still exist
    expect(existsSync(join(existingDir, "index.md"))).toBe(true);
    expect(existsSync(join(existingDir, "old-topic.md"))).toBe(true);
    const oldIndex = readFileSync(join(existingDir, "index.md"), "utf-8");
    expect(oldIndex).toContain("Old Knowledge");
  });

  // ---------------------------------------------------------------------------
  // Test 3: Partial success (some topics fail)
  // ---------------------------------------------------------------------------
  it("writes index and successful topics even if some topic generation fails", async () => {
    let callCount = 0;
    const mockLLM = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return VALID_INDEX; // Pass 1: index succeeds
      if (callCount === 2) return ARCHITECTURE_DOC; // First topic succeeds
      throw new Error("Topic generation failed"); // Second topic fails
    });

    const generator = new KnowledgeGenerator(knowledgeDir, {
      callLLM: mockLLM,
    });

    // Should NOT throw even though one topic fails
    await generator.generate("test-repo", repoPath, 10);

    const repoKnowledgeDir = join(knowledgeDir, "test-repo");
    expect(existsSync(repoKnowledgeDir)).toBe(true);

    // index.md should exist
    expect(existsSync(join(repoKnowledgeDir, "index.md"))).toBe(true);

    // First topic should exist
    expect(existsSync(join(repoKnowledgeDir, "architecture.md"))).toBe(true);

    // Second topic should NOT exist (failed)
    expect(existsSync(join(repoKnowledgeDir, "api.md"))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Test 4: Concurrent lock prevents double generation
  // ---------------------------------------------------------------------------
  it("throws when concurrent generation is attempted for the same repo", async () => {
    // Create a slow LLM that we can control timing for
    let resolveFirst!: (value: string) => void;
    const firstCallPromise = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });

    let callCount = 0;
    const mockLLM = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // First call blocks until we resolve it
        return await firstCallPromise;
      }
      return ARCHITECTURE_DOC;
    });

    const generator = new KnowledgeGenerator(knowledgeDir, {
      callLLM: mockLLM,
    });

    // Start first generation (will block on LLM call)
    const firstGen = generator.generate("concurrent-repo", repoPath, 10);

    // Give a tiny bit of time for the first generation to acquire the lock
    await new Promise((r) => setTimeout(r, 10));

    // Attempt second generation immediately — should fail with lock error
    await expect(
      generator.generate("concurrent-repo", repoPath, 10)
    ).rejects.toThrow(/already in progress/);

    // Now resolve the first generation so it can clean up
    resolveFirst(VALID_INDEX);

    // The first generation will now proceed to generate topics; let it finish
    // We need to resolve subsequent topic LLM calls too
    // Since VALID_INDEX has topics, more LLM calls will happen after firstCallPromise resolves
    // Mock returns ARCHITECTURE_DOC for those
    await firstGen;
  });
});
