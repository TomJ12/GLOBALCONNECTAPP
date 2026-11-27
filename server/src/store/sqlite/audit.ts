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

type HeadRow = { seq: number; hash: string; count: number | null; mac: string | null; key_id: string | null; archived_through?: number | null };
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
/** The end of the log AND how far the archive reaches. (`legacyHeadMac`: as schema 4 signed it, without the archive boundary.) */
const headMac = (key: DataKey, seq: number, hash: string, count: number, archivedThrough: number): string =>
  createHmac('sha256', macKey(key, 'gc-audit-head-2')).update(canonicalJson([seq, hash, count, archivedThrough])).digest('hex');
export const legacyHeadMac = (key: DataKey, seq: number, hash: string, count: number): string => createHmac('sha256', macKey(key, 'gc-audit-head')).update(canonicalJson([seq, hash, count])).digest('hex');
/** The audit log would not take an entry. Whatever was to be recorded is refused. */
export class AuditUnavailable extends Error {
  constructor(problem: string) {
    super(`The audit log cannot be written to, so the action was refused and nothing was recorded. ${problem} Run "npm run audit:verify"; see "Audit log" in the README.`);
  }
}
const GUARDED_TABLES = ['audit_log', 'audit_archive', 'audit_head', 'meta', 'schema_version'];
let expectedStructure: Map<string, string> | null = null;
const checkpointMac = (key: DataKey, body: Omit<AuditCheckpoint, 'mac'>): string =>
  createHmac('sha256', macKey(key, 'gc-audit-checkpoint')).update(canonicalJson([body.seq, body.hash, body.count, body.at, body.keyId])).digest('hex');
