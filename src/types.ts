export interface RepoConfig {
  name: string;
  url: string;
  branch: string;
}

export interface GitReposPluginConfig {
  repos: RepoConfig[];
  ssh_key_path: string;
  repos_dir: string;
  poll_interval_minutes: number;
  deep_scan_cron: string;
  memo_url: string;
  notifications?: Record<string, string[]>;
  admins?: string[];
  knowledge?: KnowledgeConfig;
}

export interface KnowledgeSyncConfig {
  pull_interval_minutes: number;
}

export interface KnowledgeGenerationConfig {
  enabled: boolean;
  cron: string | null;
  max_topics: number;
  context_token_budget: number;
  language: string;
}

export interface KnowledgeConfig {
  repo_url: string;
  branch: string;
  local_dir: string;
  sync?: KnowledgeSyncConfig;
  generation?: KnowledgeGenerationConfig;
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface MemoCommitEntry extends CommitInfo {
  diff_stat: string;
}
