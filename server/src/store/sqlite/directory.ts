/** Users, companies, memberships and staff accounts over SQLite. Authenticator keys are encrypted at rest. */
import type { UserRole } from '@/api/types';

import { nameKey } from '../../validate';
import { approvalsRequiredOf, StoreConflict, type ApprovalsRequired, type AuditInput, type AuditWith, type CompanyMember, type CompanyRecord, type Directory, type Membership, type OpsDirectory, type OpsRole, type OpsUserRecord, type ProviderKey, type UserRecord } from '../types';
import type { Db, Row } from './db';
import { open, seal, sealedKeyId, type DataKeys } from './keys';
import { writeAudit } from './tables';

type AccountRow = Row & { id: string; email: string; name: string; password_hash: string | null; totp_secret: string | null; last_totp_step: number; recovery_code_hashes: string; activated_at: number | null; disabled_at: number | null; last_sign_in_at: number | null; known_sources: string; role?: string };

const ACCOUNT_FIELDS = 'id, email, name, password_hash, totp_secret, totp_key_id, last_totp_step, recovery_code_hashes, activated_at, disabled_at, last_sign_in_at, known_sources';

/** What the two account tables share. `table` is a constant from this file, never input. */
class Accounts {
  constructor(
    private readonly db: Db,
    private readonly table: 'users' | 'ops_users',
    private readonly keys: DataKeys,
  ) {}

  read(row: AccountRow | undefined): UserRecord | null {
    if (!row) return null;
    const { keys, table } = this;
    let secret: string | null | undefined;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.password_hash,
      // Decrypted only when something actually reads it (a code check, or a rewrite of the row): listing people or
      // checking a session never touches the key. Still an ordinary enumerable property to everything that uses it.
      get totpSecret(): string | null {
        if (secret === undefined) secret = row.totp_secret === null ? null : open(keys, row.totp_secret, `${table}:${row.id}:totp`);
        return secret;
      },
      set totpSecret(value: string | null) {
        secret = value;
      },
      lastTotpStep: row.last_totp_step,
      recoveryCodeHashes: JSON.parse(row.recovery_code_hashes) as string[],
      activatedAt: row.activated_at,
      disabledAt: row.disabled_at,
      lastSignInAt: row.last_sign_in_at,
      knownSources: JSON.parse(row.known_sources) as string[],
    };
  }
  byId(id: string): AccountRow | undefined {
    return this.db.get<AccountRow>(`SELECT * FROM ${this.table} WHERE id = ?`, id);
  }
  byEmail(email: string): AccountRow | undefined {
    return this.db.get<AccountRow>(`SELECT * FROM ${this.table} WHERE email = ?`, email.trim().toLowerCase());
  }
  all(): AccountRow[] {
    return this.db.all<AccountRow>(`SELECT * FROM ${this.table} ORDER BY rowid`);
  }
  write(user: UserRecord, role?: OpsRole): void {
    const sealed = user.totpSecret === null ? null : seal(this.keys, user.totpSecret, `${this.table}:${user.id}:totp`);
    const values = [user.id, user.email, user.name, user.passwordHash, sealed?.text ?? null, sealed?.keyId ?? null, user.lastTotpStep, JSON.stringify(user.recoveryCodeHashes), user.activatedAt, user.disabledAt ?? null, user.lastSignInAt ?? null, JSON.stringify(user.knownSources ?? [])];
    const columns = ACCOUNT_FIELDS.split(', ');
    const extra = role === undefined ? '' : ', role';
    this.db.run(
      `INSERT INTO ${this.table} (${ACCOUNT_FIELDS}${extra}) VALUES (${columns.map(() => '?').join(', ')}${role === undefined ? '' : ', ?'})
       ON CONFLICT (id) DO UPDATE SET ${[...columns.slice(1), ...(role === undefined ? [] : ['role'])].map((column) => `${column} = excluded.${column}`).join(', ')}`,
      ...values,
      ...(role === undefined ? [] : [role]),
    );
  }
  /** Re-encrypts every authenticator key that was not made with the current key. Returns how many. */
  rotate(): number {
    let changed = 0;
    for (const row of this.all()) {
      if (row.totp_secret === null || sealedKeyId(row.totp_secret) === this.keys.current.id) continue;
      let plain: string;
      try {
        plain = open(this.keys, row.totp_secret, `${this.table}:${row.id}:totp`);
      } catch (error) {
        throw new Error(`The authenticator key in table ${this.table}, row ${row.id}, could not be decrypted (${error instanceof Error ? error.message : 'unknown error'}). Nothing was changed.`);
      }
      const sealed = seal(this.keys, plain, `${this.table}:${row.id}:totp`);
      this.db.run(`UPDATE ${this.table} SET totp_secret = ?, totp_key_id = ? WHERE id = ?`, sealed.text, sealed.keyId, row.id);
      changed += 1;
    }
    return changed;
  }
}

