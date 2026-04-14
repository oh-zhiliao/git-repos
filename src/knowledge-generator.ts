import { execFile } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join, basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 30_000;
const FIND_TIMEOUT = 15_000;
const MAX_KEY_FILE_BYTES = 20 * 1024; // 20KB
const MAX_TOPIC_CONTEXT_BYTES = 10 * 1024; // 10KB
const MAX_FILE_TREE_LINES = 500;
const LOCK_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

const EXCLUDED_DIRS = new Set([
  "node_modules",
  "vendor",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  ".git",
  ".idea",
  ".vscode",
]);

const EXCLUDED_EXTENSIONS = new Set([
  ".lock",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".zip",
  ".tar",
  ".gz",
  ".pdf",
  ".min.js",
  ".min.css",
]);

const KEY_FILE_PATTERNS = [
  "package.json",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "README.md",
  "Dockerfile",
  "docker-compose.yml",
  ".env.example",
];

const ENTRY_POINT_PATTERNS = [
  /^main\.[^/]+$/,
  /^index\.[^/]+$/,
  /^app\.[^/]+$/,
  /^server\.[^/]+$/,
  /^cmd\/[^/]+\/main\.go$/,
  /^src\/main\.[^/]+$/,
  /^src\/index\.[^/]+$/,
];

export interface GeneratorDeps {
  /** Call an LLM with the given system prompt and user prompt. */
  callLLM: (options: {
    system: string;
    prompt: string;
    maxTokens?: number;
  }) => Promise<string>;
}

interface LockInfo {
  pid: number;
  timestamp: number;
}

interface TopicPlan {
  filename: string;
  description: string;
}

/** In-memory lock to prevent concurrent generation in the same process. */
const inProgressRepos = new Set<string>();

export class KnowledgeGenerator {
  private deps: GeneratorDeps;
  private knowledgeDir: string;

  constructor(knowledgeDir: string, deps: GeneratorDeps) {
    this.knowledgeDir = knowledgeDir;
    this.deps = deps;
  }

  /**
   * Generate knowledge documents for a repo.
   * @param repoName  The logical name of the repo (used for directory naming).
   * @param repoPath  Absolute path to the local git clone of the repo.
   * @param maxTopics Maximum number of topic docs to generate.
   */
  async generate(
    repoName: string,
    repoPath: string,
    maxTopics = 10
  ): Promise<void> {
    // In-memory lock check
    if (inProgressRepos.has(repoName)) {
      throw new Error(`Knowledge generation for "${repoName}" is already in progress`);
    }

    const lockPath = join(this.knowledgeDir, `.generation-${repoName}.lock`);

    // File-based lock check
    this.acquireFileLock(repoName, lockPath);

    inProgressRepos.add(repoName);
    try {
      await this._generate(repoName, repoPath, maxTopics, lockPath);
    } finally {
      inProgressRepos.delete(repoName);
      this.releaseFileLock(lockPath);
    }
  }

