/**
 * Storage contracts. The server only ever talks to these interfaces.
 *
 * PLACEHOLDER: the only implementation is in memory (memory.ts) with seed data
 * (seed.ts). Everything is lost on restart. A real deployment implements the
 * same interfaces over a database; see the README.
 */
import type { StepUpAction, UserRole } from '@/api/types';

export type ProviderKey = 'currencycloud' | 'equals';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  /** Null until the account is activated. */
  passwordHash: string | null;
  /** Base32. PLACEHOLDER: a database must encrypt this at rest. */
  totpSecret: string | null;
  /** The newest TOTP time step already accepted, for replay protection. */
  lastTotpStep: number;
  /** SHA-256 of each unused recovery code. */
  recoveryCodeHashes: string[];
  activatedAt: number | null;
  /** Set by operations. A disabled person cannot sign in and has no sessions. */
  disabledAt?: number | null;
  lastSignInAt?: number | null;
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
   * Atomic read-modify-write of one user. `change` returns the new record, or
   * null to leave the user as it is (the condition did not hold). Returns the
   * saved record, or null when nothing was written. A database implements
   * this as a transaction or a compare-and-set loop.
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
  action: StepUpAction;
  payloadHash: string;
  expiresAt: number;
}

export interface AttemptRecord {
  failures: number;
  lockedUntil: number;
  /** Whose credential is being guessed, e.g. `email:a@b.example` or `user:usr_1`; lets operations find and clear locks. */
  subject: string;
  updatedAt: number;
}

/** Idempotency key -> provider order id, kept outside any adapter instance. Key: `<companyId>:<kind>:<idempotency key>`. */
export interface ProviderKeyRecord {
  orderId: string;
  createdAt: number;
}

/** A small keyed table. Keys are always hashes or internal ids, never raw tokens. */
export interface Table<T> {
  get(key: string): Promise<T | null>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Remove every row the predicate matches. */
  deleteWhere(predicate: (value: T) => boolean): Promise<void>;
  count(predicate: (value: T) => boolean): Promise<number>;
  list(predicate?: (value: T) => boolean): Promise<T[]>;
  /**
   * Atomic read-modify-write. `change` gets the current row (or null) and
   * returns the row to store, null to delete it, or undefined to leave it
   * untouched. Returns what is stored afterwards. Every read-modify-write of
   * security state goes through this (or `take`), never get-then-put.
   */
  mutate(key: string, change: (current: T | null) => T | null | undefined): Promise<T | null>;
  /** Atomic read-and-delete: of two simultaneous callers only one gets the row. */
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
  /** Base32. PLACEHOLDER: a database must encrypt this at rest. */
  totpSecret: string | null;
  lastTotpStep: number;
  recoveryCodeHashes: string[];
  activatedAt: number | null;
  disabledAt: number | null;
  lastSignInAt: number | null;
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
  /** CSRF anchors handed to browsers before sign-in, by SHA-256. */
  preSessions: Table<{ expiresAt: number }>;
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

/** Append-only by contract: there is no way to change or remove an entry. */
export interface AuditLog {
  /**
   * A failure by a person nobody has identified (`actor.id === null`) goes to a
   * separate, bounded, rate-limited stream with a truncated label, so that
   * anonymous noise can never push out or fill the main log. Everything else
   * goes to the main log; when that cannot take the entry, append THROWS
   * rather than drop it or an older one.
   */
  append(entry: Omit<AuditEntry, 'id' | 'anonymous'>): Promise<void>;
  /** Throws when the main log cannot take another entry, so a change is refused BEFORE it is made rather than made unrecorded. */
  assertCapacity(): Promise<void>;
  /** Newest first. */
  query(filter?: AuditFilter): Promise<AuditEntry[]>;
}

export interface Stores {
  directory: Directory;
  auth: AuthStore;
  ops: OpsStore;
  audit: AuditLog;
  providerKeys: Table<ProviderKeyRecord>;
}
