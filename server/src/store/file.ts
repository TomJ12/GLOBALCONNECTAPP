/**
 * LOCAL DEMO ONLY. Keeps accounts in one JSON file so they survive a restart.
 *
 * The file holds password hashes, authenticator keys (in plain form), unused
 * activation records, pending approval requests and the main audit log. It is
 * not a database: a change rewrites the whole file, and nothing is encrypted.
 * The server refuses to start with DATA_FILE outside explicit development
 * mode (see config.ts), and this function refuses as well.
 *
 * NOT kept, so that an anonymous failed sign-in never causes a write:
 * sessions, sign-in challenges, step-up permissions, attempt counters and
 * the anonymous-failure audit stream. A restart signs everyone out and
 * forgets lockouts.
 *
 * The audit log's working segment is in the file. When it is full it is moved
 * to its own file beside this one (`<file>.audit-<n>-<time>.json`) and a new
 * segment starts, so the main file does not grow without limit and a restart
 * never reloads a "full" log.
 *
 * `seedCodes` holds, in plain form, the activation codes the server itself
 * printed for the sample accounts, so that a restart can print the same
 * still-valid codes again instead of replacing them. Development only, like
 * the rest of this file.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { attemptsTable, MemoryAuditLog, MemoryDirectory, MemoryOpsDirectory, MemoryTable, type DirectoryData } from './memory';
import type { ActivationRecord, ApprovalRecord, AuditEntry, OpsUserRecord, ProviderKeyRecord, Stores, Table } from './types';

/** Bumped whenever the shape changes. scripts/demo.mjs checks the same number before it builds anything. */
export const DATA_FILE_VERSION = 3;
/** Entries per audit segment in the demo file (the whole file is rewritten on each change, so it is kept small). */
const FILE_AUDIT_SEGMENT = 5_000;

export interface SeedCode {
  code: string;
  /** SHA-256 of the normalised code: the key of the invitation it belongs to. */
  codeHash: string;
}

const text = z.string();
const stamp = z.number().nullable();
const account = { id: text, email: text, name: text, passwordHash: text.nullable(), totpSecret: text.nullable(), lastTotpStep: z.number(), recoveryCodeHashes: z.array(text), activatedAt: stamp };
const party = z.object({ type: z.enum(['client', 'ops', 'system', 'company']), id: text.nullable(), label: text });
const activation = z.object({ userId: text, expiresAt: z.number(), pendingPasswordHash: text.nullable(), pendingTotpSecret: text.nullable() });
const person = z.object({ id: text, email: text });

/** The whole file is checked on load: a damaged or hand-edited file is refused rather than half-trusted. */
const snapshotSchema = z.strictObject({
  version: z.literal(DATA_FILE_VERSION),
  directory: z.object({
    users: z.array(z.object({ ...account, disabledAt: stamp.optional(), lastSignInAt: stamp.optional(), knownSources: z.array(text).optional() })),
    companies: z.array(z.object({ id: text, name: text, providerKey: z.enum(['currencycloud', 'equals']), providerAccountId: text, providerContactId: text, deactivatedAt: stamp.optional(), previousName: text.nullable().optional(), renamedAt: stamp.optional() })),
    memberships: z.array(z.object({ userId: text, companyId: text, role: z.enum(['creator', 'approver', 'admin']) })),
  }),
  opsUsers: z.array(z.object({ ...account, role: z.enum(['ops', 'ops_admin']), disabledAt: stamp, lastSignInAt: stamp, knownSources: z.array(text).optional() })),
  activations: z.record(text, activation),
  opsActivations: z.record(text, activation),
  approvals: z.record(
    text,
    z.object({
      id: text,
      action: text,
      params: z.record(text, text),
      summary: text,
      warnings: z.array(text),
      target: party.nullable(),
      requestedBy: person,
      requestedAt: z.number(),
      expiresAt: z.number(),
      status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired']),
      decidedBy: person.nullable(),
      decidedAt: stamp,
    }),
  ),
  providerKeys: z.record(text, z.object({ orderId: text, createdAt: z.number() })),
  seedCodes: z.record(text, z.object({ code: text, codeHash: text })),
  audit: z.array(z.object({ id: text, at: z.number(), actor: party, target: party.nullable(), action: text, outcome: z.enum(['success', 'failure']), source: text, detail: z.record(text, text) })),
});
type Snapshot = z.infer<typeof snapshotSchema>;

