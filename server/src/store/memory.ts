/** In-memory storage. PLACEHOLDER for a real database: nothing survives a restart. */
import type { AuthStore, CompanyRecord, Directory, Membership, Stores, Table, UserRecord } from './types';

/** Keeps at most `limit` rows, dropping the oldest, so unauthenticated requests cannot grow memory without bound. */
export class MemoryTable<T> implements Table<T> {
  private readonly rows = new Map<string, T>();
  constructor(private readonly limit = 100_000) {}

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
  }
  async delete(key: string): Promise<void> {
    this.rows.delete(key);
  }
  async deleteWhere(predicate: (value: T) => boolean): Promise<void> {
    for (const [key, value] of this.rows) if (predicate(value)) this.rows.delete(key);
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
  private readonly memberships: Membership[];

  constructor(data: DirectoryData) {
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

export function createMemoryStores(data: DirectoryData): Stores {
  return { directory: new MemoryDirectory(data), auth: createMemoryAuthStore() };
}