  private async _generate(
    repoName: string,
    repoPath: string,
    maxTopics: number,
    lockPath: string
  ): Promise<void> {
    // Collect context
    const context = await this.collectContext(repoPath);

    const timestamp = Date.now();
    const tmpDir = join(this.knowledgeDir, `.tmp-${repoName}-${timestamp}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
      // Pass 1: generate index + topic plan
      const { indexContent, topicPlan } = await this.generateIndex(
        repoName,
        context,
        maxTopics
      );

      // Write index.md to tmp dir
      writeFileSync(join(tmpDir, "index.md"), indexContent, "utf-8");

      // Pass 2: generate each topic doc
      for (const topic of topicPlan) {
        try {
          const topicContent = await this.generateTopicDoc(
            repoName,
            topic,
            context,
            indexContent
          );
          writeFileSync(join(tmpDir, topic.filename), topicContent, "utf-8");
        } catch (err) {
          // Partial success: log and continue
          console.warn(
            `[knowledge-generator] Failed to generate topic "${topic.filename}" for ${repoName}:`,
            err
          );
        }
      }

      // Atomic swap: remove old dir, rename tmp to final
      const finalDir = join(this.knowledgeDir, repoName);
      if (existsSync(finalDir)) {
        rmSync(finalDir, { recursive: true, force: true });
      }
      renameSync(tmpDir, finalDir);
    } catch (err) {
      // Clean up tmp dir on total failure
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Context collection
  // ---------------------------------------------------------------------------

  private async collectContext(repoPath: string): Promise<string> {
    const parts: string[] = [];

    // File tree via git ls-tree
    const fileTree = await this.getFileTree(repoPath);
    parts.push(`## File Tree\n\`\`\`\n${fileTree}\n\`\`\``);

    // Key files
    for (const pattern of KEY_FILE_PATTERNS) {
      const filePath = join(repoPath, pattern);
      if (existsSync(filePath)) {
        try {
          const raw = readFileSync(filePath);
          const content = raw.slice(0, MAX_KEY_FILE_BYTES).toString("utf-8");
          parts.push(`## ${pattern}\n\`\`\`\n${content}\n\`\`\``);
        } catch {
          // ignore unreadable files
        }
      }
    }

    // Entry point files (detected from file tree)
    const treeLines = fileTree.split("\n");
    for (const line of treeLines) {
      const fileLine = line.trim();
      if (!fileLine) continue;
      const isEntry = ENTRY_POINT_PATTERNS.some((pat) => pat.test(fileLine));
      if (isEntry) {
        // Check not already added as a key file
        if (!KEY_FILE_PATTERNS.includes(basename(fileLine))) {
          const filePath = join(repoPath, fileLine);
          if (existsSync(filePath)) {
            try {
              const raw = readFileSync(filePath);
              const content = raw.slice(0, MAX_KEY_FILE_BYTES).toString("utf-8");
              parts.push(`## ${fileLine}\n\`\`\`\n${content}\n\`\`\``);
            } catch {
              // ignore
            }
          }
        }
      }
    }

    return parts.join("\n\n");
  }

  private async getFileTree(repoPath: string): Promise<string> {
    try {
      // Use git ls-tree to get tracked files
      const { stdout } = await execFileAsync(
        "git",
        ["ls-tree", "-r", "--name-only", "HEAD"],
        { cwd: repoPath, timeout: GIT_TIMEOUT }
      );

      const lines = stdout
        .split("\n")
        .filter((line) => {
          if (!line.trim()) return false;
          // Check excluded dirs
          const parts = line.split("/");
          for (const part of parts.slice(0, -1)) {
            if (EXCLUDED_DIRS.has(part)) return false;
          }
          // Check excluded extensions
          for (const ext of EXCLUDED_EXTENSIONS) {
            if (line.endsWith(ext)) return false;
          }
          return true;
        })
        .slice(0, MAX_FILE_TREE_LINES);

      return lines.join("\n");
    } catch {
      // Fallback: not a git repo or no HEAD — use find
      try {
        const { stdout } = await execFileAsync(
          "find",
          [
            ".",
            "-type",
            "f",
            ...EXCLUDED_DIRS
              .values()
              .toArray()
              .flatMap((d) => ["-not", "-path", `./${d}/*`]),
          ],
          { cwd: repoPath, timeout: FIND_TIMEOUT }
        );

        const lines = stdout
          .split("\n")
          .map((l) => l.replace(/^\.\//, ""))
          .filter((line) => {
            if (!line.trim()) return false;
            for (const ext of EXCLUDED_EXTENSIONS) {
              if (line.endsWith(ext)) return false;
            }
            return true;
          })
          .slice(0, MAX_FILE_TREE_LINES);

        return lines.join("\n");
      } catch {
        return "";
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pass 1: Index generation
  // ---------------------------------------------------------------------------

  private async generateIndex(
    repoName: string,
    context: string,
    maxTopics: number
  ): Promise<{ indexContent: string; topicPlan: TopicPlan[] }> {
    const system = `You are a technical documentation expert. Your task is to analyze a code repository and produce a comprehensive knowledge overview document.

The document should be 100-200 lines of Markdown with YAML frontmatter including: title, description, generated_at (ISO timestamp), and generator_model fields.

After the main content, include a TOPIC_PLAN section listing specific topic documents to create as deep-dives. Format it exactly as:

TOPIC_PLAN:
- filename.md: Brief description of what this topic covers
- another-topic.md: Another topic description

Include at most ${maxTopics} topics. Each filename must end in .md and use kebab-case. Topics should cover distinct aspects like architecture, API reference, data models, deployment, etc.

The TOPIC_PLAN section must be at the very end, after all other content.`;

    const prompt = `Analyze the following repository context and generate the knowledge index document for repository "${repoName}".

${context}`;

    const raw = await this.deps.callLLM({ system, prompt, maxTokens: 4096 });

    const topicPlan = this.parseTopicPlan(raw);

    // Strip TOPIC_PLAN section from the index content
    const topicPlanIdx = raw.indexOf("\nTOPIC_PLAN:");
    const indexContent =
      topicPlanIdx !== -1 ? raw.slice(0, topicPlanIdx).trimEnd() + "\n" : raw;

    return { indexContent, topicPlan };
  }

  private parseTopicPlan(llmOutput: string): TopicPlan[] {
    const topics: TopicPlan[] = [];
    const lines = llmOutput.split("\n");

    let inTopicPlan = false;
    for (const line of lines) {
      if (line.trim() === "TOPIC_PLAN:") {
        inTopicPlan = true;
        continue;
      }

      if (!inTopicPlan) continue;

      // Stop at empty line or non-matching line after we've found at least one topic
      if (line.trim() === "") {
        if (topics.length > 0) break;
        continue;
      }

      // Match lines like `- filename.md: description`
      const match = line.match(/^[-*]\s+([^\s:]+\.md):\s*(.+)$/);
      if (match) {
        topics.push({
          filename: match[1].trim(),
          description: match[2].trim(),
        });
      } else if (topics.length > 0) {
        // Non-matching line after we've found topics — stop
        break;
      }
    }

    return topics;
  }

  // ---------------------------------------------------------------------------
  // Pass 2: Topic doc generation
  // ---------------------------------------------------------------------------

  private async generateTopicDoc(
    repoName: string,
    topic: TopicPlan,
    context: string,
    indexContent: string
  ): Promise<string> {
    const system = `You are a technical documentation expert. Your task is to produce a focused, deep-dive document about a specific aspect of a code repository.

The document should be 50-150 lines of Markdown with YAML frontmatter including: title, description, topic, generated_at (ISO timestamp), and generator_model fields.

Focus specifically on the topic described. Be precise and technical. Include code examples where relevant.`;

    // Provide a bounded context for topics
    const topicContext = context.slice(0, MAX_TOPIC_CONTEXT_BYTES);

    const prompt = `Generate a deep-dive document for the topic: "${topic.description}"

Repository: ${repoName}
Topic file: ${topic.filename}

## Repository Overview (index.md)
${indexContent.slice(0, 2000)}

## Repository Context (abbreviated)
${topicContext}`;

    return await this.deps.callLLM({ system, prompt, maxTokens: 2048 });
  }

  // ---------------------------------------------------------------------------
  // Lock management
  // ---------------------------------------------------------------------------

  private acquireFileLock(repoName: string, lockPath: string): void {
    mkdirSync(this.knowledgeDir, { recursive: true });

    if (existsSync(lockPath)) {
      try {
        const raw = readFileSync(lockPath, "utf-8");
        const info: LockInfo = JSON.parse(raw);
        const age = Date.now() - info.timestamp;
        if (age < LOCK_STALE_MS) {
          throw new Error(
            `Knowledge generation for "${repoName}" is already in progress (PID ${info.pid})`
          );
        }
        // Stale lock — remove it
        console.warn(
          `[knowledge-generator] Removing stale lock for ${repoName} (PID ${info.pid}, age ${Math.round(age / 60000)}min)`
        );
      } catch (err: any) {
        if (err.message.includes("already in progress")) throw err;
        // JSON parse error or other — treat as stale, overwrite
      }
    }

    const info: LockInfo = { pid: process.pid, timestamp: Date.now() };
    writeFileSync(lockPath, JSON.stringify(info), "utf-8");
  }

  private releaseFileLock(lockPath: string): void {
    try {
      if (existsSync(lockPath)) {
        rmSync(lockPath);
      }
    } catch {
      // ignore cleanup errors
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** List currently generated repos (subdirectories of knowledgeDir). */
  listGeneratedRepos(): string[] {
    if (!existsSync(this.knowledgeDir)) return [];
    return readdirSync(this.knowledgeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  }
}
