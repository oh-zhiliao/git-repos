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
            GIT_SSH_COMMAND: `ssh -i ${this.config.ssh_key_path} -o StrictHostKeyChecking=no`,
          },
        });
      }
      this.repoPaths.set(repo.name, repoPath);
    }

    // Init sub-components
    this.store = new RepoStore(join(this.config.repos_dir, ".git-repos-state.db"));
    this.gitTools = new GitTools(this.config.repos, this.repoPaths);
    this.commandHandler = createCommandHandler(
      this.config.repos,
      this.store,
      this.config.admins ?? []
    );

    // Load knowledge docs
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
  }

  async stop(): Promise<void> {
    this.tracker?.stop();
    this.scanner?.stop();
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
          "Get curated documentation about a repository (architecture, conventions, deployment notes). Use to understand a repo's structure before diving into code.",
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
      lines.push("Use get_repo_knowledge for curated documentation about each repository.");
    }
    return lines.join("\n");
  }

  // --- Knowledge loading ---

  private loadKnowledge(): void {
    if (!existsSync(KNOWLEDGE_DIR)) return;

    for (const repoDir of readdirSync(KNOWLEDGE_DIR, { withFileTypes: true })) {
      if (!repoDir.isDirectory()) continue;
      const repoKnowledgePath = join(KNOWLEDGE_DIR, repoDir.name);
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
        catalogLines.push(`- **${docName}**: ${title}${description ? ` — ${description}` : ""}`);
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
      return `No curated knowledge found for repo "${repo}".`;
    }

    if (!doc) {
      const catalog = this.knowledgeCatalogs.get(repo) ?? "";
      return `Available docs for ${repo}:\n${catalog}\n\nUse get_repo_knowledge with doc parameter to read a specific document.`;
    }

    const docMeta = repoDocs.get(doc);
    if (!docMeta) {
      return `Document "${doc}" not found for repo "${repo}". Available: ${Array.from(repoDocs.keys()).join(", ")}`;
    }

    return readFileSync(docMeta.filePath, "utf-8");
  }
}
