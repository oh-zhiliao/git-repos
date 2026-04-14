# Knowledge Generation Guide

This document describes the per-repo knowledge system used by the git-repos plugin. Knowledge can be generated either by the built-in generator (via `/git-repos generate-knowledge`) or by an external agent (e.g., Claude with Opus) writing directly to the knowledge repo.

## Architecture

```
knowledge-repo/
├── .git/
├── gigi/
│   ├── index.md          ← Layer 0: comprehensive overview (100-200 lines)
│   ├── architecture.md   ← Layer 1: deep-dive topic
│   ├── data-models.md    ← Layer 1: deep-dive topic
│   └── ...
├── landing-h5/
│   ├── index.md
│   └── ...
└── another-repo/
    └── ...
```

The knowledge repo is a standalone git repository, decoupled from the plugin code. Its path is configured via `knowledge.local_dir` in `config.yaml`.

## How the Plugin Loads Knowledge

On startup, the plugin scans `knowledge.local_dir`:

1. Each **subdirectory** is treated as a repo name (directories starting with `.` are skipped)
2. Each **`.md` file** inside is parsed for YAML frontmatter (`title`, `description`)
3. `index.md` is the entry point — returned when the agent calls `get_repo_knowledge(repo: "gigi")`
4. Other `.md` files are topic docs — returned when the agent calls `get_repo_knowledge(repo: "gigi", doc: "data-models")`

**The directory name must exactly match the repo name in `config.yaml`.** For example, if the repo is configured as `name: "gigi"`, the knowledge directory must be `gigi/`.

## Document Format

### Layer 0: `index.md` (Required)

The index is the comprehensive overview of the repo. It should be **100-200 lines** of Markdown and serve as the primary entry point for understanding the repo.

```markdown
---
title: "gigi Repository Knowledge Index"
description: "Brief one-line description of the repo"
generated_at: "2026-04-15T00:45:00.000Z"
generator_model: "claude-opus-4-6"
---

# {repo_name} Knowledge Overview

## Project Summary
Brief description of what this project does, its business purpose, and target users.

## Technology Stack
- **Language:** Go 1.23 / TypeScript / Python ...
- **Framework:** Gin / Next.js / FastAPI ...
- **Database:** MySQL, Redis, MongoDB ...
- ...

## Core Architecture
Describe the project structure and how components interact.
- `internal/handler/`: HTTP routing
- `internal/dao/`: Data access layer
- `src/components/`: React components
- ...

## Key Modules
Brief description of each major module/package and what it does.

## Entry Points
Where does execution start? Main files, route definitions, etc.

## Available Deep-Dive Topics
The following topic documents provide detailed information on specific aspects:
- [architecture](architecture.md): System architecture and design patterns
- [data-models](data-models.md): Database schemas and data structures
- [api-reference](api-reference.md): API endpoints and contracts
- ...
```

**Requirements:**
- Must have YAML frontmatter with `title`, `description`, `generated_at`
- `generated_at` must be a real ISO timestamp (not hallucinated)
- Should reference available topic docs so the agent knows what to load next
- Write in the configured language (default: Chinese); keep code identifiers in their original form

### Layer 1: Topic Documents

Each topic doc is a **50-150 line** deep-dive into a specific aspect of the repo.

```markdown
---
title: "Data Models: Database Schemas and Structures"
description: "Deep-dive into the persistence layer, detailing key structs and table designs"
topic: "data-models"
generated_at: "2026-04-15T00:45:00.000Z"
generator_model: "claude-opus-4-6"
---

# Data Models

## Overview
Brief intro to the data layer.

## Key Models
### User
- Table: `users`
- Key fields: id, name, phone, created_at
- Relationships: has_many orders

### Order
...

## Database Design Patterns
...
```

**Requirements:**
- Must have YAML frontmatter with `title`, `description`, `topic`, `generated_at`
- Filename must be kebab-case and end with `.md` (e.g., `data-models.md`)
- The `topic` field should match the filename without `.md`
- Be precise and technical — include actual struct/type definitions, table names, API paths
- Code snippets welcome where they aid understanding

## Recommended Topics

Choose topics based on the nature of the repo. Common ones:

| Topic | When to include | What to cover |
|-------|----------------|---------------|
| `architecture` | Always | System design, component interaction, dependency flow |
| `api-reference` | Backend services | Endpoints, request/response formats, auth |
| `data-models` | Has database | Schemas, key entities, relationships |
| `configuration` | Complex config | Config files, env vars, feature flags |
| `deployment` | Has CI/CD | Build process, Docker setup, deployment flow |
| `business-logic` | Domain-heavy apps | Core workflows, state machines, rules |
| `testing` | Has test suite | Test strategy, fixtures, how to run |
| `frontend-components` | Frontend apps | Component hierarchy, state management, routing |

Aim for **6-10 topics** per repo. Each topic should be self-contained and useful on its own.

## External Generation Workflow

For higher quality knowledge, use an external agent (e.g., Claude with Opus) instead of the built-in generator:

1. **Clone the knowledge repo** (or work in the configured `knowledge.local_dir` directly)

2. **Read the target repo** to understand its structure:
   - File tree, README, package.json/go.mod, entry points
   - Key source files, config files, tests

3. **Generate `index.md`** first — this is the foundation

4. **Generate topic docs** based on what you discovered in the index pass

5. **Commit and push** (or just commit if local-only):
   ```bash
   cd /path/to/knowledge-repo
   git add gigi/
   git commit -m "knowledge: update gigi docs"
   ```

6. **Restart the agent** (or wait for the next periodic pull if configured):
   ```bash
   docker compose restart agent
   ```

The plugin will auto-detect the new files on next startup or periodic pull.

### Tips for External Agents

- **Read actual code**, not just file names. The knowledge should reflect what the code actually does.
- **Be specific**: include real function names, real table names, real API paths. Generic descriptions are not useful.
- **Respect the line limits**: index 100-200 lines, topics 50-150 lines. These are consumed as LLM context — too long wastes tokens.
- **Update atomically**: write all files for a repo before committing. The plugin reads at startup; partial updates are fine but suboptimal.
- **Check staleness**: compare `generated_at` with the repo's latest commit. Regenerate if the repo has changed significantly.

## Configuration Reference

In `config.yaml`:

```yaml
knowledge:
  repo_url: "git@github.com:org/knowledge.git"   # or local path
  branch: "master"
  local_dir: "/app/data/knowledge"

  sync:
    pull_interval_minutes: 30   # 0 to disable periodic pull

  generation:
    enabled: true               # enable built-in generator
    cron: "0 3 * * *"          # daily at 3am (null to disable)
    max_topics: 6               # max topic docs per repo
    context_token_budget: 50000
    language: Chinese           # output language (default: Chinese)
```

When `repo_url` equals `local_dir`, the plugin treats it as a local-only repo (no clone/pull, just reads directly).
