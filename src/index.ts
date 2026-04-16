import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type {
  ToolPlugin,
  ToolDefinition,
  PluginContext,
  PluginCommandHandler,
} from "../../agent/src/agent/tool-plugin.js";
import type { GitReposPluginConfig, RepoConfig } from "./types.js";
import { GitTools } from "./git-tools.js";
import { RepoStore } from "./repo-store.js";
import { Tracker } from "./tracker.js";
import { Scanner } from "./scanner.js";
import { Notifier } from "./notifier.js";
import { createCommandHandler } from "./repo-commands.js";
import { KnowledgeSync } from "./knowledge-sync.js";
import { KnowledgeGenerator } from "./knowledge-generator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "..");
const KNOWLEDGE_DIR = resolve(PLUGIN_ROOT, "knowledge");

interface TopicDocMeta {
  title: string;
  description: string;
  filePath: string;
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep > 0) {
      const key = line.slice(0, sep).trim();
      let val = line.slice(sep + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
  }
  return { meta, body: match[2] };
}

export default class GitReposPlugin implements ToolPlugin {
  name = "";
  private config!: GitReposPluginConfig;
  private gitTools!: GitTools;
  private store!: RepoStore;
  private tracker!: Tracker;
  private scanner!: Scanner;
  private commandHandler!: PluginCommandHandler;
  private repoPaths = new Map<string, string>();
  private knowledgeDocs = new Map<string, Map<string, TopicDocMeta>>();
  private knowledgeCatalogs = new Map<string, string>();
  private knowledgeSync: KnowledgeSync | null = null;
  private knowledgeGenerator: KnowledgeGenerator | null = null;
  private knowledgeDir: string | null = null;
  private generationTimerId: ReturnType<typeof setTimeout> | null = null;

  async init(config: Record<string, any>): Promise<void> {
    if (!config.repos || !Array.isArray(config.repos) || config.repos.length === 0) {
      throw new Error("repos is required and must be a non-empty array");
    }
    if (!config.repos_dir) throw new Error("repos_dir is required");
    if (!config.ssh_key_path) throw new Error("ssh_key_path is required");
    if (!config.memo_url) throw new Error("memo_url is required");

    this.config = config as GitReposPluginConfig;

    // Validate branch names (prevent command injection)
    const SAFE_BRANCH = /^[a-zA-Z0-9._\/-]+$/;
    for (const repo of this.config.repos) {
      if (!SAFE_BRANCH.test(repo.branch)) {
        throw new Error(`Invalid branch name for ${repo.name}: "${repo.branch}"`);
      }
    }

    // Ensure repos_dir exists
    mkdirSync(this.config.repos_dir, { recursive: true });

    // Clone missing repos, resolve paths
    for (const repo of this.config.repos) {
      const repoPath = join(this.config.repos_dir, repo.name);
      if (!existsSync(repoPath)) {
        console.log(`[${this.name}] Cloning ${repo.name} from ${repo.url}...`);
        execFileSync("git", [
          "clone", "--single-branch", "-b", repo.branch,
          repo.url, repoPath,
        ], {
          timeout: 120_000,
          env: {
            ...process.env,
            GIT_SSH_COMMAND: `ssh -i ${this.config.ssh_key_path} -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3`,
          },
        });
      }
      this.repoPaths.set(repo.name, repoPath);
    }

    // Init sub-components
    this.store = new RepoStore(join(this.config.repos_dir, ".git-repos-state.db"));
    this.gitTools = new GitTools(this.config.repos, this.repoPaths);
    this.commandHandler = createCommandHandler({
      repos: this.config.repos,
      store: this.store,
      admins: this.config.admins ?? [],
      repoPaths: this.repoPaths,
      knowledgeDir: this.knowledgeDir,
      knowledgeGenerator: null,
      knowledgeSync: null,
      maxTopics: this.config.knowledge?.generation?.max_topics ?? 10,
      language: this.config.knowledge?.generation?.language ?? "Chinese",
    });

    // Init knowledge system
    const kc = this.config.knowledge;
    if (kc) {
      // If repo_url == local_dir, it's a local-only repo — skip sync, just use the dir directly
      const isLocalOnly = kc.repo_url === kc.local_dir;

      if (isLocalOnly) {
        if (existsSync(join(kc.local_dir, ".git"))) {
          this.knowledgeDir = kc.local_dir;
          console.log(`[${this.name}] Using local knowledge repo at ${kc.local_dir}`);
        } else {
          console.warn(`[${this.name}] Knowledge local_dir ${kc.local_dir} has no .git — skipping knowledge.`);
        }
      } else {
        this.knowledgeSync = new KnowledgeSync({
          repoUrl: kc.repo_url,
          branch: kc.branch,
          localDir: kc.local_dir,
          sshKeyPath: this.config.ssh_key_path,
          pullIntervalMinutes: kc.sync?.pull_interval_minutes ?? 30,
          onReload: () => this.loadKnowledge(),
        });

        try {
          await this.knowledgeSync.init();
          this.knowledgeDir = kc.local_dir;
          console.log(`[${this.name}] Knowledge repo initialized at ${kc.local_dir}`);
        } catch (e: any) {
          console.warn(`[${this.name}] Knowledge repo init failed: ${e.message}. Continuing without knowledge.`);
          this.knowledgeDir = null;
        }
      }
    }

    // Load knowledge (from external dir if configured, else from bundled dir)
    this.loadKnowledge();
  }