type CompanyRow = Row & { id: string; name: string; provider_key: string; provider_account_id: string; provider_contact_id: string; deactivated_at: number | null; previous_name: string | null; renamed_at: number | null; approvals_required: number };
const company = (row: CompanyRow | undefined): CompanyRecord | null =>
  row
    ? { id: row.id, name: row.name, providerKey: row.provider_key as ProviderKey, providerAccountId: row.provider_account_id, providerContactId: row.provider_contact_id, deactivatedAt: row.deactivated_at, previousName: row.previous_name, renamedAt: row.renamed_at, approvalsRequired: row.approvals_required as ApprovalsRequired }
    : null;
const membership = (row: Row): Membership => ({ userId: row.user_id as string, companyId: row.company_id as string, role: row.role as UserRole });

export class SqlDirectory implements Directory {
  private readonly accounts: Accounts;
  constructor(
    private readonly db: Db,
    keys: DataKeys,
    private readonly audit?: { appendNow(entry: AuditInput): void },
  ) {
    this.accounts = new Accounts(db, 'users', keys);
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.accounts.read(this.accounts.byEmail(email));
  }
  async getUser(id: string): Promise<UserRecord | null> {
    return this.accounts.read(this.accounts.byId(id));
  }
  async saveUser(user: UserRecord): Promise<void> {
    this.accounts.write(user);
  }
  async updateUser(id: string, change: (user: UserRecord) => UserRecord | null): Promise<UserRecord | null> {
    // Read, decide and write under one write lock.
    return this.db.tx(() => {
      const current = this.accounts.read(this.accounts.byId(id));
      const next = current ? change(current) : null;
      if (!next) return null;
      this.accounts.write(next);
      return next;
    });
  }
  async listUsers(): Promise<UserRecord[]> {
    return this.accounts.all().map((row) => this.accounts.read(row) as UserRecord);
  }
  async getCompany(id: string): Promise<CompanyRecord | null> {
    return company(this.db.get<CompanyRow>('SELECT * FROM companies WHERE id = ?', id));
  }
  async membershipsOf(userId: string): Promise<Membership[]> {
    return this.db.all('SELECT * FROM memberships WHERE user_id = ? ORDER BY rowid', userId).map(membership);
  }
  async listCompanies(): Promise<CompanyRecord[]> {
    return this.db.all<CompanyRow>('SELECT * FROM companies ORDER BY rowid').map((row) => company(row) as CompanyRecord);
  }
  /** A company's fields as columns, for comparing and writing. */
  private columnsOf(record: CompanyRecord): Record<string, string | number | null> {
    return {
      name: record.name,
      name_key: nameKey(record.name),
      provider_key: record.providerKey,
      provider_account_id: record.providerAccountId,
      provider_contact_id: record.providerContactId,
      deactivated_at: record.deactivatedAt ?? null,
      previous_name: record.previousName ?? null,
      renamed_at: record.renamedAt ?? null,
      approvals_required: approvalsRequiredOf(record),
    };
  }
  /** The database's own refusal of a second company with the same name or account, as an error the console can show. */
  private guarded<T>(write: () => T): T {
    try {
      return write();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/UNIQUE constraint failed: companies\.name_key/.test(message)) throw new StoreConflict('company_name');
      if (/UNIQUE constraint failed: companies\.provider_key, companies\.provider_account_id/.test(message)) throw new StoreConflict('company_account');
      throw error;
    }
  }
  async saveCompany(record: CompanyRecord): Promise<void> {
    const columns = this.columnsOf(record);
    const names = Object.keys(columns);
    // INSERT only: an existing company is changed with updateCompany, never by writing back a copy read earlier.
    this.guarded(() => this.db.run(`INSERT INTO companies (id, ${names.join(', ')}) VALUES (?, ${names.map(() => '?').join(', ')})`, record.id, ...Object.values(columns)));
  }
  async updateCompany(id: string, change: (company: CompanyRecord) => CompanyRecord | null, audit?: AuditWith<CompanyRecord>): Promise<CompanyRecord | null> {
    return this.db.tx(() => {
      const current = company(this.db.get<CompanyRow>('SELECT * FROM companies WHERE id = ?', id));
      const next = current ? change(structuredClone(current)) : null;
      if (!current || !next) return null;
      const before = this.columnsOf(current);
      const after = this.columnsOf(next);
      // Only what differs is written.
      const changed = Object.keys(after).filter((name) => after[name] !== before[name]);
      if (changed.length > 0) this.guarded(() => this.db.run(`UPDATE companies SET ${changed.map((name) => `${name} = ?`).join(', ')} WHERE id = ?`, ...changed.map((name) => after[name] as string | number | null), id));
      const stored = company(this.db.get<CompanyRow>('SELECT * FROM companies WHERE id = ?', id)) as CompanyRecord;
      writeAudit(this.audit, audit, stored);
      return stored;
    });
  }
  /** Fills in the compared form of each company's name (migration 4). Two companies whose names compare equal stop the migration. */
  backfillNameKeys(): void {
    for (const row of this.db.all<{ id: string; name: string }>('SELECT id, name FROM companies')) {
      try {
        this.db.run('UPDATE companies SET name_key = ? WHERE id = ?', nameKey(row.name), row.id);
      } catch {
        throw new Error(`Two companies have the same name (“${row.name}”, ignoring case and spacing). Company names must be different: rename one of them with the previous version before upgrading.`);
      }
    }
  }
  /** For the held-payment store: a person and their role in one company, read inside the caller's transaction. */
  personIn(userId: string, companyId: string): { user: UserRecord; role: UserRole | null } | null {
    const user = this.accounts.read(this.accounts.byId(userId));
    if (!user) return null;
    const row = this.db.get<{ role: string }>('SELECT role FROM memberships WHERE user_id = ? AND company_id = ?', userId, companyId);
    return { user, role: (row?.role as UserRole | undefined) ?? null };
  }
  /** For the held-payment store: the company as it is now, read inside the caller's transaction. */
  companyNow(id: string): CompanyRecord | null {
    return company(this.db.get<CompanyRow>('SELECT * FROM companies WHERE id = ?', id));
  }
  async listMembers(companyId: string): Promise<CompanyMember[]> {
    // Names, roles and whether the person can act. No credential column is read.
    return this.db
      .all<{ id: string; name: string; email: string; role: string; activated_at: number | null; disabled_at: number | null }>(
        'SELECT u.id, u.name, u.email, m.role, u.activated_at, u.disabled_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? ORDER BY m.rowid',
        companyId,
      )
      .map((row) => ({ userId: row.id, name: row.name, email: row.email, role: row.role as UserRole, active: row.activated_at !== null && row.disabled_at === null }));
  }
  async listMemberships(): Promise<Membership[]> {
    return this.db.all('SELECT * FROM memberships ORDER BY rowid').map(membership);
  }
  async setMembership(record: Membership): Promise<void> {
    this.db.run('INSERT INTO memberships (user_id, company_id, role) VALUES (?, ?, ?) ON CONFLICT (user_id, company_id) DO UPDATE SET role = excluded.role', record.userId, record.companyId, record.role);
  }
  async removeMembership(userId: string, companyId: string): Promise<void> {
    this.db.run('DELETE FROM memberships WHERE user_id = ? AND company_id = ?', userId, companyId);
  }
  rotateKeys(): number {
    return this.accounts.rotate();
  }
}