const safeEqualHex = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const ANONYMOUS_LABEL_LENGTH = 80;
const FIELDS = 'id, at, actor_type, actor_id, actor_label, target_type, target_id, target_label, action, outcome, source, detail, prev_hash, hash, key_id';
/** Live and archived entries as one table. */
const EVERY_ENTRY = `SELECT seq, ${FIELDS} FROM audit_archive UNION ALL SELECT seq, ${FIELDS} FROM audit_log`;

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
      // FAIL CLOSED. An entry is only ever added to a log whose end this server can vouch for, and only if the
      // database then really holds it: otherwise the action that was to be recorded is refused.
      const head = this.head();
      const problem = this.headProblem(head);
      if (problem || !head) throw new AuditUnavailable(problem ?? 'The signed record of the end of the log is missing.');
      const hash = chainHash(this.keys.current, head.hash, content(row));
      const inserted = this.db.run(
        `INSERT INTO audit_log (${FIELDS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.at, row.actor_type, row.actor_id, row.actor_label, row.target_type, row.target_id, row.target_label, row.action, row.outcome, row.source, row.detail, head.hash, hash, this.keys.current.id,
      );
      const stored = this.db.get<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_log WHERE id = ?', row.id);
      // (A trigger someone added can make an INSERT do nothing, or something else, without an error.)
      if (inserted !== 1 || !stored || stored.seq !== head.seq + 1 || stored.hash !== hash) throw new AuditUnavailable('The database did not store the entry as it was written (exactly one new entry, next in sequence, was expected).');
      this.writeHead(stored.seq, hash, (head.count as number) + 1, head.archived_through ?? 0);
      const moved = this.head();
      if (!moved || moved.seq !== stored.seq || moved.hash !== hash || moved.count !== (head.count as number) + 1 || this.headProblem(moved)) throw new AuditUnavailable('The database did not store the new end of the log as it was written.');
    });
    this.live += 1;
    if (this.live > this.liveLimit) this.archive(entry.at);
  }

  // --- The signed end of the log -------------------------------------------------------------------

  private head(): HeadRow | undefined {
    return this.db.get<HeadRow>('SELECT seq, hash, count, mac, key_id, archived_through FROM audit_head WHERE id = 1');
  }
  private writeHead(seq: number, hash: string, count: number, archivedThrough: number): void {
    const changed = this.db.run(
      'INSERT INTO audit_head (id, seq, hash, count, mac, key_id, archived_through) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, count = excluded.count, mac = excluded.mac, key_id = excluded.key_id, archived_through = excluded.archived_through',
      seq, hash, count, headMac(this.keys.current, seq, hash, count, archivedThrough), this.keys.current.id, archivedThrough,
    );
    if (changed !== 1) throw new AuditUnavailable('The database did not store the new end of the log.');
  }
  /** What is wrong with the record of the end of the log, or null. Only the holder of the key can write one that passes. */
  private headProblem(head: HeadRow | undefined): string | null {
    if (!head) return 'The signed record of the end of the log is missing.';
    if (head.count === null || head.mac === null) return 'The record of the end of the log is not signed.';
    const key = this.keys.all.find((item) => item.id === head.key_id);
    if (!key) return `The record of the end of the log was signed with a key this server was not given (key id ${head.key_id}).`;
    if (!safeEqualHex(headMac(key, head.seq, head.hash, head.count, head.archived_through ?? 0), head.mac)) return 'The record of the end of the log has been altered: its signature does not match.';
    return null;
  }
  /** As the previous version of this server signed it (schema 4: no archive boundary). Used once, to carry that signature over. */
  legacyHeadVerifies(): boolean {
    const head = this.db.get<HeadRow>('SELECT seq, hash, count, mac, key_id FROM audit_head WHERE id = 1');
    if (!head || head.count === null || head.mac === null) return false;
    const key = this.keys.all.find((item) => item.id === head.key_id);
    return !!key && safeEqualHex(legacyHeadMac(key, head.seq, head.hash, head.count), head.mac);
  }
  /** Schema 4 to 5: the end that version signed is kept as it is, now signed together with how far the archive reaches. */
  carryLegacyHead(): void {
    const head = this.db.get<HeadRow>('SELECT seq, hash, count, mac, key_id FROM audit_head WHERE id = 1');
    if (!head || !this.legacyHeadVerifies()) throw new Error('The end of the audit log does not verify.');
    this.writeHead(head.seq, head.hash, head.count as number, this.ends().archivedThrough);
  }
  /** The last entry, how many there are, and how far the archive reaches, as the tables stand. */
  private ends(): { seq: number; hash: string; count: number; archivedThrough: number } {
    const last = this.db.get<{ seq: number; hash: string }>(`SELECT seq, hash FROM (${EVERY_ENTRY}) ORDER BY seq DESC LIMIT 1`);
    const count = this.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM audit_log) + (SELECT COUNT(*) FROM audit_archive) AS n')?.n ?? 0;
    const archivedThrough = this.db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM audit_archive')?.seq ?? 0;
    return { seq: last?.seq ?? 0, hash: last?.hash ?? GENESIS, count, archivedThrough };
  }
  /** True when the log holds no entry at all. */
  isEmpty(): boolean {
    return this.ends().count === 0;
  }
  /** A short name for where the log ends now: what an operator quotes to accept an unsigned log as it stands. */
  endLabel(): string {
    const { count, hash } = this.ends();
    return count === 0 ? 'empty' : hash.slice(0, 16);
  }
  /**
   * Signs the end of the log as it stands. Called ONLY by the store when it
   * creates a database, when it carries over a signature it has just
   * verified, or when the key holder has explicitly accepted the log as it
   * stands (`reseal`). Never to "repair" a head that fails its check.
   */
  sealHead(): void {
    const { seq, hash, count, archivedThrough } = this.ends();
    this.writeHead(seq, hash, count, archivedThrough);
  }
  /**
   * THE KEY HOLDER'S DECISION, never the server's own: accepts the log as it
   * stands although the record of its end is missing or does not verify (it
   * was written by a version that did not sign it, or a key rotation went
   * wrong), signs that end, and records in the log itself that this was
   * done. Refuses if any entry that is there has been changed: only the END
   * can be accepted, never altered entries.
   */
  reseal(at: number, reason: string): void {
    this.db.tx(() => {
      const chain = this.walk();
      if (chain.problem) throw new Error(`The log cannot be accepted as it stands: ${chain.problem}`);
      const structure = this.structureProblem();
      if (structure) throw new Error(`The log cannot be accepted as it stands: ${structure}`);
      const before = this.head();
      this.sealHead();
      this.appendNow({ at, actor: { type: 'system', id: null, label: 'audit log' }, target: null, action: 'system.audit.resealed', outcome: 'success', source: '', detail: { reason, entries: String(chain.count), endedAtEntry: String(chain.last?.seq ?? 0), recordedEnd: before?.mac ? `entry ${before.seq}, ${String(before.count)} entries (signature not valid)` : before ? `entry ${before.seq} (unsigned)` : 'none' } });
    });
  }

  /** After a key rotation: the end of the log, if it verifies under an older key, is signed again with the current one. */
  resignHead(): void {
    const head = this.head();
    if (head && this.headProblem(head) === null && head.key_id !== this.keys.current.id) this.writeHead(head.seq, head.hash, head.count as number, head.archived_through ?? 0);
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
      const head = this.head();
      if (!head || this.headProblem(head)) return 0;
      this.db.run(`INSERT INTO audit_archive (seq, ${FIELDS}, archived_at) SELECT seq, ${FIELDS}, ? FROM audit_log WHERE seq <= ?`, at, upTo);
      // Permitted by the trigger only because each of these rows is now, unchanged, in the archive.
      const count = this.db.run('DELETE FROM audit_log WHERE seq <= ?', upTo);
      // How far the archive reaches is part of the signed record: entries moved there by anyone else show up as a mismatch.
      this.writeHead(head.seq, head.hash, head.count as number, upTo);
      return count;
    });
    this.live = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')?.n ?? 0;
    if (moved > 0) this.notice(`Audit log: ${moved} older entries were moved to the archive table (audit_archive) in the same database. Nothing was removed; recording continues. The ops console shows both.`);
  }

  /** How many entries are in the live table and in the archive. */
  counts(): { live: number; archived: number } {
    return { live: this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')?.n ?? 0, archived: this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_archive')?.n ?? 0 };
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
    // Live and archived entries are ONE log: an entry does not leave the console's view by being in the archive.
    const rows = this.db.all<AuditRow>(`SELECT * FROM (${EVERY_ENTRY})${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`, ...params, limit);
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
   * Everything in the database that could change what the audit tables do,
   * compared with what this code creates: the audit tables, the meta and
   * schema tables, their indexes, and EVERY trigger and view in the database
   * (there are four triggers and no views; one more of either is a failure,
   * wherever it is attached).
   */
  structureProblem(): string | null {
    const picture = (db: Db): Map<string, string> =>
      new Map<string, string>(
        db
          .all<{ type: string; name: string; tbl_name: string; sql: string | null }>(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') OR tbl_name IN (${GUARDED_TABLES.map((name) => `'${name}'`).join(', ')}) OR name IN (${GUARDED_TABLES.map((name) => `'${name}'`).join(', ')})`)
          .map((row): [string, string] => [`${row.type} ${row.name}`, `${row.tbl_name} ${squash(row.sql ?? '')}`]),
      );
    if (!expectedStructure) {
      const blank = this.db.blank();
      expectedStructure = picture(blank);
      blank.close();
    }
    const found = picture(this.db);
    for (const [name, sql] of expectedStructure) {
      if (!found.has(name)) return `The ${name}, which is part of how the audit log is protected, is missing from the database.`;
      if (found.get(name) !== sql) return `The ${name}, which is part of how the audit log is protected, has been altered.`;
    }
    for (const name of found.keys()) if (!expectedStructure.has(name)) return `The database contains a ${name} that this server did not create. Anything added to the audit tables (a trigger, a view, an index) can hide or drop entries.`;
    return null;
  }

  /** What must hold before the server writes to this log: its structure, the signed end, and the archive boundary. Cheap; no walk of the chain. */
  startProblem(): string | null {
    const structure = this.structureProblem();
    if (structure) return structure;
    const head = this.head();
    const problem = this.headProblem(head);
    if (problem || !head) return `${problem ?? 'The signed record of the end of the log is missing.'} Entries may have been removed from the end of the log.`;
    const ends = this.ends();
    if (ends.seq !== head.seq || ends.hash !== head.hash) return `The log ends at entry ${ends.seq || 'none'}, but entry ${head.seq} was the last one written: the newest entries have been removed.`;
    return this.boundaryProblem(head);
  }
  private boundaryProblem(head: HeadRow): string | null {
    const signed = head.archived_through ?? 0;
    const archivedTo = this.db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM audit_archive')?.seq ?? 0;
    const liveFrom = this.db.get<{ seq: number | null }>('SELECT MIN(seq) AS seq FROM audit_log')?.seq ?? null;
    if (archivedTo !== signed || (liveFrom !== null && liveFrom <= signed)) return `Entries have been moved between the live log and the archive by something other than this server (the archive reaches entry ${archivedTo}; the server archived up to entry ${signed}).`;
    return null;
  }

  /** Every link of the chain, archive first. */
  private walk(checkpointSeq?: number): { problem: string | null; count: number; last: AuditRow | null; atCheckpoint: { hash: string; count: number } | null } {
    let previous = GENESIS;
    let expectedSeq = 1;
    let count = 0;
    let last: AuditRow | null = null;
    let atCheckpoint: { hash: string; count: number } | null = null;
    const fail = (problem: string) => ({ problem, count, last, atCheckpoint });
    for (const table of ['audit_archive', 'audit_log']) {
      for (const row of this.db.all<AuditRow>(`SELECT * FROM ${table} ORDER BY seq`)) {
        const key = this.keys.all.find((item) => item.id === row.key_id);
        if (!key) return fail(`Entry ${row.seq} (${row.id}) was signed with a key this server was not given (key id ${row.key_id}). Set DATA_ENCRYPTION_KEY_PREVIOUS to verify it.`);
        // Entries are numbered from 1 without a gap, so the number of the last one is also how many there are.
        if (row.seq !== expectedSeq) return fail(`Entry ${expectedSeq} is missing (found ${row.seq} after ${expectedSeq - 1}).`);
        if (row.prev_hash !== previous) return fail(`Entry ${row.seq} (${row.id}) does not follow the entry before it: one was removed, inserted or reordered.`);
        if (chainHash(key, previous, content(row)) !== row.hash) return fail(`Entry ${row.seq} (${row.id}, ${row.action}) has been changed since it was written.`);
        previous = row.hash;
        expectedSeq = row.seq + 1;
        count += 1;
        last = row;
        if (row.seq === checkpointSeq) atCheckpoint = { hash: row.hash, count };
      }
    }
    return { problem: null, count, last, atCheckpoint };
  }

  /**
   * Walks the whole chain, archive first, and checks every link; that the
   * signed record of the end matches the last entry; that entries are where
   * the server put them (live or archived); that nothing has been added to
   * the database that could hide or drop entries; and, given a checkpoint
   * from outside the database, that the log still contains everything it
   * contained then.
   */
  verify(checkpoint?: AuditCheckpoint): AuditVerification {
    const archived = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_archive')?.n ?? 0;
    const { problem, count, last, atCheckpoint } = this.walk(checkpoint?.seq);
    const fail = (text: string): AuditVerification => ({ ok: false, entries: count, archived, problem: text });
    if (problem) return fail(problem);
    // The end of the log. Its record carries a signature only the key holder can make, over the last entry, the
    // count and how far the archive reaches. (The count needs no check of its own: entries are numbered from 1
    // without a gap, which the walk has just established, so the last entry's number IS the count.)
    const head = this.head();
    const headProblem = this.headProblem(head);
    if (headProblem) return fail(`${headProblem} Entries may have been removed from the end of the log.`);
    const signed = head as HeadRow;
    if ((last?.seq ?? 0) !== signed.seq || (last?.hash ?? GENESIS) !== signed.hash) return fail(`The log ends at entry ${last?.seq ?? 'none'}, but entry ${signed.seq} was the last one written: the newest entries have been removed.`);
    const boundary = this.boundaryProblem(signed);
    if (boundary) return fail(boundary);
    const structure = this.structureProblem();
    if (structure) return fail(structure);
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
