/** Held payments over SQLite: one JSON document per payment, every change inside one write-locked transaction. */
import { createHash } from 'node:crypto';

import type { AuditInput, AuditWith, DirectPaymentRecord, HeldPaymentRecord, HeldPaymentStatus, HeldPaymentStore } from '../types';
import type { Db } from './db';
import type { SqlDirectory } from './directory';
import { writeAudit } from './tables';

const read = (row: { data: string } | undefined): HeldPaymentRecord | null => (row ? (JSON.parse(row.data) as HeldPaymentRecord) : null);

export class SqlHeldPayments implements HeldPaymentStore {
  constructor(
    private readonly db: Db,
    private readonly directory: SqlDirectory,
    private readonly audit: { appendNow(entry: AuditInput): void },
  ) {}

  /** The row key: the company and the creator's idempotency key. The primary key makes a second row with it impossible. */
  private keyOf(companyId: string, idempotencyKey: string): string {
    return createHash('sha256').update(JSON.stringify([companyId, idempotencyKey])).digest('hex');
  }

  private direct(key: string): DirectPaymentRecord | null {
    const row = this.db.get<{ data: string }>('SELECT data FROM direct_payments WHERE key = ?', key);
    return row ? (JSON.parse(row.data) as DirectPaymentRecord) : null;
  }
  async create(record: HeldPaymentRecord, audit?: AuditWith<HeldPaymentRecord>): Promise<{ record: HeldPaymentRecord; created: boolean } | { direct: DirectPaymentRecord }> {
    const key = this.keyOf(record.companyId, record.idempotencyKey);
    return this.db.tx(() => {
      const existing = read(this.db.get<{ data: string }>('SELECT data FROM held_payments WHERE key = ?', key));
      if (existing) return { record: existing, created: false };
      // The key was used for a payment sent straight to the provider: it can never also become a held one.
      const direct = this.direct(key);
      if (direct) return { direct };
      this.db.run('INSERT INTO held_payments (key, data) VALUES (?, ?)', key, JSON.stringify(record));
      writeAudit(this.audit, audit, record);
      return { record, created: true };
    });
  }
  async claimDirect(record: DirectPaymentRecord): Promise<{ held: HeldPaymentRecord } | { direct: DirectPaymentRecord; created: boolean }> {
    const key = this.keyOf(record.companyId, record.idempotencyKey);
    return this.db.tx(() => {
      const held = read(this.db.get<{ data: string }>('SELECT data FROM held_payments WHERE key = ?', key));
      if (held) return { held };
      const existing = this.direct(key);
      if (existing) return { direct: existing, created: false };
      this.db.run('INSERT INTO direct_payments (key, data) VALUES (?, ?)', key, JSON.stringify(record));
      return { direct: record, created: true };
    });
  }
  async getDirect(companyId: string, idempotencyKey: string): Promise<DirectPaymentRecord | null> {
    return this.direct(this.keyOf(companyId, idempotencyKey));
  }
  async updateDirect(companyId: string, idempotencyKey: string, change: (current: DirectPaymentRecord) => DirectPaymentRecord | null): Promise<DirectPaymentRecord | null> {
    const key = this.keyOf(companyId, idempotencyKey);
    return this.db.tx(() => {
      const current = this.direct(key);
      const next = current ? change(structuredClone(current)) : null;
      if (!next) return null;
      this.db.run('UPDATE direct_payments SET data = ? WHERE key = ?', JSON.stringify(next), key);
      return next;
    });
  }
  async get(id: string): Promise<HeldPaymentRecord | null> {
    return read(this.db.get<{ data: string }>("SELECT data FROM held_payments WHERE json_extract(data, '$.id') = ?", id));
  }
  async findByKey(companyId: string, idempotencyKey: string): Promise<HeldPaymentRecord | null> {
    return read(this.db.get<{ data: string }>('SELECT data FROM held_payments WHERE key = ?', this.keyOf(companyId, idempotencyKey)));
  }
  async list(where: { companyId?: string; status?: HeldPaymentStatus; changedSince?: number }): Promise<HeldPaymentRecord[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    // (An index on when the status last changed: "what is recent" is read without reading everything.)
    if (where.changedSince !== undefined) (conditions.push("json_extract(data, '$.statusAt') >= ?"), params.push(where.changedSince));
    if (where.companyId !== undefined) (conditions.push("json_extract(data, '$.companyId') = ?"), params.push(where.companyId));
    if (where.status !== undefined) (conditions.push("json_extract(data, '$.status') = ?"), params.push(where.status));
    return this.db
      .all<{ data: string }>(`SELECT data FROM held_payments${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY rowid DESC`, ...params)
      .map((row) => read(row) as HeldPaymentRecord);
  }
  async update(id: string, userIds: string[] | ((current: HeldPaymentRecord) => string[]), change: Parameters<HeldPaymentStore['update']>[2], audit?: AuditWith<HeldPaymentRecord>): Promise<HeldPaymentRecord | null> {
    // The payment, its company, the people and their roles are read under the write lock, and the new state and its
    // audit entries are written before the lock is released.
    return this.db.tx(() => {
      const current = read(this.db.get<{ data: string }>("SELECT data FROM held_payments WHERE json_extract(data, '$.id') = ?", id));
      if (!current) return null;
      const ids = typeof userIds === 'function' ? userIds(current) : userIds;
      const people = new Map(ids.map((userId) => [userId, this.directory.personIn(userId, current.companyId)]));
      const next = change(structuredClone(current), { company: this.directory.companyNow(current.companyId), get: (userId) => people.get(userId) ?? null });
      if (!next) return null;
      this.db.run("UPDATE held_payments SET data = ? WHERE json_extract(data, '$.id') = ?", JSON.stringify(next), id);
      writeAudit(this.audit, audit, next);
      return next;
    });
  }
}
