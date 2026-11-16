/**
 * The audit log over SQLite.
 *
 * APPEND-ONLY. This file contains no statement that changes an entry, and
 * the only DELETE moves entries that have first been copied, unchanged, to
 * the archive table; database triggers reject everything else.
 *
 * TAMPER-EVIDENT. Each entry stores an HMAC over the previous entry's hash and
 * its own content, keyed from the data encryption key (which is not in the
 * database). Changing, removing or inserting an entry breaks the chain, and
 * `verify` (npm run audit:verify) says where. This detects tampering by
 * someone with the database file; it does not stop someone who also has the
 * key.
 *
 * NOTHING IS DROPPED. When the live table passes its size, the oldest entries
 * are moved to `audit_archive` in the same database. The ops console shows
 * the live table; the archive is read with SQL and is covered by `verify`.
 *
 * Failures by people nobody has identified (a wrong password) are kept apart,
 * in memory only, bounded and rate limited, so they can neither fill nor
 * push anything out of the log proper. They do not survive a restart.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

import { canonicalJson } from '@/api/canonical';

import type { AuditEntry, AuditFilter, AuditInput, AuditLog, AuditParty } from '../types';
import type { Db, Row } from './db';
import { chainHash, type DataKey, type DataKeys } from './keys';
import { AUDIT_TRIGGERS } from './migrations';

export interface AuditOptions {
  /** Entries kept in the live table; beyond this the oldest are moved to the archive. */
  liveLimit?: number;
  /** Told when entries are moved to the archive. */
  notice?: (message: string) => void;
  /** Size of the in-memory ring that holds failures by unidentified actors. */
  anonymousLimit?: number;
  /** Anonymous failures recorded per source address per minute; the rest are counted, not stored. */
  anonymousPerMinute?: number;
}

export interface AuditVerification {
  ok: boolean;
  entries: number;
  archived: number;
  /** The first thing found wrong, in words. */
  problem: string | null;
}

const GENESIS = '0'.repeat(64);

type HeadRow = { seq: number; hash: string; count: number | null; mac: string | null; key_id: string | null };
/** Where the log ended at some moment, signed with the chain key. Kept in a file outside the database. */
export interface AuditCheckpoint {
  seq: number;
  hash: string;
  count: number;
  at: number;
  keyId: string;
  mac: string;
}
const macKey = (key: DataKey, purpose: string): Buffer => Buffer.from(hkdfSync('sha256', key.key, Buffer.alloc(0), purpose, 32));
const headMac = (key: DataKey, seq: number, hash: string, count: number): string => createHmac('sha256', macKey(key, 'gc-audit-head')).update(canonicalJson([seq, hash, count])).digest('hex');
const checkpointMac = (key: DataKey, body: Omit<AuditCheckpoint, 'mac'>): string =>
  createHmac('sha256', macKey(key, 'gc-audit-checkpoint')).update(canonicalJson([body.seq, body.hash, body.count, body.at, body.keyId])).digest('hex');
const safeEqualHex = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const ANONYMOUS_LABEL_LENGTH = 80;
const FIELDS = 'id, at, actor_type, actor_id, actor_label, target_type, target_id, target_label, action, outcome, source, detail, prev_hash, hash, key_id';

type AuditRow = Row & { seq: number; id: string; at: number; actor_type: string; actor_id: string | null; actor_label: string; target_type: string | null; target_id: string | null; target_label: string | null; action: string; outcome: string; source: string; detail: string; prev_hash: string; hash: string; key_id: string };

/** Exactly what is hashed: every field of the entry, in a fixed form. */
const content = (row: Omit<AuditRow, 'seq' | 'prev_hash' | 'hash' | 'key_id'>): string =>
  canonicalJson([row.id, row.at, row.actor_type, row.actor_id, row.actor_label, row.target_type, row.target_id, row.target_label, row.action, row.outcome, row.source, row.detail]);

const entryOf = (row: AuditRow): AuditEntry => ({
  id: row.id,
  at: row.at,
  actor: { type: row.actor_type as AuditParty['type'], id: row.actor_id, label: row.actor_label },
  target: row.target_type === null ? null : { type: row.target_type as AuditParty['type'], id: row.target_id, label: row.target_label ?? '' },
  action: row.action,
  outcome: row.outcome as AuditEntry['outcome'],
  source: row.source,
  detail: JSON.parse(row.detail) as Record<string, string>,
});

