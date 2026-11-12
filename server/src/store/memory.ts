/** In-memory storage. PLACEHOLDER for a real database: nothing survives a restart (but see file.ts for the local demo). */
import { randomBytes } from 'node:crypto';

import type {
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

/** Keeps at most `limit` rows, dropping the oldest, so unauthenticated requests cannot grow memory without bound. */
export class MemoryTable<T> implements Table<T> {
  private readonly rows = new Map<string, T>();
  constructor(
    private readonly limit = 100_000,
    initial: Record<string, T> = {},
    private readonly changed: Changed = nothing,
  ) {
    for (const [key, value] of Object.entries(initial)) this.rows.set(key, value);
  }

  async get(key: string): Promise<T | null> {
    const row = this.rows.get(key);
    return row === undefined ? null : structuredClone(row);
  }
  async put(key: string, value: T): Promise<void> {
    this.rows.delete(key);
    this.rows.set(key, structuredClone(value));
    if (this.rows.size > this.limit) {
      const oldest = this.rows.keys().next().value;
      if (oldest !== undefined) this.rows.delete(oldest);
    }
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
    await this.removeMembership(membership.userId, membership.companyId);
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
  async list(): Promise<OpsUserRecord[]> {
    return [...this.users.values()].map((user) => structuredClone(user));
  }
  snapshot(): OpsUserRecord[] {
    return structuredClone([...this.users.values()]);
  }
}

/**
 * Append-only: the class has no method that changes or removes an entry.
 * PLACEHOLDER: held in memory and capped (oldest dropped) so unauthenticated
 * failures cannot grow it without bound; a real deployment ships entries to
 * durable, write-once storage.
 */
export class MemoryAuditLog implements AuditLog {
  private entries: AuditEntry[];
  constructor(
    initial: AuditEntry[] = [],
    private readonly changed: Changed = nothing,
    private readonly limit = 100_000,
  ) {
    this.entries = structuredClone(initial);
  }
  async append(entry: Omit<AuditEntry, 'id'>): Promise<void> {
    this.entries.push(structuredClone({ ...entry, id: `evt_${randomBytes(9).toString('base64url')}` }));
    if (this.entries.length > this.limit) this.entries.shift();
    this.changed();
  }
  async query(filter: AuditFilter = {}): Promise<AuditEntry[]> {
    const has = (party: AuditEntry['actor'] | null, wanted: string | undefined) =>
      !wanted || (party !== null && `${party.label} ${party.id ?? ''}`.toLowerCase().includes(wanted.trim().toLowerCase()));
    const out: AuditEntry[] = [];
    for (let index = this.entries.length - 1; index >= 0 && out.length < (filter.limit ?? 500); index -= 1) {
      const entry = this.entries[index] as AuditEntry;
      if (filter.from !== undefined && entry.at < filter.from) continue;
      if (filter.to !== undefined && entry.at > filter.to) continue;
      if (filter.action && !entry.action.includes(filter.action.trim().toLowerCase())) continue;
      if (!has(entry.actor, filter.actor) || !has(entry.target, filter.target)) continue;
      out.push(structuredClone(entry));
    }
    return out;
  }
  snapshot(): AuditEntry[] {
    return structuredClone(this.entries);
  }
}

export function createMemoryAuthStore(): AuthStore {
  return {
    activations: new MemoryTable(),
    challenges: new MemoryTable(),
    sessions: new MemoryTable(),
    stepUps: new MemoryTable(),
    attempts: new MemoryTable(),
  };
}

export function createMemoryOpsStore(): OpsStore {
  return {
    users: new MemoryOpsDirectory(),
    activations: new MemoryTable(),
    challenges: new MemoryTable(),
    sessions: new MemoryTable(),
    attempts: new MemoryTable(),
  };
}

export function createMemoryStores(data: DirectoryData): Stores {
  return { directory: new MemoryDirectory(data), auth: createMemoryAuthStore(), ops: createMemoryOpsStore(), audit: new MemoryAuditLog() };
}
