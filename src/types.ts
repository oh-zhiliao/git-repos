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
