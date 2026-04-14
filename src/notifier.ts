import type { CommitInfo } from "./types.js";

/** Subset of PluginContext needed by Notifier — avoids direct import from agent core */
export interface NotifierContext {
  sendFeishuMessage(chatId: string, msgType: string, content: string): Promise<void>;
}

export class Notifier {
  constructor(private context: NotifierContext) {}

  async notify(repoName: string, commits: CommitInfo[], chatIds: string[]): Promise<void> {
    if (commits.length === 0 || chatIds.length === 0) return;

    const lines = commits.map(
      (c) => `- **${c.hash.slice(0, 7)}** ${c.message} (${c.author})`
    );
    const markdown = `**${repoName}** 有 ${commits.length} 个新提交:\n${lines.join("\n")}`;

    const content = JSON.stringify({
      type: "template",
      data: {
        template_variable: {},
        config: { wide_screen_mode: true },
        header: {
          title: { tag: "plain_text", content: "🔔 代码变更通知" },
          template: "blue",
        },
        elements: [{ tag: "markdown", content: markdown }],
      },
    });

    for (const chatId of chatIds) {
      try {
        await this.context.sendFeishuMessage(chatId, "interactive", content);
      } catch (e: any) {
        console.error(`[git-repos] Failed to notify chat=${chatId}: ${e.message}`);
      }
    }
  }
}
