/** In-memory storage. PLACEHOLDER for a real database: nothing survives a restart (but see file.ts for the local demo). */
import { randomBytes } from 'node:crypto';

import type {
  AttemptRecord,
  AuditEntry,
  AuditFilter,
  AuditLog,
  AuthStore,
  CompanyRecord,
  Directory,
  Membership,
  OpsDirectory,
  OpsStore,
  OpsUserRecord,
  Stores,
  Table,
  UserRecord,
} from './types';

type Changed = () => void;
const nothing: Changed = () => {};

export interface TableOptions<T> {
  limit?: number;
  initial?: Record<string, T>;
  changed?: Changed;
  /** Rows that are over: removed first when the table is full. */
  expired?: (row: T) => boolean;
  /** Rows that must never be evicted to make room (a live lock). */
  keep?: (row: T) => boolean;
}

/**
 * Bounded, so unauthenticated requests cannot grow memory without limit. When
 * full it drops expired rows, then the oldest row that is not protected by
 * `keep`; if every row is protected it refuses the write (fails closed).
 * Each method body is synchronous, which is what makes mutate/take atomic here.
 */
export class MemoryTable<T> implements Table<T> {
  private readonly rows = new Map<string, T>();
  private readonly limit: number;
  private readonly changed: Changed;
  constructor(private readonly options: TableOptions<T> = {}) {
    this.limit = options.limit ?? 100_000;
    this.changed = options.changed ?? nothing;
    for (const [key, value] of Object.entries(options.initial ?? {})) this.rows.set(key, value);
  }

  private makeRoom(): void {
    if (this.rows.size < this.limit) return;
    const { expired, keep } = this.options;
    if (expired) for (const [key, value] of this.rows) if (expired(value)) this.rows.delete(key);
    if (this.rows.size < this.limit) return;
    for (const [key, value] of this.rows) {
      if (keep?.(value)) continue;
      this.rows.delete(key);
      return;
    }
    throw new Error('Table is full of rows that must be kept');
  }
  private write(key: string, value: T): void {
    if (!this.rows.has(key)) this.makeRoom();
    this.rows.delete(key);
    this.rows.set(key, structuredClone(value));
  }

  async get(key: string): Promise<T | null> {
    const row = this.rows.get(key);
    return row === undefined ? null : structuredClone(row);
  }
  async put(key: string, value: T): Promise<void> {
    this.write(key, value);
    this.changed();
  }
  async delete(key: string): Promise<void> {
    if (this.rows.delete(key)) this.changed();
  }
  async deleteWhere(predicate: (value: T) => boolean): Promise<void> {
    let removed = false;
    for (const [key, value] of this.rows) if (predicate(value)) removed = this.rows.delete(key) || removed;
    if (removed) this.changed();
  }
  async count(predicate: (value: T) => boolean): Promise<number> {
    let total = 0;
    for (const value of this.rows.values()) if (predicate(value)) total += 1;
    return total;
  }
  async list(predicate: (value: T) => boolean = () => true): Promise<T[]> {
    return [...this.rows.values()].filter(predicate).map((row) => structuredClone(row));
  }
  async mutate(key: string, change: (current: T | null) => T | null | undefined): Promise<T | null> {
    const current = this.rows.get(key);
    const next = change(current === undefined ? null : structuredClone(current));
    if (next === undefined) return current === undefined ? null : structuredClone(current);
    if (next === null) {
      if (this.rows.delete(key)) this.changed();
      return null;
    }
    this.write(key, next);
    this.changed();
    return structuredClone(next);
  }
  async take(key: string): Promise<T | null> {
    const row = this.rows.get(key);
    if (row === undefined) return null;
    this.rows.delete(key);
    this.changed();
    return row;
  }
  snapshot(): Record<string, T> {
    return Object.fromEntries(this.rows);
  }
}

export interface DirectoryData {
  users: UserRecord[];
  companies: CompanyRecord[];
  memberships: Membership[];
}

export class MemoryDirectory implements Directory {
  private readonly users = new Map<string, UserRecord>();
  private readonly companies = new Map<string, CompanyRecord>();
  private memberships: Membership[];

