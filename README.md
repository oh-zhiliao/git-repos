# git-repos

[zhiliao](https://github.com/oh-zhiliao/zhiliao) 的 Git 仓库追踪、扫描与知识插件 —— 飞书智能问答机器人。

## 功能

- **仓库追踪**: 可配置轮询间隔，监控多个 Git 仓库的新提交
- **深度扫描**: 每日全仓库扫描，提交摘要存入 memo
- **代码工具**: `git_file_read`、`git_search`、`git_log`、`git_diff`、`git_blame` —— 让 Agent 直接探索代码
- **仓库知识**: 分层文档系统（索引 + 专题深入），帮助 Agent 高效理解仓库。参见 [docs/knowledge.md](docs/knowledge.md)
- **消息通知**: 新提交的飞书群聊通知

## 快速开始

1. 将 `config.example.yaml` 复制为 `config.yaml` 并配置仓库信息
2. 添加 deploy key 用于 Git 访问（`ssh_key_path`）
3. 配置 memo 服务地址用于提交存储

## 知识系统

插件支持按仓库的知识系统，为 Agent 提供精选文档，减少昂贵的代码搜索。

- **内置生成**: 通过 `callLLM` 使用大模型自动生成文档（`/git-repos generate-knowledge`）
- **外部生成**: 外部 Agent（如 Claude Opus）可直接向知识仓库写入更高质量的文档

详见 [docs/knowledge.md](docs/knowledge.md)，了解完整的文档格式、目录结构和生成流程。

## 命令

| 命令 | 说明 |
|------|------|
| `/git-repos list` | 列出已配置的仓库 |
| `/git-repos status` | 显示详细的追踪状态 |
| `/git-repos generate-knowledge [repo]` | 生成知识文档（管理员） |
| `/git-repos knowledge-status` | 显示各仓库知识文档状态 |

---

*[English version below](#english)*

---

<a id="english"></a>

# git-repos (English)

Git repository tracking, scanning, and knowledge plugin for [zhiliao](https://github.com/oh-zhiliao/zhiliao) — a Feishu intelligent Q&A bot.

## Features

- **Repository Tracking**: Monitor multiple git repos for new commits with configurable polling
- **Deep Scanning**: Daily full-repo scans with commit summaries stored in memo
- **Code Tools**: `git_file_read`, `git_search`, `git_log`, `git_diff`, `git_blame` — let the agent explore code directly
- **Per-Repo Knowledge**: Layered documentation system (index + topic deep-dives) for efficient agent understanding of repos. See [docs/knowledge.md](docs/knowledge.md)
- **Notifications**: Feishu chat notifications for new commits

## Setup

1. Copy `config.example.yaml` to `config.yaml` and configure your repos
2. Add deploy key for git access (`ssh_key_path`)
3. Configure memo URL for commit storage

## Knowledge System

The plugin supports a per-repo knowledge system that provides curated documentation to the agent, reducing the need for expensive code searches.

- **Built-in generation**: Uses LLM via `callLLM` to auto-generate docs (`/git-repos generate-knowledge`)
- **External generation**: An external agent (e.g., Claude with Opus) can write higher-quality docs directly to the knowledge repo

See [docs/knowledge.md](docs/knowledge.md) for the complete guide on document format, directory structure, and generation workflow.

## Commands

| Command | Description |
|---------|------------|
| `/git-repos list` | List configured repositories |
| `/git-repos status` | Show detailed tracking state |
| `/git-repos generate-knowledge [repo]` | Generate knowledge docs (admin) |
| `/git-repos knowledge-status` | Show knowledge doc status per repo |
