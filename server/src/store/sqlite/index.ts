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
import { SqlAuditLog, type AuditOptions, type AuditVerification } from './audit';
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
}

export interface SqliteStores extends Stores {
  db: Db;
  audit: SqlAuditLog;
  seedCodes: Table<SeedCode>;
  verifyAudit(): AuditVerification;
  /** Re-encrypts every stored secret with the current key. Returns how many were changed. */
  rotateKeys(): number;
  /** Removes rows that are over: expired invitations, challenges and permissions, idle unlocked counters, sessions past their absolute life. */
  sweep(sessionMaxAgeMs: number, opsSessionMaxAgeMs: number): Promise<void>;
  close(): void;
}

export function createSqliteStores(options: SqliteOptions): SqliteStores {
  const db = new Db(options.path);
  const now = options.now ?? Date.now;
  const { keys } = options;
  // The wrong key is refused here, at start-up, rather than discovered at somebody's sign-in.
  const KEY_CHECK = 'meta:key_check';
  const marker = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'key_check'")?.value;
  const mark = () => db.run("INSERT INTO meta (key, value) VALUES ('key_check', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", seal(keys, 'global-connect', KEY_CHECK).text);
  if (marker === undefined) mark();
  else {
    try {
      if (open(keys, marker, KEY_CHECK) !== 'global-connect') throw new Error('mismatch');
    } catch {
      db.close();
      throw new Error('DATA_ENCRYPTION_KEY is not the key this database was written with. Nothing was changed. Set the right key (or, after a rotation, list the older one in DATA_ENCRYPTION_KEY_PREVIOUS).');
    }
  }
  const directory = new SqlDirectory(db, keys);
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
  const approvals = new SqlTable<ApprovalRecord>(db, 'ops_approvals', { indexed: ['status'] });
  const confirmations = new SqlTable<{ expiresAt: number }>(db, 'ops_confirmations');
  const providerKeys = new SqlTable<ProviderKeyRecord>(db, 'provider_keys');
  const seedCodes = new SqlTable<SeedCode>(db, 'dev_seed_codes');
  const audit = new SqlAuditLog(db, keys, options.audit);

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
    payments: new SqlHeldPayments(db, directory),
    directory,
    auth: { activations, challenges, sessions, stepUps, attempts },
    ops: { users: opsUsers, activations: opsActivations, challenges: opsChallenges, sessions: opsSessions, attempts: opsAttempts, approvals, confirmations },
    audit,
    providerKeys,
    seedCodes,
    verifyAudit: () => audit.verify(),
    rotateKeys() {
      return db.tx(() => {
        let changed = directory.rotateKeys() + opsUsers.rotateKeys();
        if (sealedKeyId(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'key_check'")?.value ?? '') !== keys.current.id) mark();
        // Reading decrypts with whichever key made the row; writing encrypts with the current one.
        for (const [name, table] of [['activations', activations], ['ops_activations', opsActivations]] as const) {
          for (const row of db.all<{ key: string; data: string }>(`SELECT key, data FROM ${name}`)) {
            const sealed = (JSON.parse(row.data) as { pendingTotpSecret?: string | null }).pendingTotpSecret;
            if (typeof sealed !== 'string' || sealed.split(':')[1] === keys.current.id) continue;
            void table.mutate(row.key, (current) => current);
            changed += 1;
          }
        }
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
