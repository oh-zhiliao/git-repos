import Database from "better-sqlite3";

export interface RepoState {
  repo_name: string;
  last_poll_at: number | null;
  last_scan_at: number | null;
  last_commit_hash: string | null;
}

export class RepoStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repo_state (
        repo_name TEXT PRIMARY KEY,
        last_poll_at INTEGER,
        last_scan_at INTEGER,
        last_commit_hash TEXT
      )
    `);
  }

  getState(repoName: string): RepoState | null {
    const row = this.db.prepare("SELECT * FROM repo_state WHERE repo_name = ?").get(repoName) as RepoState | undefined;
    return row ?? null;
  }

  updatePollTime(repoName: string, pollTime: number, lastCommitHash: string): void {
    this.db.prepare(`
      INSERT INTO repo_state (repo_name, last_poll_at, last_commit_hash)
      VALUES (?, ?, ?)
      ON CONFLICT(repo_name) DO UPDATE SET last_poll_at = excluded.last_poll_at, last_commit_hash = excluded.last_commit_hash
    `).run(repoName, pollTime, lastCommitHash);
  }

  updateScanTime(repoName: string, scanTime: number): void {
    this.db.prepare(`
      INSERT INTO repo_state (repo_name, last_scan_at)
      VALUES (?, ?)
      ON CONFLICT(repo_name) DO UPDATE SET last_scan_at = excluded.last_scan_at
    `).run(repoName, scanTime);
  }

  close(): void {
    this.db.close();
  }
}
