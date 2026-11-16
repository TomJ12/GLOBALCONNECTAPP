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
import { chmodSync, closeSync, existsSync, openSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

import { nodeVersionProblem } from '../../nodeVersion';
import { MIGRATIONS } from './migrations';

export type Row = Record<string, unknown>;

/**
 * ONE SERVER PROCESS PER DATABASE. The server keeps some state in its own
 * memory (rate limits, the quotes it issued, which payments it is sending
 * right now), so two server processes on one database would each be wrong
 * about the other. The server takes this lock when it starts and holds it
 * until it exits; the operating system releases it if the process dies. The
 * maintenance commands do not take it.
 * Returns the function that releases it; throws if another process holds it.
 */
export function lockForServer(databasePath: string): () => void {
  const file = `${databasePath}.lock`;
  if (!existsSync(file)) closeSync(openSync(file, 'a', 0o600));
  const lock = new DatabaseSync(file, { timeout: 0 });
  try {
    lock.exec('BEGIN EXCLUSIVE');
  } catch {
    lock.close();
    throw new Error(`Another Global Connect server process is already running on ${databasePath}. Only one may use a database at a time: stop the other one first.`);
  }
  return () => {
    if (lock.isOpen) lock.close();
  };
}

export interface DbOptions {
  migrations?: string[];
  /** Called inside the transaction of each migration that is applied, after its SQL. */
  onMigrate?: (version: number, db: Db) => void;
  /** Open without changing anything: no migrations, no writes. For the verify and backup commands. */
  readOnly?: boolean;
}

/**
 * The database file and the folder it is in must not be readable or writable
 * by the group or by everyone. Returns what is wrong, with the command that
 * puts it right, or null. (Not checked on Windows, which has no such bits.)
 */
export function permissionProblem(file: string): string | null {
  if (process.platform === 'win32') return null;
  const folder = dirname(resolve(file));
  for (const [target, wanted, command] of [[file, '600', `chmod 600 ${file}*`], [folder, '700', `chmod 700 ${folder}`]] as const) {
    if (!existsSync(target)) continue;
    const mode = statSync(target).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return `${target} can be read or changed by other users of this machine (its permissions are ${mode.toString(8)}; they must be ${wanted}). It holds password hashes, encrypted keys and the audit log. Put it right with:  ${command}`;
    }
  }
  return null;
}

export class Db {
  private readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  /** The schema version found when the file was opened, before any migration: 0 for a database created by this very open. */
  readonly openedAtVersion: number;
  private readonly migrations: string[];
  private readonly onMigrate: ((version: number, db: Db) => void) | undefined;
  readonly readOnly: boolean;

  constructor(
    readonly path: string,
    options: string[] | DbOptions = {},
  ) {
    const problem = nodeVersionProblem();
    if (problem) throw new Error(problem);
    const settings: DbOptions = Array.isArray(options) ? { migrations: options } : options;
    this.migrations = settings.migrations ?? MIGRATIONS;
    this.onMigrate = settings.onMigrate;
    this.readOnly = settings.readOnly === true;
    const onDisk = path !== ':memory:';
    if (onDisk) {
      if (this.readOnly && !existsSync(path)) throw new Error(`There is no database at ${path}.`);
      // The file holds password hashes, encrypted keys and the audit log: it is this user's and nobody else's.
      // SQLite gives the write-ahead files (-wal, -shm) the same permissions as the database file.
      if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600));
      const reason = permissionProblem(path);
      if (reason) throw new Error(reason);
    }
    // `timeout`: how long a writer waits for another connection's write lock before giving up.
    this.raw = new DatabaseSync(path, { timeout: 5000, readOnly: this.readOnly });
    if (this.readOnly) {
      // Looks, never touches: no migration, no settings that write. A database this code does not match is refused.
      this.raw.exec('PRAGMA busy_timeout = 5000');
      this.raw.exec('PRAGMA query_only = ON');
      const version = this.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_version'").get() ? this.schemaVersion() : 0;
      this.openedAtVersion = version;
      if (version !== this.migrations.length) {
        throw new Error(`This database is at schema version ${version} and this version of the commands needs ${this.migrations.length}. ${version < this.migrations.length ? 'Start the server once (it upgrades the database), then run this again.' : 'It was written by a newer version.'}`);
      }
      return;
    }
    // WAL: readers do not block the writer. (An in-memory database has no file and stays in "memory" mode.)
    this.raw.exec('PRAGMA journal_mode = WAL');
    // Every commit is flushed to disk before it is acknowledged. The audit log and money records must not be lost
    // to a power cut; the setting is per connection, so it applies to everything.
    this.raw.exec('PRAGMA synchronous = FULL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.openedAtVersion = this.migrate();
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
  private migrate(): number {
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
        // What a migration needs that SQL alone cannot do (it may need the encryption key), in the same transaction.
        this.onMigrate?.(version, this);
        this.run('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', version, Date.now());
      });
    }
    return current;
  }

  schemaVersion(): number {
    return this.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')?.version ?? 0;
  }

  /** A consistent copy of the whole database in a new file, safe to take while the server is running. */
  backupTo(file: string): void {
    // Made empty and private first, so the copy is never readable by anyone else, not even while it is being written.
    closeSync(openSync(file, 'wx', 0o600));
    // (A read-only connection still cannot change THIS database; the setting is lifted only so the copy can be written.)
    if (this.readOnly) this.raw.exec('PRAGMA query_only = OFF');
    try {
      this.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    } finally {
      if (this.readOnly) this.raw.exec('PRAGMA query_only = ON');
    }
    chmodSync(file, 0o600);
  }

  close(): void {
    if (!this.raw.isOpen) return;
    this.statements.clear();
    this.raw.close();
  }
}
