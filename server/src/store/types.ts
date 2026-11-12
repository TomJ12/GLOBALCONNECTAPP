/**
 * Storage contracts. The server only ever talks to these interfaces.
 *
 * The implementation is SQLite (store/sqlite/). Services import only these
 * interfaces: no SQL and no SQLite type appears outside that folder, so moving
 * to another database means writing that folder again.
 */
import type { StepUpAction, UserRole } from '@/api/types';

export type ProviderKey = 'currencycloud' | 'equals';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  /** Null until the account is activated. */
  passwordHash: string | null;
  /** Base32. The store encrypts it at rest (store/sqlite/keys.ts); services see it in plain form. */
  totpSecret: string | null;
  /** The newest TOTP time step already accepted, for replay protection. */
  lastTotpStep: number;
  /** SHA-256 of each unused recovery code. */
  recoveryCodeHashes: string[];
  activatedAt: number | null;
  /** Set by operations. A disabled person cannot sign in and has no sessions. */
  disabledAt?: number | null;
  lastSignInAt?: number | null;
  /** Networks (IPv4 /24, IPv6 /64) this person has completed a full sign-in from. A few, newest last. Not a secret. */
  knownSources?: string[];
}

export interface CompanyRecord {
  id: string;
  name: string;
  /** Which provider holds this company's account. Never sent to the app. */
  providerKey: ProviderKey;
  /** The company's account and contact ids at that provider. Never sent to the app. */
  providerAccountId: string;
  providerContactId: string;
  /** Set by operations. A deactivated company cannot be selected or used by anyone. */
  deactivatedAt?: number | null;
  /** The name before the last rename and when that was, so an approver is not misled by a fresh name. */
  previousName?: string | null;
  renamedAt?: number | null;
}

export interface Membership {
  userId: string;
  companyId: string;
  role: UserRole;
}

/** Users, companies and who may act for which company. Maintained by operations. */
export interface Directory {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  getUser(id: string): Promise<UserRecord | null>;
  saveUser(user: UserRecord): Promise<void>;
  /**
   * Atomic read-modify-write of one user, in one database transaction.
   * `change` returns the new record, or null to leave the user as it is (the
   * condition did not hold). Returns the saved record, or null when nothing
   * was written.
   */
  updateUser(id: string, change: (user: UserRecord) => UserRecord | null): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  getCompany(id: string): Promise<CompanyRecord | null>;
  membershipsOf(userId: string): Promise<Membership[]>;
  listCompanies(): Promise<CompanyRecord[]>;
  saveCompany(company: CompanyRecord): Promise<void>;
  listMemberships(): Promise<Membership[]>;
  /** Adds the membership, or changes its role when it exists. */
  setMembership(membership: Membership): Promise<void>;
  removeMembership(userId: string, companyId: string): Promise<void>;
}

export interface ActivationRecord {
  userId: string;
  expiresAt: number;
  /** Set as the person works through activation; applied to the user only when it completes. */
  pendingPasswordHash: string | null;
  pendingTotpSecret: string | null;
}

export interface LoginChallengeRecord {
  userId: string;
  expiresAt: number;
  attempts: number;
}

