/**
 * Database commands. They open the database file directly (it is safe to do
 * so while the server is running) and need the same DATABASE_PATH and
 * DATA_ENCRYPTION_KEY as the server.
 *
 *   npm run audit:verify [-- --checkpoint <file>]
 *                                   check the audit log: every link of the hash chain (live and archived), the
 *                                   signed record of its end, the triggers, and, given a checkpoint file, that
 *                                   nothing recorded at the checkpoint has gone
 *   npm run audit:checkpoint -- <file>
 *                                   write a signed note of where the log ends now, to keep OUTSIDE the database
 *   npm run db:backup -- <file>     write a consistent copy of the database to <file> (readable by you only)
 *
 * audit:verify, audit:checkpoint and db:backup open the database READ-ONLY: they change nothing in it.
 *   npm run db:rotate-key           re-encrypt every authenticator key with DATA_ENCRYPTION_KEY
 *                                   (older keys in DATA_ENCRYPTION_KEY_PREVIOUS)
 *
 * In development, with nothing set, they use the demo database
 * (.demo-data/globalconnect.sqlite) and the key file beside it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSqliteStores } from '../store/sqlite';
import type { AuditCheckpoint } from '../store/sqlite/audit';
import { dataKeys } from '../store/sqlite/keys';

// Whatever these commands write (a backup, a checkpoint) is for this user only.
process.umask(0o077);
const [command, ...rest] = process.argv.slice(2);
const checkpointFile = rest[0] === '--checkpoint' ? rest[1] : undefined;
const argument = rest[0] === '--checkpoint' ? undefined : rest[0];
const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.demo-data', 'globalconnect.sqlite');
const file = process.env.DATABASE_PATH ? path.resolve(process.env.DATABASE_PATH) : existsSync(demo) ? demo : null;
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

if (!file || !existsSync(file)) fail(`No database found${file ? ` at ${file}` : ''}. Set DATABASE_PATH to the SQLite file.`);
const database = file as string;
const keyFile = `${database}.dev-key`;
const keyText = process.env.DATA_ENCRYPTION_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : null);
if (!keyText) fail('Set DATA_ENCRYPTION_KEY to the key the server uses for this database.');

let stores;
try {
  stores = createSqliteStores({ path: database, readOnly: command !== 'rotate-key', keys: dataKeys(keyText as string, (process.env.DATA_ENCRYPTION_KEY_PREVIOUS ?? '').split(',').map((item) => item.trim()).filter(Boolean)) });
} catch (error) {
  fail(error instanceof Error ? error.message : 'The database could not be opened.');
}
const opened = stores as NonNullable<typeof stores>;

try {
  if (command === 'audit-verify') {
    let checkpoint: AuditCheckpoint | undefined;
    if (rest[0] === '--checkpoint') {
      if (!checkpointFile || !existsSync(checkpointFile)) fail('Usage: npm run audit:verify -- --checkpoint <checkpoint file>');
      try {
        checkpoint = JSON.parse(readFileSync(checkpointFile as string, 'utf8')) as AuditCheckpoint;
      } catch {
        fail(`${checkpointFile} is not a checkpoint file.`);
      }
    }
    const result = opened.verifyAudit(checkpoint);
    if (!result.ok) {
      console.error(`AUDIT LOG VERIFICATION FAILED after ${result.entries} good entries.\n${result.problem}`);
      process.exitCode = 1;
    } else {
      console.log(`Audit log verified: ${result.entries} entries (${result.archived} of them archived), every one chained to the one before it and unchanged.${checkpoint ? ` Everything recorded at the checkpoint of ${new Date(checkpoint.at).toISOString()} (${checkpoint.count} entries) is still there.` : ''}`);
    }
  } else if (command === 'audit-checkpoint') {
    if (!argument) fail('Usage: npm run audit:checkpoint -- <file to write>');
    const target = path.resolve(argument as string);
    if (existsSync(target)) fail(`${target} already exists. Choose a new file name.`);
    const checkpoint = opened.audit.checkpoint(Date.now());
    writeFileSync(target, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(`Checkpoint written to ${target}: the log ends at entry ${checkpoint.seq} with ${checkpoint.count} entries.\nKeep it somewhere the database's keeper cannot change it. Later, "npm run audit:verify -- --checkpoint ${target}" shows whether anything recorded up to now has been removed.`);
  } else if (command === 'backup') {
    if (!argument) fail('Usage: npm run db:backup -- <file to write>');
    const target = path.resolve(argument as string);
    if (existsSync(target)) fail(`${target} already exists. Choose a new file name.`);
    opened.db.backupTo(target);
    console.log(`Backup written to ${target}.\nIt holds everything the database does (password hashes, encrypted authenticator keys, the audit log). The encryption key is NOT in it: keep the key somewhere else, and keep it, or the backup's authenticator keys cannot be read.`);
  } else if (command === 'rotate-key') {
    const changed = opened.rotateKeys();
    console.log(`${changed} stored secret${changed === 1 ? '' : 's'} re-encrypted with the current key.\nKeep the old key in DATA_ENCRYPTION_KEY_PREVIOUS for as long as audit entries written under it must be verifiable.`);
  } else {
    fail('Unknown command. Use audit-verify [--checkpoint <file>], audit-checkpoint <file>, backup <file> or rotate-key.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The command failed.');
  process.exitCode = 1;
} finally {
  opened.close();
}