  async start(context: PluginContext): Promise<void> {
    const notifier = new Notifier(context);

    this.tracker = new Tracker({
      repos: this.config.repos,
      repoPaths: this.repoPaths,
      store: this.store,
      memoUrl: this.config.memo_url,
      notifications: this.config.notifications ?? {},
      notifier,
      sshKeyPath: this.config.ssh_key_path,
    });
    this.tracker.start(this.config.poll_interval_minutes);

    this.scanner = new Scanner({
      repos: this.config.repos,
      repoPaths: this.repoPaths,
      store: this.store,
      memoUrl: this.config.memo_url,
    });

    // Parse cron hour from deep_scan_cron
    let cronHour = 2;
    const cronStr = this.config.deep_scan_cron;
    if (cronStr) {
      const parts = cronStr.split(" ");
      if (parts.length >= 2) cronHour = parseInt(parts[1], 10);
      if (Number.isNaN(cronHour)) cronHour = 2;
    }
    this.scanner.startDaily(cronHour);

    // Start knowledge sync
    if (this.knowledgeSync) {
      this.knowledgeSync.startPeriodicPull();
    }

    // Init knowledge generator if generation is enabled
    const genConfig = this.config.knowledge?.generation;
    if (genConfig?.enabled && context.callLLM) {
      this.knowledgeGenerator = new KnowledgeGenerator(
        this.config.knowledge!.local_dir,
        {
          callLLM: (options) => context.callLLM!(options),
        }
      );

      // Schedule cron-based generation
      if (genConfig.cron) {
        this.scheduleKnowledgeGeneration(genConfig.cron);
      }
    }

    // Recreate command handler with full deps (generator/sync now available)
    this.commandHandler = createCommandHandler({
      repos: this.config.repos,
      store: this.store,
      admins: this.config.admins ?? [],
      repoPaths: this.repoPaths,
      knowledgeDir: this.knowledgeDir,
      knowledgeGenerator: this.knowledgeGenerator,
      knowledgeSync: this.knowledgeSync,
      maxTopics: this.config.knowledge?.generation?.max_topics ?? 10,
      language: this.config.knowledge?.generation?.language ?? "Chinese",
    });
  }

  async stop(): Promise<void> {
    this.tracker?.stop();
    this.scanner?.stop();
    this.knowledgeSync?.stop();
    if (this.generationTimerId) {
      clearTimeout(this.generationTimerId);
      this.generationTimerId = null;
    }
  }

  async destroy(): Promise<void> {
    this.store?.close();
  }

  getCommandHandlers(): PluginCommandHandler {
    return this.commandHandler;
  }

  getToolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      {
        name: "list_repos",
        description: "List all tracked repositories with their names, URLs, and status",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "git_file_read",
        description: "Read a file from a tracked repository",
        input_schema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository name" },
            path: { type: "string", description: "File path relative to repo root" },
          },
          required: ["repo", "path"],
        },
      },
      {
        name: "git_search",
        description: "Search code in a repository using grep",
        input_schema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository name" },
            query: { type: "string", description: "Search pattern (grep regex)" },
          },
          required: ["repo", "query"],
        },
      },
      {
        name: "git_log",
        description: "View commit history of a repository or file",
        input_schema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository name" },
            path: { type: "string", description: "Optional file path to filter" },
            n: { type: "number", description: "Number of commits (default 10)" },
          },
          required: ["repo"],
        },
      },
      {
        name: "git_diff",
        description: "View changes between commits",
        input_schema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository name" },
            commit_range: { type: "string", description: "Commit range (e.g. 'HEAD~3..HEAD')" },
          },
          required: ["repo", "commit_range"],
        },
      },
      {
        name: "git_blame",
        description: "See who wrote specific lines of code",
        input_schema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository name" },
            path: { type: "string", description: "File path" },
            lines: { type: "string", description: "Optional line range (e.g. '10,20')" },
          },
          required: ["repo", "path"],
        },
      },
    ];

    // Add get_repo_knowledge if knowledge dir has content
    if (this.knowledgeDocs.size > 0) {
      tools.push({
        name: "get_repo_knowledge",
        description:
          "ALWAYS call this FIRST before other git tools. Get curated documentation about a repository. Call with just repo name for overview, or with doc parameter for a specific topic deep-dive. Much faster and more comprehensive than searching code directly.",
        input_schema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository name" },
            doc: { type: "string", description: "Document name (omit for catalog)" },
          },
          required: ["repo"],
        },
      });
    }

    return tools;
  }

  getCheapTools(): string[] {
    return [
      "list_repos",
      "git_file_read",
      "git_search",
      "git_log",
      "git_diff",
      "git_blame",
      "get_repo_knowledge",
    ];
  }

  summarizeInput(name: string, input: Record<string, any>): string {
    switch (name) {
      case "list_repos":
        return "";
      case "git_file_read":
        return `${input.repo}/${input.path}`;
      case "git_search":
        return `${input.repo}: "${input.query}"`;
      case "git_log":
        return input.path ? `${input.repo}/${input.path}` : input.repo;
      case "git_diff":
        return `${input.repo} ${input.commit_range}`;
      case "git_blame":
        return `${input.repo}/${input.path}${input.lines ? `:${input.lines}` : ""}`;
      case "get_repo_knowledge":
        return input.doc ? `${input.repo}/${input.doc}` : `${input.repo} catalog`;
      default:
        return JSON.stringify(input).slice(0, 60);
    }
  }

  async executeTool(name: string, input: Record<string, any>): Promise<string> {
    try {
      if (name === "get_repo_knowledge") {
        return this.getRepoKnowledge(input.repo, input.doc);
      }
      return await this.gitTools.execute(name, input);
    } catch (e: any) {
      return `Error in ${this.name}.${name}: ${e.message}`;
    }
  }

  getSystemPromptAddendum(): string {
    const repoNames = this.config.repos.map((r) => r.name).join(", ");
    const lines = [
      "## Git Repos Plugin",
      `Tracked repositories: ${repoNames}`,
      "Use git tools (git_file_read, git_search, git_log, git_diff, git_blame) to explore code.",
    ];
    if (this.knowledgeDocs.size > 0) {
      lines.push(
        "",
        "**IMPORTANT: ALWAYS call get_repo_knowledge FIRST before using any other git tool.** This is the fastest way to understand a repo.",
        "- Call with just repo name to get a comprehensive overview (architecture, structure, key files)",
        "- Call with doc parameter to load a specific deep-dive topic",
        "- Only fall back to git_search/git_file_read if the knowledge docs don't answer your question",
      );
      // List available knowledge per repo
      for (const [repo, docs] of this.knowledgeDocs) {
        const docNames = Array.from(docs.keys()).filter(k => k !== "index");
        if (docNames.length > 0) {
          lines.push(`- **${repo}** knowledge topics: ${docNames.join(", ")}`);
        }
      }
    }
    return lines.join("\n");
  }

  // --- Knowledge loading ---

  private loadKnowledge(): void {
    const dir = this.knowledgeDir ?? KNOWLEDGE_DIR;
    if (!existsSync(dir)) return;

    // Clear existing state
    this.knowledgeDocs.clear();
    this.knowledgeCatalogs.clear();

    for (const repoDir of readdirSync(dir, { withFileTypes: true })) {
      if (!repoDir.isDirectory()) continue;
      if (repoDir.name.startsWith(".")) continue; // skip .tmp dirs and .git
      const repoKnowledgePath = join(dir, repoDir.name);
      const docs = new Map<string, TopicDocMeta>();
      const catalogLines: string[] = [];

      for (const file of readdirSync(repoKnowledgePath)) {
        if (!file.endsWith(".md")) continue;
        const filePath = join(repoKnowledgePath, file);
        const content = readFileSync(filePath, "utf-8");
        const { meta } = parseFrontmatter(content);
        const docName = file.replace(".md", "");
        const title = meta.title || docName;
        const description = meta.description || "";

        docs.set(docName, { title, description, filePath });
        if (docName !== "index") {
          catalogLines.push(`- **${docName}**: ${title}${description ? ` — ${description}` : ""}`);
        }
      }

      if (docs.size > 0) {
        this.knowledgeDocs.set(repoDir.name, docs);
        this.knowledgeCatalogs.set(repoDir.name, catalogLines.join("\n"));
      }
    }

    if (this.knowledgeDocs.size > 0) {
      const totalDocs = Array.from(this.knowledgeDocs.values()).reduce((sum, m) => sum + m.size, 0);
      console.log(`[${this.name}] Loaded ${totalDocs} knowledge docs for ${this.knowledgeDocs.size} repos`);
    }
  }

  private getRepoKnowledge(repo: string, doc?: string): string {
    const repoDocs = this.knowledgeDocs.get(repo);
    if (!repoDocs) {
      return `No curated knowledge found for repo "${repo}". Use git tools to explore the code directly.`;
    }

    if (!doc) {
      // Return index.md if it exists, otherwise return catalog
      const indexDoc = repoDocs.get("index");
      if (indexDoc) {
        return readFileSync(indexDoc.filePath, "utf-8");
      }
      // Fallback: catalog of available docs
      const catalog = this.knowledgeCatalogs.get(repo) ?? "";
      return `Available docs for ${repo}:\n${catalog}\n\nUse get_repo_knowledge with doc parameter to read a specific document.`;
    }

    const docMeta = repoDocs.get(doc);
    if (!docMeta) {
      return `Document "${doc}" not found for repo "${repo}". Available: ${Array.from(repoDocs.keys()).filter(k => k !== "index").join(", ")}`;
    }

    return readFileSync(docMeta.filePath, "utf-8");
  }

  // --- Knowledge generation scheduling ---

  private scheduleKnowledgeGeneration(cronExpr: string): void {
    const parts = cronExpr.split(" ");
    let cronHour = 3;
    if (parts.length >= 2) cronHour = parseInt(parts[1], 10);
    if (Number.isNaN(cronHour)) cronHour = 3;

    const scheduleNext = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(cronHour, 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);

      const delay = next.getTime() - now.getTime();
      console.log(`[${this.name}] Knowledge generation: next run at ${next.toISOString()}`);

      this.generationTimerId = setTimeout(() => {
        this.generateAllKnowledge()
          .catch((e) => console.error(`[${this.name}] Knowledge generation error:`, e))
          .finally(scheduleNext);
      }, delay);
    };

    scheduleNext();
  }

  async generateAllKnowledge(): Promise<void> {
    if (!this.knowledgeGenerator) return;

    const maxTopics = this.config.knowledge?.generation?.max_topics ?? 8;
    const language = this.config.knowledge?.generation?.language ?? "Chinese";

    for (const repo of this.config.repos) {
      const repoPath = this.repoPaths.get(repo.name);
      if (!repoPath) continue;

      try {
        console.log(`[${this.name}] Generating knowledge for ${repo.name}...`);
        await this.knowledgeGenerator.generate(repo.name, repoPath, maxTopics, language);
        console.log(`[${this.name}] Knowledge generated for ${repo.name}`);
      } catch (e: any) {
        console.error(`[${this.name}] Knowledge generation failed for ${repo.name}: ${e.message}`);
      }
    }

    // Commit and push
    if (this.knowledgeSync) {
      try {
        await this.knowledgeSync.commitAndPush(`knowledge: update generated docs (${new Date().toISOString()})`);
      } catch (e: any) {
        console.error(`[${this.name}] Knowledge commit/push failed: ${e.message}`);
      }
    }

    // Hot-reload
    this.loadKnowledge();
  }
}
