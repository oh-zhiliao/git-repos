# git-repos

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
