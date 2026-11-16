/**
 * The SQLite store: every interface in ../types.ts, backed by one database
 * file (or, for tests and a throw-away development run, an in-memory one).
 *
 * What survives a restart: accounts, companies and memberships, invitations,
 * sessions, sign-in challenges, step-up permissions, lockout counters, known
 * sources, approval requests, idempotency mappings and the audit log.
 * What does not: rate-limit windows, hash-pool accounting and the stream of
 * anonymous sign-in failures, which live in the server process.
 */
import type {
  ActivationRecord,
  ApprovalRecord,
  AttemptRecord,
  CompanyRecord,
  LoginChallengeRecord,
  Membership,
  OpsSessionRecord,
  ProviderKeyRecord,
  SessionRecord,
  StepUpRecord,
  Stores,
  Table,
  UserRecord,
} from '../types';
import { SqlAuditLog, type AuditCheckpoint, type AuditOptions, type AuditVerification } from './audit';
import { Db } from './db';
import { SqlDirectory, SqlOpsDirectory } from './directory';
import { canonicalJson } from '@/api/canonical';

import { macOf, open, seal, sealedKeyId, type DataKey, type DataKeys } from './keys';
import { SqlHeldPayments } from './payments';
import { SqlTable } from './tables';

export interface DirectoryData {
  users: UserRecord[];
  companies: CompanyRecord[];
  memberships: Membership[];
}

/** DEVELOPMENT ONLY: a code the server itself printed for a sample account. */
export interface SeedCode {
  code: string;
  /** SHA-256 of the normalised code: the key of the invitation it belongs to. */
  codeHash: string;
}

export interface SqliteOptions {
  /** A file path, or ':memory:'. */
  path: string;
  keys: DataKeys;
  now?: () => number;
  audit?: AuditOptions;
  /** People and companies to start with, used only when the database has none. */
  seed?: DirectoryData;
  /** How the server is running. A database used in development is marked, and refused in strict mode ever after. */
  mode?: 'development' | 'strict';
  /** Open without changing anything (no migration, no marker): for audit:verify and db:backup. */
  readOnly?: boolean;
  /**
   * The key holder's explicit acceptance of an audit log whose end is not signed (see SqlAuditLog.reseal): `true`
   * from the reseal command, or the log's end label from AUDIT_ACCEPT_LOG_END, which only matches that exact log.
   */
  acceptLogEnd?: string | true;
}

export interface SqliteStores extends Stores {
  db: Db;
  audit: SqlAuditLog;
  seedCodes: Table<SeedCode>;
  verifyAudit(checkpoint?: AuditCheckpoint): AuditVerification;
  /** True when this open used the key holder's acceptance of an unsigned audit log. */
  acceptedLogEnd: boolean;
  /** Re-encrypts every stored secret with the current key. Returns how many were changed. */
  rotateKeys(): number;
  /** Removes rows that are over: expired invitations, challenges and permissions, idle unlocked counters, sessions past their absolute life. */
  sweep(sessionMaxAgeMs: number, opsSessionMaxAgeMs: number): Promise<void>;
  close(): void;
}

/** The keyed record of what this database is: its schema version, and whether it was ever used in development. */
interface DbState {
  schema: number;
  dev: boolean;
}
const stateMac = (key: DataKey, state: DbState): string => macOf(key, 'gc-db-state', canonicalJson([state.schema, state.dev]));