export function createFileStores(file: string, seed: DirectoryData, options: { development: boolean; now?: () => number; warn?: (message: string) => void; auditSegment?: number }): Stores & { seedCodes: Table<SeedCode> } {
  if (!options.development) throw new Error('The file store is for local demonstrations only and needs APP_ENV=development.');
  const now = options.now ?? Date.now;
  const target = path.resolve(file);
  let loaded: Snapshot | null = null;
  if (existsSync(target)) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(target, 'utf8'));
    } catch {
      throw new Error(`${target} is not valid JSON. Remove it (npm run demo:reset) to start again.`);
    }
    const parsed = snapshotSchema.safeParse(json);
    if (!parsed.success) {
      const where = parsed.error.issues[0]?.path.join('.') ?? '';
      throw new Error(`${target} is not a Global Connect demo data file of this version (problem at "${where}"). It was probably written by an earlier version. Run:  npm run demo:reset`);
    }
    loaded = parsed.data;
  }

  let ready = false;
  const save = (): void => {
    if (!ready) return;
    const snapshot: Snapshot = {
      version: DATA_FILE_VERSION,
      directory: directory.snapshot(),
      opsUsers: opsUsers.snapshot(),
      activations: activations.snapshot(),
      opsActivations: opsActivations.snapshot(),
      approvals: approvals.snapshot(),
      providerKeys: providerKeys.snapshot(),
      seedCodes: seedCodes.snapshot(),
      audit: audit.snapshot(),
    };
    mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    renameSync(temporary, target);
  };
  const changed = save;

  const directory = new MemoryDirectory((loaded?.directory as DirectoryData | undefined) ?? seed, changed);
  const opsUsers = new MemoryOpsDirectory((loaded?.opsUsers as OpsUserRecord[] | undefined) ?? [], changed);
  const activations = new MemoryTable<ActivationRecord>({ initial: loaded?.activations, changed });
  const opsActivations = new MemoryTable<ActivationRecord>({ initial: loaded?.opsActivations, changed });
  const approvals = new MemoryTable<ApprovalRecord>({ initial: loaded?.approvals as Record<string, ApprovalRecord> | undefined, changed });
  const providerKeys = new MemoryTable<ProviderKeyRecord>({ limit: 1_000_000, initial: loaded?.providerKeys, changed });
  const seedCodes = new MemoryTable<SeedCode>({ initial: loaded?.seedCodes, changed });
  const archive = {
    async write(segment: AuditEntry[]): Promise<string> {
      const base = path.basename(target);
      const taken = readdirSync(path.dirname(target)).filter((name) => name.startsWith(`${base}.audit-`)).length;
      const name = `${target}.audit-${String(taken + 1).padStart(4, '0')}-${new Date(segment.at(-1)?.at ?? now()).toISOString().replace(/[:.]/g, '')}.json`;
      writeFileSync(name, JSON.stringify(segment), { mode: 0o600, flag: 'wx' });
      return name;
    },
  };
  const audit = new MemoryAuditLog((loaded?.audit as AuditEntry[] | undefined) ?? [], changed, { limit: options.auditSegment ?? FILE_AUDIT_SEGMENT, archive, warn: options.warn });
  ready = true;
  save();

  return {
    directory,
    auth: { activations, challenges: new MemoryTable(), sessions: new MemoryTable(), stepUps: new MemoryTable(), attempts: attemptsTable(now) },
    ops: {
      users: opsUsers,
      activations: opsActivations,
      challenges: new MemoryTable(),
      sessions: new MemoryTable(),
      attempts: attemptsTable(now),
      approvals,
    },
    audit,
    providerKeys,
    seedCodes,
  };
}
