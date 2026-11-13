/** Held payments over SQLite: one JSON document per payment, every change inside one write-locked transaction. */
import { createHash } from 'node:crypto';

import type { HeldPaymentRecord, HeldPaymentStatus, HeldPaymentStore } from '../types';
import type { Db } from './db';
import type { SqlDirectory } from './directory';

const read = (row: { data: string } | undefined): HeldPaymentRecord | null => (row ? (JSON.parse(row.data) as HeldPaymentRecord) : null);

export class SqlHeldPayments implements HeldPaymentStore {
  constructor(
    private readonly db: Db,
    private readonly directory: SqlDirectory,
  ) {}

  /** The row key: the company and the creator's idempotency key. The primary key makes a second row with it impossible. */
  private keyOf(companyId: string, idempotencyKey: string): string {
    return createHash('sha256').update(JSON.stringify([companyId, idempotencyKey])).digest('hex');
  }

  async create(record: HeldPaymentRecord): Promise<{ record: HeldPaymentRecord; created: boolean }> {
    const key = this.keyOf(record.companyId, record.idempotencyKey);
    return this.db.tx(() => {
      const existing = read(this.db.get<{ data: string }>('SELECT data FROM held_payments WHERE key = ?', key));
      if (existing) return { record: existing, created: false };
      this.db.run('INSERT INTO held_payments (key, data) VALUES (?, ?)', key, JSON.stringify(record));
      return { record, created: true };
    });
  }
  async get(id: string): Promise<HeldPaymentRecord | null> {
    return read(this.db.get<{ data: string }>("SELECT data FROM held_payments WHERE json_extract(data, '$.id') = ?", id));
  }
  async findByKey(companyId: string, idempotencyKey: string): Promise<HeldPaymentRecord | null> {
    return read(this.db.get<{ data: string }>('SELECT data FROM held_payments WHERE key = ?', this.keyOf(companyId, idempotencyKey)));
  }
  async list(where: { companyId?: string; status?: HeldPaymentStatus }): Promise<HeldPaymentRecord[]> {
    const conditions: string[] = [];
    const params: string[] = [];
    if (where.companyId !== undefined) (conditions.push("json_extract(data, '$.companyId') = ?"), params.push(where.companyId));
    if (where.status !== undefined) (conditions.push("json_extract(data, '$.status') = ?"), params.push(where.status));
    return this.db
      .all<{ data: string }>(`SELECT data FROM held_payments${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY rowid DESC`, ...params)
      .map((row) => read(row) as HeldPaymentRecord);
  }
  async update(id: string, userIds: string[], change: Parameters<HeldPaymentStore['update']>[2]): Promise<HeldPaymentRecord | null> {
    // The payment, the people and their roles are read under the write lock and the new state is written before it is released.
    return this.db.tx(() => {
      const current = read(this.db.get<{ data: string }>("SELECT data FROM held_payments WHERE json_extract(data, '$.id') = ?", id));
      if (!current) return null;
      const people = new Map(userIds.map((userId) => [userId, this.directory.personIn(userId, current.companyId)]));
      const next = change(structuredClone(current), { get: (userId) => people.get(userId) ?? null });
      if (!next) return null;
      this.db.run("UPDATE held_payments SET data = ? WHERE json_extract(data, '$.id') = ?", JSON.stringify(next), id);
      return next;
    });
  }
}