export interface SessionRecord {
  id: string;
  userId: string;
  /** Null until the person picks a company (only when they have several). */
  companyId: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export interface StepUpRecord {
  userId: string;
  sessionId: string;
  /** The company the permission was given for. It is good for that company only. */
  companyId: string | null;
  action: StepUpAction;
  payloadHash: string;
  expiresAt: number;
}

export interface AttemptRecord {
  failures: number;
  lockedUntil: number;
  /** How many locks this counter has started; the next one is that many times doubled. */
  locks: number;
  /** Whose credential is being guessed, e.g. `email:a@b.example` or `user:usr_1`; lets operations find and clear locks. */
  subject: string;
  updatedAt: number;
}

/** Idempotency key -> provider order id, kept outside any adapter instance. Key: `<companyId>:<kind>:<idempotency key>`. */
export interface ProviderKeyRecord {
  orderId: string;
  createdAt: number;
}

/**
 * Which rows: an object of fields that must be equal (the store can use an
 * index for these), or, for tests and one-off administration only, a function
 * (the store then reads every row).
 */
export type Where<T> = Partial<T> | ((row: T) => boolean);

/** A small keyed table. Keys are always hashes or internal ids, never raw tokens. */
export interface Table<T> {
  get(key: string): Promise<T | null>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Remove every row that matches (and, when given, passes `filter`). */
  deleteWhere(where: Where<T>, filter?: (row: T) => boolean): Promise<void>;
  count(where: Where<T>, filter?: (row: T) => boolean): Promise<number>;
  list(where?: Where<T>, filter?: (row: T) => boolean): Promise<T[]>;
  /**
   * Atomic read-modify-write, in ONE database transaction that holds the
   * write lock from before the read. `change` gets the current row (or null)
   * and returns the row to store, null to delete it, or undefined to leave it
   * untouched. Returns what is stored afterwards. Every read-modify-write of
   * security state goes through this (or `take`), never get-then-put.
   */
  mutate(key: string, change: (current: T | null) => T | null | undefined): Promise<T | null>;
  /** Atomic read-and-delete: of two simultaneous callers, in this process or another, only one gets the row. */
  take(key: string): Promise<T | null>;
}

export interface AuthStore {
  activations: Table<ActivationRecord>;
  challenges: Table<LoginChallengeRecord>;
  sessions: Table<SessionRecord>;
  stepUps: Table<StepUpRecord>;
  attempts: Table<AttemptRecord>;
}

// --- Operations staff: a separate account table and separate session tables ---

export type OpsRole = 'ops' | 'ops_admin';

export interface OpsUserRecord {
  id: string;
  email: string;
  name: string;
  role: OpsRole;
  passwordHash: string | null;
  /** Base32. The store encrypts it at rest (store/sqlite/keys.ts); services see it in plain form. */
  totpSecret: string | null;
  lastTotpStep: number;
  recoveryCodeHashes: string[];
  activatedAt: number | null;
  disabledAt: number | null;
  lastSignInAt: number | null;
  /** See UserRecord.knownSources. */
  knownSources?: string[];
}

export interface OpsDirectory {
  findByEmail(email: string): Promise<OpsUserRecord | null>;
  get(id: string): Promise<OpsUserRecord | null>;
  save(user: OpsUserRecord): Promise<void>;
  /** Atomic read-modify-write; see Directory.updateUser. */
  update(id: string, change: (user: OpsUserRecord) => OpsUserRecord | null): Promise<OpsUserRecord | null>;
  list(): Promise<OpsUserRecord[]>;
}

/** A change one staff member asked for that another must approve before it takes effect. */
export interface ApprovalRecord {
  id: string;
  /** The console action, e.g. `client.reset_authenticator`. */
  action: string;
  /** The validated input of the action. Never a credential. */
  params: Record<string, string>;
  /** One line for the approver: what will happen. */
  summary: string;
  /** Consequences the approver must see (for example sessions that will be ended). */
  warnings: string[];
  target: AuditParty | null;
  requestedBy: { id: string; email: string };
  requestedAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  decidedBy: { id: string; email: string } | null;
  decidedAt: number | null;
}

export interface OpsSessionRecord {
  id: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface OpsStore {
  users: OpsDirectory;
  activations: Table<ActivationRecord>;
  challenges: Table<LoginChallengeRecord>;
  sessions: Table<OpsSessionRecord>;
  attempts: Table<AttemptRecord>;
  approvals: Table<ApprovalRecord>;
}

// --- Audit log -----------------------------------------------------------------

export interface AuditParty {
  type: 'client' | 'ops' | 'system' | 'company';
  /** Internal id, or null when the account is unknown (a failed sign-in). */
  id: string | null;
  /** Email or name, for reading. */
  label: string;
}

export interface AuditEntry {
  id: string;
  at: number;
  actor: AuditParty;
  target: AuditParty | null;
  /** e.g. `client.sign_in`, `ops.client.reset_authenticator`. */
  action: string;
  outcome: 'success' | 'failure';
  /** Network address the request came from; empty for server-internal events. */
  source: string;
  /** Short facts about the event. NEVER a password, key, code or token. */
  detail: Record<string, string>;
  /** True for a failure by nobody we can identify (see AuditLog.append). */
  anonymous?: boolean;
}

export interface AuditFilter {
  actor?: string;
  target?: string;
  action?: string;
  from?: number;
  to?: number;
  limit?: number;
}

/**
 * Append-only by contract: there is no way to change or remove an entry.
 *
 * `append` must not fail because the log is "full". An implementation with a
 * bounded working set moves a full segment to an archive (AuditArchive) and
 * carries on, telling the operator loudly; it never refuses the entry and
 * never drops the newest ones. A database implementation simply inserts.
 */
export interface AuditLog {
  /**
   * A failure by a person nobody has identified (`actor.id === null`) goes to a
   * separate, bounded, rate-limited stream with a truncated label, so that
   * anonymous noise can never push out or fill the main log.
   */
  append(entry: Omit<AuditEntry, 'id' | 'anonymous'>): Promise<void>;
  /** Newest first. */
  query(filter?: AuditFilter): Promise<AuditEntry[]>;
}

/** Where a full segment of the main log goes. Durable in a real deployment. */
export interface AuditArchive {
  write(segment: AuditEntry[]): Promise<string>;
}

export interface Stores {
  directory: Directory;
  auth: AuthStore;
  ops: OpsStore;
  audit: AuditLog;
  providerKeys: Table<ProviderKeyRecord>;
}
