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
}

/** A small keyed table. Keys are always hashes or internal ids, never raw tokens. */
export interface Table<T> {
  get(key: string): Promise<T | null>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Remove every row the predicate matches. */
  deleteWhere(predicate: (value: T) => boolean): Promise<void>;
  count(predicate: (value: T) => boolean): Promise<number>;
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
  list(): Promise<OpsUserRecord[]>;
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
  append(entry: Omit<AuditEntry, 'id'>): Promise<void>;
  /** Newest first. */
  query(filter?: AuditFilter): Promise<AuditEntry[]>;
}

export interface Stores {
  directory: Directory;
  auth: AuthStore;
  ops: OpsStore;
  audit: AuditLog;
}
