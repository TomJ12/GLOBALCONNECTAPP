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
import { open, seal, sealedKeyId, type DataKeys } from './keys';
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
}

export interface SqliteStores extends Stores {
  db: Db;
  audit: SqlAuditLog;
  seedCodes: Table<SeedCode>;
  verifyAudit(checkpoint?: AuditCheckpoint): AuditVerification;
  /** Re-encrypts every stored secret with the current key. Returns how many were changed. */
  rotateKeys(): number;
  /** Removes rows that are over: expired invitations, challenges and permissions, idle unlocked counters, sessions past their absolute life. */
  sweep(sessionMaxAgeMs: number, opsSessionMaxAgeMs: number): Promise<void>;
  close(): void;
}

export function createSqliteStores(options: SqliteOptions): SqliteStores {
  const now = options.now ?? Date.now;
  const { keys } = options;
  const KEY_CHECK = 'meta:key_check';
  // What the migrations need that SQL alone cannot do. Each runs inside its migration's own transaction, so a
  // database either has the schema AND these, or neither.
  const db = new Db(options.path, {
    readOnly: options.readOnly,
    onMigrate(version, opened) {
      // 1: the key marker is made ONCE, when the schema is. A database that later turns up without it is refused,
      //    so deleting the marker does not let a different key in.
      if (version === 1) opened.run("INSERT INTO meta (key, value) VALUES ('key_check', ?)", seal(keys, 'global-connect', KEY_CHECK).text);
      // 4: the end of the audit log is signed as it stands, and company names get their compared form.
      if (version === 4) {
        new SqlAuditLog(opened, keys, { ...options.audit, notice: () => {} }).sealHead();
        new SqlDirectory(opened, keys).backfillNameKeys();
      }
    },
  });
  const refuse = (message: string): never => {
    db.close();
    throw new Error(message);
  };
  // The wrong key is refused here, at start-up, rather than discovered at somebody's sign-in.
  const marker = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'key_check'")?.value;
  const mark = () => db.run("INSERT INTO meta (key, value) VALUES ('key_check', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", seal(keys, 'global-connect', KEY_CHECK).text);
  if (marker === undefined) {
    refuse('This database has lost the marker that says which encryption key it was written with, so the key cannot be checked. Refusing to open it. Restore the database from a backup.');
  } else {
    try {
      if (open(keys, marker, KEY_CHECK) !== 'global-connect') throw new Error('mismatch');
    } catch {
      refuse('DATA_ENCRYPTION_KEY is not the key this database was written with. Nothing was changed. Set the right key (or, after a rotation, list the older one in DATA_ENCRYPTION_KEY_PREVIOUS).');
    }
  }
  // A database that has ever held development data (sample accounts, readable activation codes for them, a key
  // kept in a file beside it) is never used as a real one.
  const usedInDevelopment = db.get("SELECT 1 FROM meta WHERE key = 'used_in_development'") !== undefined;
  if (options.mode === 'strict' && usedInDevelopment) {
    refuse('This database has been used in development mode (it holds sample accounts and readable activation codes for them). It cannot be used outside development: start with a new database.');
  }
  if (options.mode === 'development' && !usedInDevelopment && !options.readOnly) db.run("INSERT INTO meta (key, value) VALUES ('used_in_development', '1')");

  const audit = new SqlAuditLog(db, keys, options.audit);
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
    verifyAudit: (checkpoint) => audit.verify(checkpoint),
    rotateKeys() {
      return db.tx(() => {
        let changed = directory.rotateKeys() + opsUsers.rotateKeys();
        if (sealedKeyId(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'key_check'")?.value ?? '') !== keys.current.id) mark();
        audit.resignHead();
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
