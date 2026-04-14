import type { CommandCallContext, PluginCommandHandler } from "../../agent/src/agent/tool-plugin.js";
import type { RepoConfig } from "./types.js";
import type { RepoStore } from "./repo-store.js";

export function createCommandHandler(
  repos: RepoConfig[],
  store: RepoStore,
  admins: string[]
): PluginCommandHandler {
  return {
    subcommands: {
      list: {
        description: "列出所有配置的仓库及状态",
        async handle(args: string[], ctx: CommandCallContext): Promise<string> {
          if (repos.length === 0) {
            return "没有配置仓库。请在 git-repos/config.yaml 中添加。";
          }
          const lines = repos.map((r) => {
            const state = store.getState(r.name);
            const pollStr = state?.last_poll_at
              ? ` | 上次检查: ${new Date(state.last_poll_at).toLocaleString()}`
              : "";
            return `- **${r.name}** (${r.url}) branch=${r.branch}${pollStr}`;
          });
          return `已配置仓库 (${repos.length}):\n${lines.join("\n")}`;
        },
      },
      status: {
        description: "显示详细的仓库跟踪状态",
        async handle(args: string[], ctx: CommandCallContext): Promise<string> {
          const lines = repos.map((r) => {
            const state = store.getState(r.name);
            const poll = state?.last_poll_at ? new Date(state.last_poll_at).toLocaleString() : "从未";
            const scan = state?.last_scan_at ? new Date(state.last_scan_at).toLocaleString() : "从未";
            const hash = state?.last_commit_hash?.slice(0, 7) ?? "—";
            return `**${r.name}**\n  分支: ${r.branch}\n  最后轮询: ${poll}\n  最后扫描: ${scan}\n  最新 commit: ${hash}`;
          });
          return `Git Repos 状态:\n\n${lines.join("\n\n")}`;
        },
      },
    },
  };
}
