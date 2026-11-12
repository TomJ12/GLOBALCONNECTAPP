/**
 * The one place that talks to SQLite (Node's built-in `node:sqlite`).
 *
 * SQLITE-SPECIFIC, and what a move to PostgreSQL would replace:
 *  - this file: the connection, PRAGMAs, `BEGIN IMMEDIATE`, `VACUUM INTO`;
 *  - migrations.ts: `STRICT` tables, `AUTOINCREMENT`, `RAISE(ABORT)` triggers,
 *    `json_extract` expression indexes;
 *  - `json_extract(data, '$.field')` in tables.ts.
 * Everything above this folder sees only the interfaces in ../types.ts.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

import { nodeVersionProblem } from '../../nodeVersion';
import { MIGRATIONS } from './migrations';

export type Row = Record<string, unknown>;

export class Db {
  private readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(
    readonly path: string,
    private readonly migrations: string[] = MIGRATIONS,
  ) {
    const problem = nodeVersionProblem();
    if (problem) throw new Error(problem);
    // `timeout`: how long a writer waits for another connection's write lock before giving up.
    this.raw = new DatabaseSync(path, { timeout: 5000 });
    // WAL: readers do not block the writer. (An in-memory database has no file and stays in "memory" mode.)
    this.raw.exec('PRAGMA journal_mode = WAL');
    // Every commit is flushed to disk before it is acknowledged. The audit log and money records must not be lost
    // to a power cut; the setting is per connection, so it applies to everything.
    this.raw.exec('PRAGMA synchronous = FULL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  private statement(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.raw.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }
  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }
  run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.statement(sql).run(...params).changes);
  }
  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /**
   * Runs `work` in one transaction that takes the WRITE lock at the start
   * (`BEGIN IMMEDIATE`), so what it reads cannot change under it, in this
   * process or any other. A throw rolls everything back. Nested calls join
   * the outer transaction.
   */
  tx<T>(work: () => T): T {
    if (this.depth > 0) return work();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth += 1;
    try {
      const result = work();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  /** Numbered, forward-only migrations, each in its own transaction. A database newer than this code is refused. */
  private migrate(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const current = this.get<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_version')?.version ?? 0;
    if (current > this.migrations.length) {
      throw new Error(`This database is at schema version ${current}, but this version of the server only knows up to ${this.migrations.length}. It was written by a newer version; refusing to open it.`);
    }
    for (let version = current + 1; version <= this.migrations.length; version += 1) {
      this.tx(() => {
        // Checked again inside the write lock: another process may have applied it while this one waited.
        if (this.get('SELECT 1 FROM schema_version WHERE version = ?', version)) return;
        this.raw.exec(this.migrations[version - 1] as string);
        this.run('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', version, Date.now());
      });
    }
  }

  schemaVersion(): number {
    return this.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')?.version ?? 0;
  }

  /** A consistent copy of the whole database in a new file, safe to take while the server is running. */
  backupTo(file: string): void {
    this.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  }

  close(): void {
    if (!this.raw.isOpen) return;
    this.statements.clear();
    this.raw.close();
  }
}
