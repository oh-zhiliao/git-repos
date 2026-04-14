import { describe, it, expect, vi } from "vitest";
import { Notifier, type NotifierContext } from "../src/notifier.js";
import type { CommitInfo } from "../src/types.js";

function makeContext(): NotifierContext & { sendFeishuMessage: ReturnType<typeof vi.fn> } {
  return {
    sendFeishuMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Notifier", () => {
  it("sends card message to all chat IDs", async () => {
    const ctx = makeContext();
    const notifier = new Notifier(ctx);

    const commits: CommitInfo[] = [
      { hash: "abc1234567890", message: "feat: new feature", author: "alice", date: "2026-01-01" },
    ];

    await notifier.notify("my-repo", commits, ["chat1", "chat2"]);

    expect(ctx.sendFeishuMessage).toHaveBeenCalledTimes(2);
    expect(ctx.sendFeishuMessage).toHaveBeenCalledWith("chat1", "interactive", expect.any(String));
    expect(ctx.sendFeishuMessage).toHaveBeenCalledWith("chat2", "interactive", expect.any(String));

    // Verify card content
    const content = JSON.parse(ctx.sendFeishuMessage.mock.calls[0][2]);
    expect(content.data.elements[0].content).toContain("abc1234");
    expect(content.data.elements[0].content).toContain("feat: new feature");
    expect(content.data.elements[0].content).toContain("alice");
  });

  it("does nothing with empty commits", async () => {
    const ctx = makeContext();
    const notifier = new Notifier(ctx);
    await notifier.notify("my-repo", [], ["chat1"]);
    expect(ctx.sendFeishuMessage).not.toHaveBeenCalled();
  });

  it("does nothing with empty chat IDs", async () => {
    const ctx = makeContext();
    const notifier = new Notifier(ctx);
    const commits: CommitInfo[] = [
      { hash: "abc1234", message: "test", author: "bob", date: "2026-01-01" },
    ];
    await notifier.notify("my-repo", commits, []);
    expect(ctx.sendFeishuMessage).not.toHaveBeenCalled();
  });

  it("continues sending after one chat fails", async () => {
    const ctx = makeContext();
    ctx.sendFeishuMessage
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(undefined);

    const notifier = new Notifier(ctx);
    const commits: CommitInfo[] = [
      { hash: "abc1234", message: "test", author: "bob", date: "2026-01-01" },
    ];

    await notifier.notify("my-repo", commits, ["fail-chat", "ok-chat"]);
    expect(ctx.sendFeishuMessage).toHaveBeenCalledTimes(2);
  });
});