  constructor(
    data: DirectoryData,
    private readonly changed: Changed = nothing,
  ) {
    for (const user of data.users) this.users.set(user.id, structuredClone(user));
    for (const company of data.companies) this.companies.set(company.id, structuredClone(company));
    this.memberships = structuredClone(data.memberships);
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const wanted = email.trim().toLowerCase();
    for (const user of this.users.values()) if (user.email === wanted) return structuredClone(user);
    return null;
  }
  async getUser(id: string): Promise<UserRecord | null> {
    const user = this.users.get(id);
    return user ? structuredClone(user) : null;
  }
  async saveUser(user: UserRecord): Promise<void> {
    this.users.set(user.id, structuredClone(user));
    this.changed();
  }
  async updateUser(id: string, change: (user: UserRecord) => UserRecord | null): Promise<UserRecord | null> {
    const current = this.users.get(id);
    const next = current ? change(structuredClone(current)) : null;
    if (!next) return null;
    this.users.set(id, structuredClone(next));
    this.changed();
    return structuredClone(next);
  }
  async listUsers(): Promise<UserRecord[]> {
    return [...this.users.values()].map((user) => structuredClone(user));
  }
  async getCompany(id: string): Promise<CompanyRecord | null> {
    const company = this.companies.get(id);
    return company ? structuredClone(company) : null;
  }
  async membershipsOf(userId: string): Promise<Membership[]> {
    return this.memberships.filter((membership) => membership.userId === userId).map((membership) => ({ ...membership }));
  }
  async listCompanies(): Promise<CompanyRecord[]> {
    return [...this.companies.values()].map((company) => structuredClone(company));
  }
  async saveCompany(company: CompanyRecord): Promise<void> {
    this.companies.set(company.id, structuredClone(company));
    this.changed();
  }
  async listMemberships(): Promise<Membership[]> {
    return this.memberships.map((membership) => ({ ...membership }));
  }
  async setMembership(membership: Membership): Promise<void> {
    this.memberships = this.memberships.filter((item) => !(item.userId === membership.userId && item.companyId === membership.companyId));
    this.memberships.push({ ...membership });
    this.changed();
  }
  async removeMembership(userId: string, companyId: string): Promise<void> {
    this.memberships = this.memberships.filter((item) => !(item.userId === userId && item.companyId === companyId));
    this.changed();
  }
  snapshot(): DirectoryData {
    return structuredClone({ users: [...this.users.values()], companies: [...this.companies.values()], memberships: this.memberships });
  }
}

export class MemoryOpsDirectory implements OpsDirectory {
  private readonly users = new Map<string, OpsUserRecord>();
  constructor(
    initial: OpsUserRecord[] = [],
    private readonly changed: Changed = nothing,
  ) {
    for (const user of initial) this.users.set(user.id, structuredClone(user));
  }
  async findByEmail(email: string): Promise<OpsUserRecord | null> {
    const wanted = email.trim().toLowerCase();
    for (const user of this.users.values()) if (user.email === wanted) return structuredClone(user);
    return null;
  }
  async get(id: string): Promise<OpsUserRecord | null> {
    const user = this.users.get(id);
    return user ? structuredClone(user) : null;
  }
  async save(user: OpsUserRecord): Promise<void> {
    this.users.set(user.id, structuredClone(user));
    this.changed();
  }
  async update(id: string, change: (user: OpsUserRecord) => OpsUserRecord | null): Promise<OpsUserRecord | null> {
    const current = this.users.get(id);
    const next = current ? change(structuredClone(current)) : null;
    if (!next) return null;
    this.users.set(id, structuredClone(next));
    this.changed();
    return structuredClone(next);
  }
  async list(): Promise<OpsUserRecord[]> {
    return [...this.users.values()].map((user) => structuredClone(user));
  }
  snapshot(): OpsUserRecord[] {
    return structuredClone([...this.users.values()]);
  }
}

export interface AuditOptions {
  /** Most entries the main log holds. When reached, append and assertCapacity throw: nothing is dropped. */
  limit?: number;
  /** Size of the ring that holds failures by unidentified actors. */
  anonymousLimit?: number;
  /** Anonymous failures recorded per source address per minute; the rest are counted, not stored. */
  anonymousPerMinute?: number;
}

const ANONYMOUS_LABEL_LENGTH = 80;

/**
 * Append-only: the class has no method that changes or removes a main entry.
 * PLACEHOLDER: held in memory. A real deployment needs durable, write-once
 * storage with shipping and retention; this one stops accepting changes when
 * full instead of forgetting its oldest entries.
 */
export class MemoryAuditLog implements AuditLog {
  private readonly entries: AuditEntry[];
  /** Failures by nobody we can identify. A ring: bounded, and separate, so it can never evict or fill the main log. */
  private anonymous: AuditEntry[] = [];
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  /** Anonymous failures not stored because their source was over its rate. */
  suppressed = 0;
  private readonly limit: number;
  private readonly anonymousLimit: number;
  private readonly anonymousPerMinute: number;