export class SqlOpsDirectory implements OpsDirectory {
  private readonly accounts: Accounts;
  constructor(
    private readonly db: Db,
    keys: DataKeys,
  ) {
    this.accounts = new Accounts(db, 'ops_users', keys);
  }
  private read(row: AccountRow | undefined): OpsUserRecord | null {
    const account = this.accounts.read(row);
    // (Added to the account object itself: copying it would read, and so decrypt, the authenticator key.)
    return account && row ? Object.assign(account, { role: row.role as OpsRole, disabledAt: account.disabledAt ?? null, lastSignInAt: account.lastSignInAt ?? null }) : null;
  }
  async findByEmail(email: string): Promise<OpsUserRecord | null> {
    return this.read(this.accounts.byEmail(email));
  }
  async get(id: string): Promise<OpsUserRecord | null> {
    return this.read(this.accounts.byId(id));
  }
  async save(user: OpsUserRecord): Promise<void> {
    this.accounts.write(user, user.role);
  }
  async update(id: string, change: (user: OpsUserRecord) => OpsUserRecord | null): Promise<OpsUserRecord | null> {
    return this.db.tx(() => {
      const current = this.read(this.accounts.byId(id));
      const next = current ? change(current) : null;
      if (!next) return null;
      this.accounts.write(next, next.role);
      return next;
    });
  }
  async list(): Promise<OpsUserRecord[]> {
    return this.accounts.all().map((row) => this.read(row) as OpsUserRecord);
  }
  rotateKeys(): number {
    return this.accounts.rotate();
  }
}
