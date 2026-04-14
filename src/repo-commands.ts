import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { CommandCallContext, PluginCommandHandler } from "../../agent/src/agent/tool-plugin.js";
import type { RepoConfig } from "./types.js";
import type { RepoStore } from "./repo-store.js";
import type { KnowledgeGenerator } from "./knowledge-generator.js";
import type { KnowledgeSync } from "./knowledge-sync.js";

interface CommandDeps {
  repos: RepoConfig[];
  store: RepoStore;
  admins: string[];
  repoPaths: Map<string, string>;
  knowledgeDir: string | null;
  knowledgeGenerator: KnowledgeGenerator | null;
  knowledgeSync: KnowledgeSync | null;
  maxTopics: number;
  language: string;
}

export function createCommandHandler(deps: CommandDeps): PluginCommandHandler {
  return {
    subcommands: {
      list: {
        description: "列出所有配置的仓库及状态",
        async handle(args: string[], ctx: CommandCallContext): Promise<string> {
          if (deps.repos.length === 0) {
            return "没有配置仓库。请在 git-repos/config.yaml 中添加。";
          }
          const lines = deps.repos.map((r) => {
            const state = deps.store.getState(r.name);
            const pollStr = state?.last_poll_at
              ? ` | 上次检查: ${new Date(state.last_poll_at).toLocaleString()}`
              : "";
            return `- **${r.name}** (${r.url}) branch=${r.branch}${pollStr}`;
          });
          return `已配置仓库 (${deps.repos.length}):\n${lines.join("\n")}`;
        },
      },
      status: {
        description: "显示详细的仓库跟踪状态",
        async handle(args: string[], ctx: CommandCallContext): Promise<string> {
          const lines = deps.repos.map((r) => {
            const state = deps.store.getState(r.name);
            const poll = state?.last_poll_at ? new Date(state.last_poll_at).toLocaleString() : "从未";
            const scan = state?.last_scan_at ? new Date(state.last_scan_at).toLocaleString() : "从未";
            const hash = state?.last_commit_hash?.slice(0, 7) ?? "—";
            return `**${r.name}**\n  分支: ${r.branch}\n  最后轮询: ${poll}\n  最后扫描: ${scan}\n  最新 commit: ${hash}`;
          });
          return `Git Repos 状态:\n\n${lines.join("\n\n")}`;
        },
      },
      "generate-knowledge": {
        description: "为指定仓库生成知识文档 (管理员)",
        async handle(args: string[], ctx: CommandCallContext): Promise<string> {
          if (deps.admins.length > 0 && !deps.admins.includes(ctx.userId)) {
            return "权限不足：仅管理员可执行此操作。";
          }
          if (!deps.knowledgeGenerator) {
            return "知识生成未启用。请检查 config.yaml 中的 knowledge.generation.enabled 配置。";
          }

          const repoName = args[0];
          const targetRepos = repoName
            ? deps.repos.filter((r) => r.name === repoName)
            : deps.repos;

          if (repoName && targetRepos.length === 0) {
            return `未找到仓库 "${repoName}"。可用仓库: ${deps.repos.map((r) => r.name).join(", ")}`;
          }

          const results: string[] = [];
          for (const repo of targetRepos) {
            const repoPath = deps.repoPaths.get(repo.name);
            if (!repoPath) continue;

            try {
              await deps.knowledgeGenerator.generate(repo.name, repoPath, deps.maxTopics, deps.language);
              results.push(`✅ ${repo.name}: 生成成功`);
            } catch (e: any) {
              results.push(`❌ ${repo.name}: ${e.message}`);
            }
          }

          // Commit and push
          if (deps.knowledgeSync) {
            try {
              await deps.knowledgeSync.commitAndPush(`knowledge: manual generation (${new Date().toISOString()})`);
              results.push("\n已提交并推送到知识仓库。");
            } catch (e: any) {
              results.push(`\n⚠️ 提交/推送失败: ${e.message}`);
            }
          }

          return results.join("\n");
        },
      },
      "knowledge-status": {
        description: "显示各仓库知识文档状态",
        async handle(args: string[], ctx: CommandCallContext): Promise<string> {
          if (!deps.knowledgeDir || !existsSync(deps.knowledgeDir)) {
            return "知识系统未配置或知识目录不存在。";
          }

          const lines: string[] = [];
          for (const repo of deps.repos) {
            const repoDir = join(deps.knowledgeDir, repo.name);
            if (!existsSync(repoDir)) {
              lines.push(`**${repo.name}**: 无知识文档`);
              continue;
            }

            const indexPath = join(repoDir, "index.md");
            let generatedAt = "未知";
            let model = "未知";
            if (existsSync(indexPath)) {
              const content = readFileSync(indexPath, "utf-8");
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
              if (fmMatch) {
                const gaMatch = fmMatch[1].match(/generated_at:\s*"?([^"\n]+)"?/);
                const gmMatch = fmMatch[1].match(/generator_model:\s*"?([^"\n]+)"?/);
                if (gaMatch) {
                  const d = new Date(gaMatch[1]);
                  generatedAt = isNaN(d.getTime()) ? gaMatch[1] : d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
                }
                if (gmMatch) model = gmMatch[1];
              }
            }

            const topicFiles = readdirSync(repoDir).filter(
              (f) => f.endsWith(".md") && f !== "index.md"
            );

            // Staleness check
            const repoPath = deps.repoPaths.get(repo.name);
            let staleness = "";
            if (repoPath && generatedAt !== "未知") {
              try {
                const latestCommitDate = execFileSync(
                  "git", ["--no-pager", "log", "-1", "--format=%aI"],
                  { cwd: repoPath, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
                ).toString().trim();

                if (new Date(latestCommitDate) > new Date(generatedAt)) {
                  staleness = " ⚠️ 过期 (仓库有更新)";
                } else {
                  staleness = " ✅ 最新";
                }
              } catch {
                // Can't determine staleness
              }
            }

            lines.push(
              `**${repo.name}**\n  生成时间: ${generatedAt}\n  模型: ${model}\n  主题文档: ${topicFiles.length} 个 (${topicFiles.map((f) => f.replace(".md", "")).join(", ") || "无"})${staleness}`
            );
          }

          return `知识文档状态:\n\n${lines.join("\n\n")}`;
        },
      },
    },
  };
}