  constructor(
    initial: AuditEntry[] = [],
    private readonly changed: Changed = nothing,
    options: AuditOptions = {},
  ) {
    this.entries = structuredClone(initial);
    this.limit = options.limit ?? 100_000;
    this.anonymousLimit = options.anonymousLimit ?? 5_000;
    this.anonymousPerMinute = options.anonymousPerMinute ?? 20;
  }

  async assertCapacity(): Promise<void> {
    if (this.entries.length >= this.limit) throw new Error('The audit log is full. Changes are refused until it has been archived.');
  }

  async append(entry: Omit<AuditEntry, 'id' | 'anonymous'>): Promise<void> {
    const id = `evt_${randomBytes(9).toString('base64url')}`;
    if (entry.actor.id === null && entry.actor.type !== 'system' && entry.outcome === 'failure') {
      const window = this.windows.get(entry.source);
      if (!window || entry.at - window.startedAt >= 60_000) {
        if (this.windows.size >= 10_000) this.windows.delete(this.windows.keys().next().value as string);
        this.windows.set(entry.source, { startedAt: entry.at, count: 1 });
      } else if ((window.count += 1) > this.anonymousPerMinute) {
        this.suppressed += 1;
        return;
      }
      const actor = { ...entry.actor, label: entry.actor.label.slice(0, ANONYMOUS_LABEL_LENGTH) };
      this.anonymous.push(structuredClone({ ...entry, actor, id, anonymous: true }));
      if (this.anonymous.length > this.anonymousLimit) this.anonymous.shift();
      // Not persisted: anonymous noise must not cause writes.
      return;
    }
    await this.assertCapacity();
    this.entries.push(structuredClone({ ...entry, id }));
    this.changed();
  }

  async query(filter: AuditFilter = {}): Promise<AuditEntry[]> {
    const has = (party: AuditEntry['actor'] | null, wanted: string | undefined) =>
      !wanted || (party !== null && `${party.label} ${party.id ?? ''}`.toLowerCase().includes(wanted.trim().toLowerCase()));
    const all = [...this.entries, ...this.anonymous].sort((a, b) => a.at - b.at);
    const out: AuditEntry[] = [];
    for (let index = all.length - 1; index >= 0 && out.length < (filter.limit ?? 500); index -= 1) {
      const entry = all[index] as AuditEntry;
      if (filter.from !== undefined && entry.at < filter.from) continue;
      if (filter.to !== undefined && entry.at > filter.to) continue;
      if (filter.action && !entry.action.includes(filter.action.trim().toLowerCase())) continue;
      if (!has(entry.actor, filter.actor) || !has(entry.target, filter.target)) continue;
      out.push(structuredClone(entry));
    }
    return out;
  }
  /** The main log only. */
  snapshot(): AuditEntry[] {
    return structuredClone(this.entries);
  }
}

/** Attempt counters: expire by time, and a live lock is never evicted to make room. */
export function attemptsTable(now: () => number, more: Pick<TableOptions<AttemptRecord>, 'initial' | 'changed' | 'limit'> = {}): MemoryTable<AttemptRecord> {
  const IDLE_MS = 2 * 60 * 60_000;
  return new MemoryTable<AttemptRecord>({
    ...more,
    keep: (row) => row.lockedUntil > now(),
    expired: (row) => row.lockedUntil <= now() && now() - row.updatedAt > IDLE_MS,
  });
}

export function createMemoryAuthStore(now: () => number = Date.now): AuthStore {
  return {
    activations: new MemoryTable(),
    challenges: new MemoryTable(),
    sessions: new MemoryTable(),
    stepUps: new MemoryTable(),
    attempts: attemptsTable(now),
  };
}

export function createMemoryOpsStore(now: () => number = Date.now): OpsStore {
  return {
    users: new MemoryOpsDirectory(),
    activations: new MemoryTable(),
    challenges: new MemoryTable(),
    sessions: new MemoryTable(),
    attempts: attemptsTable(now),
    approvals: new MemoryTable(),
    preSessions: new MemoryTable({ limit: 50_000, expired: (row) => row.expiresAt <= now() }),
  };
}

export function createMemoryStores(data: DirectoryData, now: () => number = Date.now, audit: AuditOptions = {}): Stores {
  return {
    directory: new MemoryDirectory(data),
    auth: createMemoryAuthStore(now),
    ops: createMemoryOpsStore(now),
    audit: new MemoryAuditLog([], nothing, audit),
    providerKeys: new MemoryTable({ limit: 1_000_000 }),
  };
}
