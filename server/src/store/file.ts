/**
 * LOCAL DEMO ONLY. Keeps accounts in one JSON file so they survive a restart.
 *
 * The file holds password hashes, authenticator keys (in plain form), unused
 * activation records and the audit log. It is not a database: every change
 * rewrites the whole file, and nothing is encrypted. The server refuses to
 * start with DATA_FILE when NODE_ENV=production (see config.ts), and this
 * function refuses as well.
 *
 * Sessions, sign-in challenges and step-up permissions are NOT kept: a restart
 * signs everyone out.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { MemoryAuditLog, MemoryDirectory, MemoryOpsDirectory, MemoryTable, type DirectoryData } from './memory';
import type { ActivationRecord, AttemptRecord, AuditEntry, OpsUserRecord, Stores } from './types';

interface Snapshot {
  version: 1;
  directory: DirectoryData;
  opsUsers: OpsUserRecord[];
  activations: Record<string, ActivationRecord>;
  opsActivations: Record<string, ActivationRecord>;
  attempts: Record<string, AttemptRecord>;
  opsAttempts: Record<string, AttemptRecord>;
  audit: AuditEntry[];
}

export function createFileStores(file: string, seed: DirectoryData, options: { production: boolean }): Stores {
  if (options.production) throw new Error('The file store is for local demonstrations only and cannot be used in production.');
  const target = path.resolve(file);
  let loaded: Partial<Snapshot> = {};
  if (existsSync(target)) {
    loaded = JSON.parse(readFileSync(target, 'utf8')) as Partial<Snapshot>;
    if (loaded.version !== 1) throw new Error(`${target} is not a Global Connect demo data file.`);
  }

  let ready = false;
  const save = (): void => {
    if (!ready) return;
    const snapshot: Snapshot = {
      version: 1,
      directory: directory.snapshot(),
      opsUsers: opsUsers.snapshot(),
      activations: activations.snapshot(),
      opsActivations: opsActivations.snapshot(),
      attempts: attempts.snapshot(),
      opsAttempts: opsAttempts.snapshot(),
      audit: audit.snapshot(),
    };
    mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    renameSync(temporary, target);
  };

  const directory = new MemoryDirectory(loaded.directory ?? seed, save);
  const opsUsers = new MemoryOpsDirectory(loaded.opsUsers ?? [], save);
  const activations = new MemoryTable<ActivationRecord>(100_000, loaded.activations ?? {}, save);
  const opsActivations = new MemoryTable<ActivationRecord>(100_000, loaded.opsActivations ?? {}, save);
  const attempts = new MemoryTable<AttemptRecord>(100_000, loaded.attempts ?? {}, save);
  const opsAttempts = new MemoryTable<AttemptRecord>(100_000, loaded.opsAttempts ?? {}, save);
  const audit = new MemoryAuditLog(loaded.audit ?? [], save);
  ready = true;
  save();

  return {
    directory,
    auth: { activations, challenges: new MemoryTable(), sessions: new MemoryTable(), stepUps: new MemoryTable(), attempts },
    ops: { users: opsUsers, activations: opsActivations, challenges: new MemoryTable(), sessions: new MemoryTable(), attempts: opsAttempts },
    audit,
  };
}
