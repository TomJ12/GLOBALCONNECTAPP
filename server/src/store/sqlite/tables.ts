/** A keyed table over SQLite: one JSON document per key, looked up by key or by an indexed field. */
import type { Table, Where } from '../types';
import type { Db } from './db';
import { open, seal, type DataKeys } from './keys';

export interface TableOptions<T> {
  /** Fields with an index (see migrations.ts). Equality on these is done by the database; anything else is filtered here. */
  indexed?: (keyof T & string)[];
  /** A field that holds a secret and is stored encrypted. */
  secret?: { field: keyof T & string; keys: DataKeys };
}

export class SqlTable<T extends object> implements Table<T> {
  private readonly indexed: string[];
  constructor(
    private readonly db: Db,
    private readonly name: string,
    private readonly options: TableOptions<T> = {},
  ) {
    this.indexed = options.indexed ?? [];
  }

  private encode(key: string, value: T): string {
    const { secret } = this.options;
    if (!secret) return JSON.stringify(value);
    const plain = (value as Record<string, unknown>)[secret.field];
    return JSON.stringify({ ...value, [secret.field]: typeof plain === 'string' ? seal(secret.keys, plain, `${this.name}:${key}:${secret.field}`).text : plain });
  }
  private decode(key: string, data: string): T {
    const row = JSON.parse(data) as Record<string, unknown>;
    const { secret } = this.options;
    if (secret && typeof row[secret.field] === 'string') row[secret.field] = open(secret.keys, row[secret.field] as string, `${this.name}:${key}:${secret.field}`);
    return row as T;
  }

  /** Rows matching `where`, narrowed by index where possible. */
  private select(where: Where<T> = {}, filter?: (row: T) => boolean): { key: string; row: T }[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    const rest: [string, unknown][] = [];
    if (typeof where !== 'function') {
      for (const [field, value] of Object.entries(where)) {
        if (this.indexed.includes(field) && (typeof value === 'string' || typeof value === 'number')) {
          conditions.push(`json_extract(data, '$.${field}') = ?`);
          params.push(value);
        } else rest.push([field, value]);
      }
    }
    const rows = this.db.all<{ key: string; data: string }>(`SELECT key, data FROM ${this.name}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY rowid`, ...params);
    return rows
      .map(({ key, data }) => ({ key, row: this.decode(key, data) }))
      .filter(({ row }) => (typeof where === 'function' ? where(row) : rest.every(([field, value]) => (row as Record<string, unknown>)[field] === value)) && (!filter || filter(row)));
  }

  async get(key: string): Promise<T | null> {
    const found = this.db.get<{ data: string }>(`SELECT data FROM ${this.name} WHERE key = ?`, key);
    return found ? this.decode(key, found.data) : null;
  }
  async put(key: string, value: T): Promise<void> {
    this.db.run(`INSERT INTO ${this.name} (key, data) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data`, key, this.encode(key, value));
  }
  async delete(key: string): Promise<void> {
    this.db.run(`DELETE FROM ${this.name} WHERE key = ?`, key);
  }
  async deleteWhere(where: Where<T>, filter?: (row: T) => boolean): Promise<void> {
    this.db.tx(() => {
      for (const { key } of this.select(where, filter)) this.db.run(`DELETE FROM ${this.name} WHERE key = ?`, key);
    });
  }
  async count(where: Where<T>, filter?: (row: T) => boolean): Promise<number> {
    return this.select(where, filter).length;
  }
  async list(where: Where<T> = {}, filter?: (row: T) => boolean): Promise<T[]> {
    return this.select(where, filter).map(({ row }) => row);
  }
  async mutate(key: string, change: (current: T | null) => T | null | undefined): Promise<T | null> {
    // One transaction, holding the write lock from before the read: no other connection can change the row in between.
    return this.db.tx(() => {
      const found = this.db.get<{ data: string }>(`SELECT data FROM ${this.name} WHERE key = ?`, key);
      const current = found ? this.decode(key, found.data) : null;
      const next = change(current === null ? null : structuredClone(current));
      if (next === undefined) return current;
      if (next === null) {
        this.db.run(`DELETE FROM ${this.name} WHERE key = ?`, key);
        return null;
      }
      this.db.run(`INSERT INTO ${this.name} (key, data) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data`, key, this.encode(key, next));
      return next;
    });
  }
  async take(key: string): Promise<T | null> {
    // A single statement: the row is returned to exactly one caller, and gone.
    const taken = this.db.get<{ data: string }>(`DELETE FROM ${this.name} WHERE key = ? RETURNING data`, key);
    return taken ? this.decode(key, taken.data) : null;
  }
}
