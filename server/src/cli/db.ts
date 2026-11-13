/**
 * Database commands. They open the database file directly (it is safe to do
 * so while the server is running) and need the same DATABASE_PATH and
 * DATA_ENCRYPTION_KEY as the server.
 *
 *   npm run audit:verify            check the audit log's hash chain, live and archived
 *   npm run db:backup -- <file>     write a consistent copy of the database to <file>
 *   npm run db:rotate-key           re-encrypt every authenticator key with DATA_ENCRYPTION_KEY
 *                                   (older keys in DATA_ENCRYPTION_KEY_PREVIOUS)
 *
 * In development, with nothing set, they use the demo database
 * (.demo-data/globalconnect.sqlite) and the key file beside it.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSqliteStores } from '../store/sqlite';
import { dataKeys } from '../store/sqlite/keys';

const [command, argument] = process.argv.slice(2);
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
  stores = createSqliteStores({ path: database, keys: dataKeys(keyText as string, (process.env.DATA_ENCRYPTION_KEY_PREVIOUS ?? '').split(',').map((item) => item.trim()).filter(Boolean)) });
} catch (error) {
  fail(error instanceof Error ? error.message : 'The database could not be opened.');
}
const opened = stores as NonNullable<typeof stores>;

try {
  if (command === 'audit-verify') {
    const result = opened.verifyAudit();
    if (!result.ok) {
      console.error(`AUDIT LOG VERIFICATION FAILED after ${result.entries} good entries.\n${result.problem}`);
      process.exitCode = 1;
    } else {
      console.log(`Audit log verified: ${result.entries} entries (${result.archived} of them archived), every one chained to the one before it and unchanged.`);
    }
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
    fail('Unknown command. Use audit-verify, backup <file> or rotate-key.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The command failed.');
  process.exitCode = 1;
} finally {
  opened.close();
}
