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
}

export interface CompanyRecord {
  id: string;
  name: string;
  /** Which provider holds this company's account. Never sent to the app. */
  providerKey: ProviderKey;
  /** The company's account and contact ids at that provider. Never sent to the app. */
  providerAccountId: string;
  providerContactId: string;
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
}

export interface AuthStore {
  activations: Table<ActivationRecord>;
  challenges: Table<LoginChallengeRecord>;
  sessions: Table<SessionRecord>;
  stepUps: Table<StepUpRecord>;
  attempts: Table<AttemptRecord>;
}

export interface Stores {
  directory: Directory;
  auth: AuthStore;
}
