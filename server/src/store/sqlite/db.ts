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
import { chmodSync, closeSync, existsSync, openSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
export function lockForServer(databasePath: string, onLost?: (message: string) => void): () => void {
  // The lock belongs to the database FILE, wherever the path given leads: a symlink to it is the same database.
  const real = realPathOf(databasePath);
  const file = `${real}.lock`;
  if (!existsSync(file)) closeSync(openSync(file, 'a', 0o600));
  const lock = new DatabaseSync(file, { timeout: 0 });
  try {
    lock.exec('BEGIN EXCLUSIVE');
  } catch {
    lock.close();
    throw new Error(`Another Global Connect server process is already running on ${databasePath}. Only one may use a database at a time: stop the other one first.`);
  }
  // The lock is an operating-system lock on that file, released if the process dies. It is only as good as the
  // file: if the lock file is deleted or replaced while this server runs, another could take "the" lock. So the
  // server keeps looking, and stops rather than share its database.
  const held = statSync(file).ino;
  const lost =
    onLost ??
    ((message: string) => {
      console.error(message);
      process.exit(1);
    });
  const watch = setInterval(() => {
    let now: number | null = null;
    try {
      now = statSync(file).ino;
    } catch {
      now = null;
    }
    if (now === held) return;
    clearInterval(watch);
    lost(`The lock file ${file} was removed or replaced while the server was running. The server is stopping, so that two servers can never use one database. Start it again.`);
  }, LOCK_WATCH_MS);
  watch.unref();
  return () => {
    clearInterval(watch);
    if (lock.isOpen) lock.close();
  };
}
/** How often the running server checks that the lock file it holds is still the one on disk. */
export const LOCK_WATCH_MS = 2_000;

/** Where a path really leads (symlinks followed), for a file that may not exist yet. */
export function realPathOf(file: string): string {
  const full = resolve(file);
  if (existsSync(full)) return realpathSync(full);
  const folder = dirname(full);
  return existsSync(folder) ? join(realpathSync(folder), basename(full)) : full;
}

export interface DbOptions {
  migrations?: string[];
  /** Called inside the transaction of each migration that is applied, after its SQL. */
  onMigrate?: (version: number, db: Db) => void;
  /**
   * Called once the database is open and BEFORE any migration runs, with the schema version it is at (0 with
   * `isNew` for a database that holds nothing yet). Throwing refuses the database: nothing has been changed.
   */
  beforeMigrate?: (db: Db, version: number, isNew: boolean) => void;
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
  // The path as given AND where it really leads: a symlink in a private folder to a database in a shared one is refused.
  const bases = [...new Set([resolve(file), realPathOf(file)])];
  const wrong = (target: string, wanted: string, command: string): string | null => {
    if (!existsSync(target)) return null;
    const mode = statSync(target).mode & 0o777;
    // Nothing at all for the group or for others: not read, not write, not execute.
    if ((mode & 0o077) === 0) return null;
    return `${target} can be read or changed by other users of this machine (its permissions are ${mode.toString(8)}; they must be ${wanted}). It holds password hashes, encrypted keys and the audit log. Put it right with:  ${command}`;
  };
  for (const base of bases) {
    // The database, its write-ahead files, the development key beside it and the server's lock.
    for (const suffix of ['', '-wal', '-shm', '.dev-key', '.lock']) {
      const problem = wrong(`${base}${suffix}`, '600', `chmod 600 ${base}*`);
      if (problem) return problem;
    }
    const folder = dirname(base);
    const problem = wrong(folder, '700', `chmod 700 ${folder}`);
    if (problem) return problem;
  }
  return null;
}

export class Db {
  private readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  /** The schema version found when the file was opened, before any migration: 0 for a database created by this very open. */
  readonly openedAtVersion: number;
  /** True when this open found a database that held nothing at all. */
  openedAsNew = false;
  private readonly migrations: string[];
  private readonly onMigrate: ((version: number, db: Db) => void) | undefined;
  private readonly beforeMigrate: DbOptions['beforeMigrate'];
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
    this.beforeMigrate = settings.beforeMigrate;
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
    try {
      this.openedAtVersion = this.migrate();
    } catch (error) {
      this.raw.close();
      throw error;
    }
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
    // A database that holds nothing at all is new. One that holds anything is not, whatever its version table says.
    const isNew = this.get("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_version' LIMIT 1") === undefined;
    const versioned = this.get("SELECT 1 FROM sqlite_master WHERE name = 'schema_version'") !== undefined;
    const current = versioned ? (this.get<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_version')?.version ?? 0) : 0;
    if (current > this.migrations.length) {
      throw new Error(`This database is at schema version ${current}, but this version of the server only knows up to ${this.migrations.length}. It was written by a newer version; refusing to open it.`);
    }
    this.openedAsNew = isNew && current === 0;
    this.beforeMigrate?.(this, current, this.openedAsNew);
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
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

  /** An empty in-memory database with this one's schema: what the structure of a database this code made looks like. */
  blank(): Db {
    return new Db(':memory:', { migrations: this.migrations });
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