export function createSqliteStores(options: SqliteOptions): SqliteStores {
  const now = options.now ?? Date.now;
  const { keys } = options;
  const KEY_CHECK = 'meta:key_check';
  const quiet = { ...options.audit, notice: () => {} };
  let state: DbState | null = null;
  /** Set when the key holder's acceptance of an unsigned audit log is used (see `acceptLogEnd`). */
  let accepting: string | null = null;
  let acceptanceUsed = false;
  const accepted = (label: string): boolean => options.acceptLogEnd === true || (typeof options.acceptLogEnd === 'string' && options.acceptLogEnd.trim() === label);
  const unsigned = (log: SqlAuditLog, why: string): string => {
    const { live, archived } = log.counts();
    return (
      `${why} The server will not sign the end of a log it cannot vouch for: someone with access to the file could have cut entries off it. ` +
      `The log holds ${live + archived} ${live + archived === 1 ? 'entry' : 'entries'}; its end is "${log.endLabel()}". If that is what you expect, the holder of the encryption key can accept the log as it stands, ONCE: ` +
      `stop the server and run "npm run audit:reseal" (where no command can be run, set AUDIT_ACCEPT_LOG_END=${log.endLabel()} for one start and then remove it). ` +
      'The acceptance is itself recorded in the log. A local demo can instead be started afresh with "npm run demo:reset".'
    );
  };
  const readState = (db: Db): DbState | null => {
    const text = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'state'")?.value;
    if (text === undefined) return null;
    let parsed: { schema?: unknown; dev?: unknown; keyId?: unknown; mac?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      parsed = {};
    }
    const key = keys.all.find((item) => item.id === parsed.keyId);
    const found = { schema: parsed.schema as number, dev: parsed.dev as boolean };
    if (!key || typeof parsed.schema !== 'number' || typeof parsed.dev !== 'boolean' || typeof parsed.mac !== 'string' || parsed.mac !== stateMac(key, found)) {
      throw new Error('The signed record of this database’s state (its schema version, and whether it has been used in development) does not verify: it has been altered, or was signed with a key this server was not given. Refusing to open it. Restore the database from a backup.');
    }
    return found;
  };
  const writeState = (db: Db, next: DbState): void => {
    db.run("INSERT INTO meta (key, value) VALUES ('state', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify({ ...next, keyId: keys.current.id, mac: stateMac(keys.current, next) }));
    state = next;
  };
  /** The wrong key is refused at start-up, rather than discovered at somebody's sign-in; so is a database that has lost its key marker. */
  const checkKey = (db: Db): void => {
    const marker = db.get("SELECT 1 FROM sqlite_master WHERE name = 'meta'") ? db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'key_check'")?.value : undefined;
    if (marker === undefined) throw new Error('This database has lost the marker that says which encryption key it was written with, so the key cannot be checked. Refusing to open it. Restore the database from a backup.');
    try {
      if (open(keys, marker, KEY_CHECK) !== 'global-connect') throw new Error('mismatch');
    } catch {
      throw new Error('DATA_ENCRYPTION_KEY is not the key this database was written with. Nothing was changed. Set the right key (or, after a rotation, list the older one in DATA_ENCRYPTION_KEY_PREVIOUS).');
    }
  };
  /**
   * EVERYTHING THAT DECIDES WHAT MAY BE DONE TO AN EXISTING DATABASE IS KEYED. The schema version table, and any
   * plain marker, can be edited by whoever can write the file; so nothing is signed, upgraded or accepted on their
   * word. A database that is not brand new must carry the key marker and (from schema 5) the signed state record,
   * and that record must agree with the version table. A database from before schema 5 is taken on only if its
   * audit log is empty, or its end verifies as that version signed it, or the key holder accepts it explicitly.
   */
  const inspect = (db: Db, version: number, isNew: boolean): void => {
    if (isNew) return;
    checkKey(db);
    const found = readState(db);
    if (found) {
      if (found.schema !== version) throw new Error(`This database's version table says schema ${version}, but its signed record says ${found.schema}: the database has been altered, or partly replaced by an older copy. Refusing to open it. Restore the database from a backup.`);
      state = found;
      return;
    }
    if (version >= 5) throw new Error('This database has lost the signed record of its state (its schema version, and whether it has been used in development). Refusing to open it. Restore the database from a backup.');
    if (options.mode === 'strict') throw new Error('This database was made by an earlier version of the server, which could only run in development mode. It cannot be used outside development: start with a new database.');
    if (options.readOnly) return;
    if (version < 4) {
      const twins = db.all<{ names: string; account: string }>("SELECT group_concat('“' || name || '”', ' and ') AS names, provider_account_id AS account FROM companies GROUP BY provider_key, provider_account_id HAVING COUNT(*) > 1");
      if (twins[0]) throw new Error(`The companies ${twins[0].names} are mapped to the same provider account (${twins[0].account}). Two companies can never share one: re-point or remove one of them with the previous version before upgrading. Nothing was changed.`);
    }
    const log = new SqlAuditLog(db, keys, quiet);
    if (log.isEmpty() || (version === 4 && log.legacyHeadVerifies())) return;
    if (!accepted(log.endLabel())) throw new Error(unsigned(log, 'The end of this database’s audit log is not signed: it was written by an earlier version of the server, or the record of its end has been removed.'));
    accepting = `the log was accepted as it stood when the database was brought from schema ${version} to the current one`;
  };
  // What the migrations need that SQL alone cannot do. Each runs inside its migration's own transaction, so a
  // database either has the schema AND these, or neither.
  const db = new Db(options.path, {
    readOnly: options.readOnly,
    beforeMigrate: inspect,
    onMigrate(version, opened) {
      // 1: the key marker is made ONCE, when the schema is. A database that later turns up without it is refused,
      //    so deleting the marker does not let a different key in.
      if (version === 1) opened.run("INSERT INTO meta (key, value) VALUES ('key_check', ?)", seal(keys, 'global-connect', KEY_CHECK).text);
      // 4: company names get their compared form.
      if (version === 4) new SqlDirectory(opened, keys).backfillNameKeys();
      // 5: the end of the audit log is signed, together with how far the archive reaches. Which of three ways was
      //    decided by `inspect`, before anything ran: an empty log (new database or not) is signed as empty; a log
      //    whose end the previous version signed keeps THAT end (it is not recomputed from the tables, which
      //    whoever can write the file could have cut); anything else only by the key holder's explicit acceptance.
      if (version === 5) {
        const log = new SqlAuditLog(opened, keys, quiet);
        if (accepting) {
          log.reseal(now(), accepting);
          acceptanceUsed = true;
        } else if (log.isEmpty()) log.sealHead();
        else log.carryLegacyHead();
        // A database that existed before this step has only ever run in development (nothing else could start).
        writeState(opened, { schema: 5, dev: opened.openedAsNew ? options.mode === 'development' : true });
      }
      if (version > 5) writeState(opened, { schema: version, dev: state?.dev ?? true });
    },
  });
  const refuse = (message: string): never => {
    db.close();
    throw new Error(message);
  };
  if (options.readOnly) {
    try {
      checkKey(db);
      state = readState(db);
    } catch (error) {
      refuse(error instanceof Error ? error.message : 'The database could not be checked.');
    }
    if (!state) refuse('This database has lost the signed record of its state (its schema version, and whether it has been used in development). Refusing to open it. Restore the database from a backup.');
  }
  const mark = () => db.run("INSERT INTO meta (key, value) VALUES ('key_check', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", seal(keys, 'global-connect', KEY_CHECK).text);
  // A database that has ever held development data (sample accounts, readable activation codes for them, a key
  // kept in a file beside it) is never used as a real one. The mark is part of the signed state: deleting a row
  // does not remove it.
  const current = state as DbState | null;
  if (!current) return refuse('The database has no signed record of its state.');
  if (options.mode === 'strict' && current.dev) {
    refuse('This database has been used in development mode (it holds sample accounts and readable activation codes for them). It cannot be used outside development: start with a new database.');
  }
  if (options.mode === 'development' && !current.dev && !options.readOnly) writeState(db, { ...current, dev: true });

  const audit = new SqlAuditLog(db, keys, options.audit);
  if (!options.readOnly) {
    // Before anything is written: nothing has been added to the database that could hide or drop audit entries,
    // and the end of the log is the one this server (or the key holder) signed.
    const problem = audit.startProblem();
    if (problem) {
      // Something added to the database is never acceptable; only an END that is not signed can be accepted, by the key holder.
      if (audit.structureProblem()) refuse(`${problem} Refusing to start. Run "npm run audit:verify".`);
      if (!accepted(audit.endLabel())) refuse(unsigned(audit, problem));
      try {
        audit.reseal(now(), 'the key holder accepted the log as it stood');
        acceptanceUsed = true;
      } catch (error) {
        refuse(error instanceof Error ? error.message : 'The log could not be accepted.');
      }
    }
    if (typeof options.acceptLogEnd === 'string' && !acceptanceUsed) {
      refuse('AUDIT_ACCEPT_LOG_END is set, but the end of the audit log is properly signed and there is nothing to accept. Remove the setting and start again: while it is set, a log cut back to exactly that entry would be accepted.');
    }
  }
  const directory = new SqlDirectory(db, keys, audit);
  const opsUsers = new SqlOpsDirectory(db, keys);

  const activations = new SqlTable<ActivationRecord>(db, 'activations', { indexed: ['userId'], secret: { field: 'pendingTotpSecret', keys } });
  const opsActivations = new SqlTable<ActivationRecord>(db, 'ops_activations', { indexed: ['userId'], secret: { field: 'pendingTotpSecret', keys } });
  const challenges = new SqlTable<LoginChallengeRecord>(db, 'challenges', { indexed: ['userId'] });
  const opsChallenges = new SqlTable<LoginChallengeRecord>(db, 'ops_challenges', { indexed: ['userId'] });
  const sessions = new SqlTable<SessionRecord>(db, 'sessions', { indexed: ['userId'] });
  const opsSessions = new SqlTable<OpsSessionRecord>(db, 'ops_sessions', { indexed: ['userId'] });
  const stepUps = new SqlTable<StepUpRecord>(db, 'step_ups', { indexed: ['userId', 'sessionId'] });
  const attempts = new SqlTable<AttemptRecord>(db, 'attempts', { indexed: ['subject'] });
  const opsAttempts = new SqlTable<AttemptRecord>(db, 'ops_attempts', { indexed: ['subject'] });
  const approvals = new SqlTable<ApprovalRecord>(db, 'ops_approvals', { indexed: ['status'], audit });
  const confirmations = new SqlTable<{ expiresAt: number }>(db, 'ops_confirmations');
  const providerKeys = new SqlTable<ProviderKeyRecord>(db, 'provider_keys');
  const seedCodes = new SqlTable<SeedCode>(db, 'dev_seed_codes');
  if (options.seed && !db.get('SELECT 1 FROM users LIMIT 1') && !db.get('SELECT 1 FROM companies LIMIT 1')) {
    const { seed } = options;
    db.tx(() => {
      for (const user of seed.users) void directory.saveUser(user);
      for (const company of seed.companies) void directory.saveCompany(company);
      for (const membership of seed.memberships) void directory.setMembership(membership);
    });
  }

  const IDLE_COUNTER_MS = 2 * 60 * 60_000;
  return {
    db,
    payments: new SqlHeldPayments(db, directory, audit),
    directory,
    auth: { activations, challenges, sessions, stepUps, attempts },
    ops: { users: opsUsers, activations: opsActivations, challenges: opsChallenges, sessions: opsSessions, attempts: opsAttempts, approvals, confirmations },
    audit,
    providerKeys,
    seedCodes,
    acceptedLogEnd: acceptanceUsed,
    verifyAudit: (checkpoint) => audit.verify(checkpoint),
    rotateKeys() {
      return db.tx(() => {
        let changed = directory.rotateKeys() + opsUsers.rotateKeys();
        if (sealedKeyId(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'key_check'")?.value ?? '') !== keys.current.id) mark();
        audit.resignHead();
        if (state) writeState(db, state);
        // All or nothing: a row that cannot be decrypted throws, naming the row, and the whole rotation is rolled back.
        changed += activations.rotateSecrets(keys.current.id) + opsActivations.rotateSecrets(keys.current.id);
        return changed;
      });
    },
    async sweep(sessionMaxAgeMs, opsSessionMaxAgeMs) {
      const at = now();
      for (const table of [activations, opsActivations, challenges, opsChallenges] as Table<{ expiresAt: number }>[]) await table.deleteWhere((row) => row.expiresAt <= at);
      await confirmations.deleteWhere((row) => row.expiresAt <= at);
      await stepUps.deleteWhere((row) => row.expiresAt <= at);
      // A live lock is never removed. A counter goes only once it is neither locked nor recent.
      for (const table of [attempts, opsAttempts]) await table.deleteWhere((row) => row.lockedUntil <= at && at - row.updatedAt > IDLE_COUNTER_MS);
      await sessions.deleteWhere((row) => at - row.createdAt > sessionMaxAgeMs);
      await opsSessions.deleteWhere((row) => at - row.createdAt > opsSessionMaxAgeMs);
    },
    close: () => db.close(),
  };
}