export class SqlAuditLog implements AuditLog {
  private anonymous: AuditEntry[] = [];
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  /** Anonymous failures not stored because their source was over its rate. */
  suppressed = 0;
  private readonly liveLimit: number;
  private readonly anonymousLimit: number;
  private readonly anonymousPerMinute: number;
  private readonly notice: (message: string) => void;
  private live: number;

  constructor(
    private readonly db: Db,
    private readonly keys: DataKeys,
    options: AuditOptions = {},
  ) {
    this.liveLimit = options.liveLimit ?? 100_000;
    this.anonymousLimit = options.anonymousLimit ?? 5_000;
    this.anonymousPerMinute = options.anonymousPerMinute ?? 20;
    this.notice = options.notice ?? ((message) => console.error(message));
    this.live = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')?.n ?? 0;
  }

  async append(entry: AuditInput): Promise<void> {
    this.appendNow(entry);
  }

  /**
   * The same, for the store's own use inside a transaction it has open: the
   * entry is written (or not) together with the state change it records.
   */
  appendNow(entry: AuditInput): void {
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
      return;
    }
    const row = {
      id,
      at: entry.at,
      actor_type: entry.actor.type,
      actor_id: entry.actor.id,
      actor_label: entry.actor.label,
      target_type: entry.target?.type ?? null,
      target_id: entry.target?.id ?? null,
      target_label: entry.target?.label ?? null,
      action: entry.action,
      outcome: entry.outcome,
      source: entry.source,
      detail: JSON.stringify(entry.detail),
    };
    // The end of the chain is read and moved on under the write lock, so two writers cannot both extend the same entry.
    this.db.tx(() => {
      const head = this.head();
      const previous = head?.hash ?? GENESIS;
      const hash = chainHash(this.keys.current, previous, content(row));
      this.db.run(
        `INSERT INTO audit_log (${FIELDS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.at, row.actor_type, row.actor_id, row.actor_label, row.target_type, row.target_id, row.target_label, row.action, row.outcome, row.source, row.detail, previous, hash, this.keys.current.id,
      );
      const seq = this.db.get<{ seq: number }>('SELECT seq FROM audit_log WHERE id = ?', row.id)?.seq ?? 0;
      // The count only ever goes up by one from a head this server could verify; a head it could not is left to be found by `verify`.
      this.writeHead(seq, hash, head && this.headProblem(head) === null ? (head.count ?? 0) + 1 : null);
    });
    this.live += 1;
    if (this.live > this.liveLimit) this.archive(entry.at);
  }

  // --- The signed end of the log -------------------------------------------------------------------

  private head(): HeadRow | undefined {
    return this.db.get<HeadRow>('SELECT seq, hash, count, mac, key_id FROM audit_head WHERE id = 1');
  }
  private writeHead(seq: number, hash: string, count: number | null): void {
    const mac = count === null ? null : headMac(this.keys.current, seq, hash, count);
    this.db.run(
      'INSERT INTO audit_head (id, seq, hash, count, mac, key_id) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, count = excluded.count, mac = excluded.mac, key_id = excluded.key_id',
      seq, hash, count, mac, mac === null ? null : this.keys.current.id,
    );
  }
  /** What is wrong with the record of the end of the log, or null. Only the holder of the key can write one that passes. */
  private headProblem(head: HeadRow | undefined): string | null {
    if (!head) return 'The signed record of the end of the log is missing.';
    if (head.count === null || head.mac === null) return 'The record of the end of the log is not signed.';
    const key = this.keys.all.find((item) => item.id === head.key_id);
    if (!key) return `The record of the end of the log was signed with a key this server was not given (key id ${head.key_id}).`;
    if (!safeEqualHex(headMac(key, head.seq, head.hash, head.count), head.mac)) return 'The record of the end of the log has been altered: its signature does not match.';
    return null;
  }
  /**
   * Signs the end of the log as it stands. Called ONLY in the transaction
   * that creates the schema or that upgrades a database from before the end
   * was signed; never to "repair" a head that fails its check.
   */
  sealHead(): void {
    const last = this.db.get<{ seq: number; hash: string }>('SELECT seq, hash FROM (SELECT seq, hash FROM audit_log UNION ALL SELECT seq, hash FROM audit_archive) ORDER BY seq DESC LIMIT 1');
    const count = this.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM audit_log) + (SELECT COUNT(*) FROM audit_archive) AS n')?.n ?? 0;
    this.writeHead(last?.seq ?? 0, last?.hash ?? GENESIS, count);
  }

  /** After a key rotation: the end of the log, if it verifies under an older key, is signed again with the current one. */
  resignHead(): void {
    const head = this.head();
    if (head && this.headProblem(head) === null && head.key_id !== this.keys.current.id) this.writeHead(head.seq, head.hash, head.count);
  }

  /** A signed statement of where the log ended, to keep OUTSIDE the database (npm run audit:checkpoint). */
  checkpoint(at: number): AuditCheckpoint {
    const head = this.head();
    const problem = this.headProblem(head);
    if (problem || !head) throw new Error(`No checkpoint was made: ${problem ?? 'the end of the log is missing'} Run audit:verify.`);
    const body = { seq: head.seq, hash: head.hash, count: head.count as number, at, keyId: this.keys.current.id };
    return { ...body, mac: checkpointMac(this.keys.current, body) };
  }

  /** Moves the older half of the live table to the archive, in one transaction. */
  private archive(at: number): void {
    const moved = this.db.tx(() => {
      const live = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')?.n ?? 0;
      const excess = live - Math.floor(this.liveLimit / 2);
      if (live <= this.liveLimit || excess <= 0) return 0;
      const upTo = this.db.get<{ seq: number }>('SELECT seq FROM audit_log ORDER BY seq LIMIT 1 OFFSET ?', excess - 1)?.seq;
      if (upTo === undefined) return 0;
      this.db.run(`INSERT INTO audit_archive (seq, ${FIELDS}, archived_at) SELECT seq, ${FIELDS}, ? FROM audit_log WHERE seq <= ?`, at, upTo);
      // Permitted by the trigger only because each of these rows is now, unchanged, in the archive.
      return this.db.run('DELETE FROM audit_log WHERE seq <= ?', upTo);
    });
    this.live = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')?.n ?? 0;
    if (moved > 0) this.notice(`Audit log: ${moved} older entries were moved to the archive table (audit_archive) in the same database. Nothing was removed; recording continues. The ops console shows the ${this.live} newest.`);
  }

  async query(filter: AuditFilter = {}): Promise<AuditEntry[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    const like = (value: string) => `%${value.trim().toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    if (filter.from !== undefined) (conditions.push('at >= ?'), params.push(filter.from));
    if (filter.to !== undefined) (conditions.push('at <= ?'), params.push(filter.to));
    if (filter.action) (conditions.push("action LIKE ? ESCAPE '\\'"), params.push(like(filter.action)));
    if (filter.actor) (conditions.push("lower(actor_label || ' ' || coalesce(actor_id, '')) LIKE ? ESCAPE '\\'"), params.push(like(filter.actor)));
    if (filter.target) (conditions.push("target_type IS NOT NULL AND lower(coalesce(target_label, '') || ' ' || coalesce(target_id, '')) LIKE ? ESCAPE '\\'"), params.push(like(filter.target)));
    const limit = filter.limit ?? 500;
    const rows = this.db.all<AuditRow>(`SELECT * FROM audit_log${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`, ...params, limit);
    const has = (party: AuditParty | null, wanted: string | undefined) => !wanted || (party !== null && `${party.label} ${party.id ?? ''}`.toLowerCase().includes(wanted.trim().toLowerCase()));
    const unidentified = this.anonymous.filter(
      (entry) =>
        (filter.from === undefined || entry.at >= filter.from) &&
        (filter.to === undefined || entry.at <= filter.to) &&
        (!filter.action || entry.action.includes(filter.action.trim().toLowerCase())) &&
        has(entry.actor, filter.actor) &&
        has(entry.target, filter.target),
    );
    // Newest first; for the same moment, later-written first.
    const merged = [...rows.map((row, index) => ({ entry: entryOf(row), order: rows.length - index })), ...unidentified.map((entry, index) => ({ entry: structuredClone(entry), order: rows.length + 1 + index }))];
    return merged.sort((a, b) => b.entry.at - a.entry.at || b.order - a.order).slice(0, limit).map((item) => item.entry);
  }

  /**
   * Walks the whole chain, archive first, and checks every link; that the
   * signed record of the end matches the last entry and the number of
   * entries; that the append-only triggers are in place and unaltered; and,
   * given a checkpoint from outside the database, that the log still
   * contains everything it contained then.
   */
  verify(checkpoint?: AuditCheckpoint): AuditVerification {
    const archived = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_archive')?.n ?? 0;
    let previous = GENESIS;
    let expectedSeq: number | null = null;
    let count = 0;
    let last: AuditRow | null = null;
    let atCheckpoint: { hash: string; count: number } | null = null;
    const fail = (problem: string): AuditVerification => ({ ok: false, entries: count, archived, problem });
    for (const table of ['audit_archive', 'audit_log']) {
      for (const row of this.db.all<AuditRow>(`SELECT * FROM ${table} ORDER BY seq`)) {
        const key = this.keys.all.find((item) => item.id === row.key_id);
        if (!key) return fail(`Entry ${row.seq} (${row.id}) was signed with a key this server was not given (key id ${row.key_id}). Set DATA_ENCRYPTION_KEY_PREVIOUS to verify it.`);
        if (expectedSeq !== null && row.seq !== expectedSeq) return fail(`Entry ${expectedSeq} is missing (found ${row.seq} after ${expectedSeq - 1}).`);
        if (row.prev_hash !== previous) return fail(`Entry ${row.seq} (${row.id}) does not follow the entry before it: one was removed, inserted or reordered.`);
        if (chainHash(key, previous, content(row)) !== row.hash) return fail(`Entry ${row.seq} (${row.id}, ${row.action}) has been changed since it was written.`);
        previous = row.hash;
        expectedSeq = row.seq + 1;
        count += 1;
        last = row;
        if (checkpoint && row.seq === checkpoint.seq) atCheckpoint = { hash: row.hash, count };
      }
    }
    // The end of the log. Its record carries a signature only the key holder can make, over the last entry AND the count.
    const head = this.head();
    const headProblem = this.headProblem(head);
    if (headProblem) return fail(`${headProblem} Entries may have been removed from the end of the log.`);
    const signed = head as HeadRow;
    if ((last?.seq ?? 0) !== signed.seq || (last?.hash ?? GENESIS) !== signed.hash) return fail(`The log ends at entry ${last?.seq ?? 'none'}, but entry ${signed.seq} was the last one written: the newest entries have been removed.`);
    if (signed.count !== count) return fail(`The log holds ${count} entries but ${signed.count} were written: entries have been removed.`);
    // The triggers that refuse UPDATE and DELETE must be there, exactly as this code creates them.
    for (const [name, expected] of Object.entries(AUDIT_TRIGGERS)) {
      const found = this.db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?", name)?.sql;
      if (!found) return fail(`The trigger ${name}, which stops audit entries being changed or removed, is missing from the database.`);
      if (squash(found) !== squash(expected)) return fail(`The trigger ${name}, which stops audit entries being changed or removed, has been altered.`);
    }
    if (checkpoint) {
      const key = this.keys.all.find((item) => item.id === checkpoint.keyId);
      if (!key) return fail(`The checkpoint was signed with a key this server was not given (key id ${checkpoint.keyId}).`);
      const { mac, ...body } = checkpoint;
      if (typeof mac !== 'string' || !safeEqualHex(checkpointMac(key, body), mac)) return fail('The checkpoint file is not one this server made, or it has been altered.');
      if (checkpoint.count === 0 ? false : !atCheckpoint || atCheckpoint.hash !== checkpoint.hash || atCheckpoint.count !== checkpoint.count) {
        return fail(`The log no longer contains what it contained at the checkpoint of ${new Date(checkpoint.at).toISOString()} (entry ${checkpoint.seq}, ${checkpoint.count} entries): it has been cut back or replaced by an older copy.`);
      }
    }
    return { ok: true, entries: count, archived, problem: null };
  }
}
