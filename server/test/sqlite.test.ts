/** The SQLite store itself: migrations, transactions under a crash and under real concurrency, encryption at rest, the audit chain, restarts. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config';
import { MINIMUM_NODE, nodeVersionProblem } from '../src/nodeVersion';
import { createRuntime, keysFor } from '../src/startup';
import { seedDirectory } from '../src/store/seed';
import { createSqliteStores } from '../src/store/sqlite';
import { legacyHeadMac, type AuditCheckpoint } from '../src/store/sqlite/audit';
import { Db, LOCK_WATCH_MS, lockForServer } from '../src/store/sqlite/db';
import { dataKeys, newDataKey, open, seal } from '../src/store/sqlite/keys';
import { AUDIT_TRIGGERS, MIGRATIONS } from '../src/store/sqlite/migrations';
import { AMIRA, BEN, DANA, harness, PASSWORD, TEST_DATA_KEY, type Harness } from './helpers';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(serverDir, 'node_modules', '.bin', 'tsx');
const OTHER_KEY = 'Zk3Xw9Qe7Rt1Yu5Io2Pa8Sd4Fg6Hj0KlMnBvCxLqWeE=';
const keys = dataKeys(TEST_DATA_KEY);

let folder: string;
let file: string;
let h: Harness | undefined;
beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), 'gc-sqlite-'));
  file = path.join(folder, 'data.sqlite');
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  rmSync(folder, { recursive: true, force: true });
});

const DROP_TRIGGERS = Object.keys(AUDIT_TRIGGERS).map((name) => `DROP TRIGGER ${name};`).join(' ');
const RECREATE_TRIGGERS = `${Object.values(AUDIT_TRIGGERS).join('; ')};`;
const system = (action: string, at = 1) => ({ at, actor: { type: 'system' as const, id: null, label: 'test' }, target: null, action, outcome: 'success' as const, source: '', detail: { note: 'x' } });
/** The database file and its write-ahead log, as someone who copied them would see them. */
const rawBytes = () => Buffer.concat(readdirSync(folder).filter((name) => name.startsWith('data.sqlite')).map((name) => readFileSync(path.join(folder, name)))).toString('latin1');

// --- start-up -----------------------------------------------------------------------------------------

test('Node version: anything older than the minimum is refused with a plain message, before the server loads', () => {
  assert.equal(MINIMUM_NODE, '22.13.0');
  for (const version of ['18.19.0', '20.18.1', '22.4.0', '22.12.9']) assert.match(nodeVersionProblem(version) ?? '', /Node\.js 22\.13\.0 or newer is required \(this is /, version);
  for (const version of ['22.13.0', '22.23.4', '24.1.0']) assert.equal(nodeVersionProblem(version), null, version);
  // The entry point checks before it imports anything that needs SQLite.
  const entry = readFileSync(path.join(serverDir, 'src', 'index.ts'), 'utf8');
  assert.ok(entry.indexOf('nodeVersionProblem()') < entry.indexOf("await import('./main')") && !/^import .*(main|sqlite|startup)/m.test(entry));
  assert.equal((JSON.parse(readFileSync(path.join(serverDir, 'package.json'), 'utf8')) as { engines: { node: string } }).engines.node, `>=${MINIMUM_NODE}`);
});

test('migrations: an empty file is brought to the current schema; reopening changes nothing; a newer database is refused; a failing migration leaves no trace', () => {
  const first = new Db(file);
  assert.equal(first.schemaVersion(), MIGRATIONS.length);
  const tables = () => new Db(file).all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger', 'index') ORDER BY name").map((row) => row.name);
  for (const name of ['users', 'ops_users', 'companies', 'memberships', 'sessions', 'attempts', 'ops_approvals', 'audit_log', 'audit_archive', 'audit_log_no_update', 'audit_log_no_delete']) assert.ok(tables().includes(name), name);
  assert.equal(first.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode, 'wal');
  assert.deepEqual([first.get<{ synchronous: number }>('PRAGMA synchronous')?.synchronous, first.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys], [2, 1]);
  assert.equal(first.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout, 5000);
  const applied = first.all('SELECT * FROM schema_version');
  first.close();
  const again = new Db(file);
  assert.deepEqual(again.all('SELECT * FROM schema_version'), applied);

  // A migration that fails half-way is rolled back whole, and the version does not move.
  again.close();
  const before = tables();
  assert.throws(() => new Db(file, [...MIGRATIONS, 'CREATE TABLE half_done (id TEXT); CREATE TABLE users (id TEXT);']), /already exists/);
  assert.deepEqual(tables(), before);
  // One that succeeds is recorded, once.
  const next = new Db(file, [...MIGRATIONS, 'CREATE TABLE later (id TEXT)']);
  assert.equal(next.schemaVersion(), MIGRATIONS.length + 1);
  next.close();

  // This code now meets a database one version ahead of it.
  assert.throws(() => new Db(file), new RegExp(`schema version ${MIGRATIONS.length + 1}, but this version of the server only knows up to ${MIGRATIONS.length}.*refusing to open`));
  assert.throws(() => createSqliteStores({ path: file, keys }), /refusing to open/);
});

test('foreign keys are enforced: a membership cannot point at a person or company that does not exist', async () => {
  const stores = createSqliteStores({ path: ':memory:', keys, seed: seedDirectory() });
  await assert.rejects(stores.directory.setMembership({ userId: 'usr_nobody', companyId: 'co_northfield', role: 'creator' }), /FOREIGN KEY/);
  await assert.rejects(stores.directory.setMembership({ userId: 'usr_amira', companyId: 'co_nowhere', role: 'creator' }), /FOREIGN KEY/);
  stores.close();
});

// --- crash consistency ---------------------------------------------------------------------------------

test('crash: a process killed in the middle of a transaction leaves every finished transaction whole and the unfinished one absent', async () => {
  createSqliteStores({ path: file, keys, seed: seedDirectory() }).close();
  const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(serverDir, 'test', 'support', 'sqlite-worker.ts'), file, TEST_DATA_KEY, 'crash', 'w', '25', 'unused'], { cwd: serverDir, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.signal, 'SIGKILL', run.stderr);

  const stores = createSqliteStores({ path: file, keys });
  assert.equal(stores.db.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check, 'ok');
  // 25 whole transactions; the 26th had written its first row when the process died, and that row is not there.
  assert.equal(await stores.auth.sessions.count({}), 25);
  assert.equal(stores.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM provider_keys')?.n, 25);
  assert.equal(stores.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')?.n, 25);
  assert.equal(stores.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE key = 's26'")?.n, 0);
  assert.deepEqual(stores.verifyAudit(), { ok: true, entries: 25, archived: 0, problem: null });
  stores.close();
});
// --- real concurrency ----------------------------------------------------------------------------------

/** Starts `workers` processes on the same file, releases them together, and returns what each won. */
async function race(mode: string, count: number, workers = 3): Promise<{ name: string; won: number[] }[]> {
  const go = path.join(folder, `go-${mode}`);
  const children = Array.from({ length: workers }, (_, index) => spawn(process.execPath, ['--import', 'tsx', path.join(serverDir, 'test', 'support', 'sqlite-worker.ts'), file, TEST_DATA_KEY, mode, `w${index}`, String(count), go], { cwd: serverDir, stdio: ['ignore', 'pipe', 'pipe'] }));
  const outputs = children.map((child) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    return {
      ready: new Promise<void>((resolve) => child.stdout.on('data', () => out.includes('ready') && resolve())),
      done: new Promise<{ name: string; won: number[] }>((resolve, reject) =>
        child.on('exit', (code) => {
          const line = out.trim().split('\n').at(-1) ?? '';
          if (code === 0) resolve(JSON.parse(line) as { name: string; won: number[] });
          else reject(new Error(`worker failed (${code}): ${err.replace(/.*ExperimentalWarning.*\n.*\n/, '')}`));
        }),
      ),
    };
  });
  await Promise.all(outputs.map((item) => item.ready));
  writeFileSync(go, String(Date.now() + 150));
  return Promise.all(outputs.map((item) => item.done));
}
/** Every number 0..count-1 was won by exactly one worker, and more than one worker won something (they really did overlap). */
function assertOnceEach(results: { won: number[] }[], count: number, what: string): void {
  const all = results.flatMap((item) => item.won).sort((a, b) => a - b);
  assert.deepEqual(all, Array.from({ length: count }, (_, index) => index), `${what}: each exactly once`);
  assert.ok(results.filter((item) => item.won.length > 0).length > 1, `${what}: the workers did not overlap (${results.map((item) => item.won.length).join(', ')}), so this proved nothing`);
}

test('concurrency: three processes on one file. Counting loses nothing; every one-time thing is used exactly once; the audit chain holds', { timeout: 180_000 }, async () => {
  const N = 200;
  const stores = createSqliteStores({ path: file, keys, seed: seedDirectory() });
  await stores.directory.updateUser('usr_amira', (user) => ({ ...user, recoveryCodeHashes: Array.from({ length: N }, (_, n) => `hash${n}`) }));
  stores.db.tx(() => {
    for (let n = 0; n < N; n += 1) {
      void stores.auth.activations.put(`inv${n}`, { userId: 'usr_ben', expiresAt: 9e15, pendingPasswordHash: null, pendingTotpSecret: null });
      void stores.auth.stepUps.put(`su${n}`, { userId: 'usr_amira', sessionId: 's', companyId: null, action: 'payment.approve', payloadHash: 'p', expiresAt: 9e15 });
      void stores.auth.sessions.put(`sess${n}`, { id: `sess${n}`, userId: 'usr_amira', companyId: null, createdAt: 1, lastSeenAt: 1 });
      void stores.ops.approvals.put(`req${n}`, { id: `req${n}`, action: 'client.unlock', params: {}, summary: 's', warnings: [], target: null, requestedBy: { id: 'ops_1', email: 'a@globalconnect.example' }, requestedAt: 1, expiresAt: 9e15, status: 'pending', decidedBy: null, decidedAt: null });
    }
  });

  // Attempt counting: 3 x 300 read-add-write cycles. A lost update would leave fewer.
  await race('count', N);
  assert.equal((await stores.auth.attempts.get('counter'))?.failures, 3 * N);

  // The invitation compare-and-swap, then its one-time use.
  assertOnceEach(await race('invitation', N), N, 'invitation password');
  assertOnceEach(await race('activate', N), N, 'invitation use');
  assert.equal(await stores.auth.activations.count({}), 0);
  // Spending a step-up permission; revoking a session.
  assertOnceEach(await race('stepup', N), N, 'step-up');
  assertOnceEach(await race('revoke', N), N, 'session revoke');
  // Recovery codes: each is removed by exactly one of the three.
  assertOnceEach(await race('recovery', N), N, 'recovery code');
  assert.deepEqual((await stores.directory.getUser('usr_amira'))?.recoveryCodeHashes, []);
  // Deciding a request.
  assertOnceEach(await race('decide', N), N, 'request decision');
  assert.equal(await stores.ops.approvals.count({ status: 'pending' }), 0);

  // Burning an authenticator step: no step is ever accepted twice, and the last step used only moves forward.
  const burned = (await race('totp', N)).flatMap((item) => item.won);
  assert.equal(new Set(burned).size, burned.length, 'a step was accepted twice');
  assert.equal((await stores.directory.getUser('usr_amira'))?.lastTotpStep, N);

  // The audit chain: 900 entries from three writers, every one linked to exactly one predecessor.
  await race('audit', N);
  assert.deepEqual(stores.verifyAudit(), { ok: true, entries: 3 * N, archived: 0, problem: null });
  stores.close();
});

// --- encryption at rest --------------------------------------------------------------------------------

test('encryption: authenticator keys cannot be read from the file, survive a restart, and the wrong or a missing key refuses to start', async () => {
  h = await harness({}, undefined, { databasePath: file });
  const amira = await h.activate(AMIRA);
  // A half-finished activation holds a pending authenticator key too.
  const invitation = await h.invite(BEN);
  const pending = (await h.call('POST', '/v1/activation/password', { body: { activationCode: invitation, password: PASSWORD } })).json.secret as string;
  const staff = await h.opsAuth.createUser('s@globalconnect.example', 'S', 'ops_admin');
  void staff;
  await h.close();

  const raw = rawBytes();
  for (const secret of [amira.secret, pending, TEST_DATA_KEY, Buffer.from(TEST_DATA_KEY, 'base64').toString('latin1')]) assert.ok(!raw.includes(secret), 'a secret is readable in the database file');
  assert.match(raw, /gcm1:[0-9a-f]{12}:/);

  // RESTART with the same key: the secret is read back and a code from it signs in.
  h = await harness({}, undefined, { databasePath: file });
  assert.equal((await h.stores.directory.getUser('usr_amira'))?.totpSecret, amira.secret);
  h.clock.advance(60_000);
  assert.equal((await h.login(AMIRA, amira.secret)).status, 200);
  await h.close();
  h = undefined;

  // The wrong key is refused at start-up, and nothing is changed.
  const before = rawBytes();
  assert.throws(() => createSqliteStores({ path: file, keys: dataKeys(OTHER_KEY) }), /DATA_ENCRYPTION_KEY is not the key this database was written with/);
  assert.equal(rawBytes(), before);
  // No key at all: refused outside development, whatever else is set.
  const strict = { ...loadConfig({ APP_ENV: 'development' }), development: false, strict: true, databasePath: file, dataEncryptionKey: null };
  assert.throws(() => keysFor(strict), /DATA_ENCRYPTION_KEY must be set/);
  assert.throws(() => createRuntime(strict, { mailer: { send: async () => {} } }), /DATA_ENCRYPTION_KEY must be set/);
  assert.throws(() => createRuntime({ ...strict, databasePath: null, dataEncryptionKey: TEST_DATA_KEY }, { mailer: { send: async () => {} } }), /DATABASE_PATH must be set/);
  // A ciphertext moved to another row does not decrypt there.
  const moved = createSqliteStores({ path: file, keys });
  moved.db.run("UPDATE users SET totp_secret = (SELECT totp_secret FROM users WHERE id = 'usr_amira') WHERE id = 'usr_dana'");
  // (L6: the key is decrypted when it is read, not when the person is loaded: listing people opens no secret.)
  assert.equal((await moved.directory.getUser('usr_dana'))?.email, DANA);
  await assert.rejects(async () => (await moved.directory.getUser('usr_dana'))?.totpSecret);
  moved.close();
});

test('key rotation: the new key reads what the old one wrote, db:rotate-key re-encrypts everything, and the old key is then not needed for secrets', async () => {
  h = await harness({}, undefined, { databasePath: file });
  const amira = await h.activate(AMIRA);
  const invitation = await h.invite(BEN);
  await h.call('POST', '/v1/activation/password', { body: { activationCode: invitation, password: PASSWORD } });
  await h.close();
  h = undefined;

  const env = { PATH: process.env.PATH ?? '', DATABASE_PATH: file, DATA_ENCRYPTION_KEY: OTHER_KEY, DATA_ENCRYPTION_KEY_PREVIOUS: TEST_DATA_KEY };
  // The new key alone is refused; with the old one listed, the documented command re-encrypts.
  assert.throws(() => createSqliteStores({ path: file, keys: dataKeys(OTHER_KEY) }), /not the key this database was written with/);
  const rotate = spawnSync(tsx, ['src/cli/db.ts', 'rotate-key'], { cwd: serverDir, env, encoding: 'utf8' });
  assert.equal(rotate.status, 0, rotate.stderr);
  assert.match(rotate.stdout, /2 stored secrets re-encrypted with the current key/);
  const oldId = dataKeys(TEST_DATA_KEY).current.id;
  const stores = createSqliteStores({ path: file, keys: dataKeys(OTHER_KEY) });
  assert.equal((await stores.directory.getUser('usr_amira'))?.totpSecret, amira.secret);
  assert.equal(stores.db.get<{ n: number }>("SELECT (SELECT COUNT(*) FROM users WHERE totp_secret LIKE ?) + (SELECT COUNT(*) FROM activations WHERE data LIKE ?) + (SELECT COUNT(*) FROM meta WHERE value LIKE ?) AS n", `%${oldId}%`, `%${oldId}%`, `%${oldId}%`)?.n, 0);
  // Audit entries written under the old key stay verifiable only while that key is still listed.
  assert.match(stores.verifyAudit().problem ?? '', /signed with a key this server was not given/);
  stores.close();
  const both = createSqliteStores({ path: file, keys: dataKeys(OTHER_KEY, [TEST_DATA_KEY]) });
  assert.equal(both.verifyAudit().ok, true);
  both.close();
});

test('development key file: made once beside the database, never inside it, and reused on the next start', () => {
  const config = { ...loadConfig({ APP_ENV: 'development' }), databasePath: file };
  const first = createRuntime(config);
  first.stores.close();
  const key = readFileSync(`${file}.dev-key`, 'utf8').trim();
  assert.ok(!rawBytes().replace(key, '').includes(key) && !readFileSync(file).toString('latin1').includes(key));
  const second = createRuntime(config);
  second.stores.close();
  assert.equal(readFileSync(`${file}.dev-key`, 'utf8').trim(), key);
  assert.notEqual(key, newDataKey());
});

// --- audit log -----------------------------------------------------------------------------------------

test('audit: the database rejects any change or removal; audit:verify passes on an honest log and names the entry when one was altered, removed or cut off', async () => {
  const stores = createSqliteStores({ path: file, keys, audit: { liveLimit: 6, notice: () => {} } });
  for (let n = 1; n <= 10; n += 1) await stores.audit.append(system(`event.${n}`, n));
  assert.ok((stores.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_archive')?.n ?? 0) > 0, 'some entries are in the archive');

  // Through the front door: every UPDATE and DELETE on either table is refused by a trigger.
  for (const table of ['audit_log', 'audit_archive']) {
    assert.throws(() => stores.db.run(`UPDATE ${table} SET detail = '{}' WHERE seq = (SELECT MIN(seq) FROM ${table})`), /append-only: entries cannot be changed/);
    assert.throws(() => stores.db.run(`DELETE FROM ${table} WHERE seq = (SELECT MAX(seq) FROM ${table})`), /append-only: entries cannot be removed/);
    assert.throws(() => stores.db.run(`DELETE FROM ${table}`), /append-only/);
  }
  assert.deepEqual(stores.verifyAudit(), { ok: true, entries: 10, archived: stores.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_archive')?.n, problem: null });
  stores.close();

  const cli = () => spawnSync(tsx, ['src/cli/db.ts', 'audit-verify'], { cwd: serverDir, env: { PATH: process.env.PATH ?? '', DATABASE_PATH: file, DATA_ENCRYPTION_KEY: TEST_DATA_KEY }, encoding: 'utf8' });
  const honest = cli();
  assert.equal(honest.status, 0, honest.stderr);
  assert.match(honest.stdout, /Audit log verified: 10 entries/);

  // Someone with the FILE can drop the triggers, change what they like, and put the triggers back exactly as they were.
  const backup = path.join(folder, 'copy.sqlite');
  const DROP = Object.keys(AUDIT_TRIGGERS).map((name) => `DROP TRIGGER ${name};`).join(' ');
  const RECREATE = `${Object.values(AUDIT_TRIGGERS).join('; ')};`;
  const copyOf = (source = file) => {
    rmSync(backup, { force: true });
    const db = new Db(source);
    db.backupTo(backup);
    db.close();
  };
  const verdictOf = (target: string, checkpoint?: AuditCheckpoint) => {
    const result = createSqliteStores({ path: target, keys, readOnly: true });
    const verdict = result.verifyAudit(checkpoint);
    result.close();
    return verdict;
  };
  const tamper = (sql: string, restore = RECREATE) => {
    copyOf();
    const copy = new Db(backup);
    copy.exec(DROP);
    copy.exec(sql);
    copy.exec(restore);
    copy.close();
    return verdictOf(backup);
  };
  assert.equal(tamper('SELECT 1').ok, true, 'the copy itself verifies');
  // What they changed is found by the chain...
  assert.match(tamper(`UPDATE audit_log SET detail = '{"note":"y"}' WHERE action = 'event.9'`).problem ?? '', /event\.9\) has been changed since it was written/);
  assert.match(tamper(`UPDATE audit_archive SET actor_label = 'someone else' WHERE action = 'event.2'`).problem ?? '', /event\.2\) has been changed/);
  assert.match(tamper(`DELETE FROM audit_log WHERE action = 'event.9'`).problem ?? '', /Entry 9 is missing/);
  assert.match(tamper(`UPDATE audit_log SET at = at + 1 WHERE action = 'event.8'`).problem ?? '', /event\.8\) has been changed/);
  // ...and cutting the newest entries off is found by the signed record of the end of the log, which cannot be
  // rewritten to match without the key: not edited, not copied from the entry that is now last, not removed.
  assert.match(tamper(`DELETE FROM audit_log WHERE action = 'event.10'`).problem ?? '', /the newest entries have been removed/);
  const cutOff = `DELETE FROM audit_log WHERE action = 'event.10';`;
  assert.match(tamper(`${cutOff} UPDATE audit_head SET seq = 9, count = 9, hash = (SELECT hash FROM audit_log WHERE seq = 9)`).problem ?? '', /end of the log has been altered: its signature does not match\. Entries may have been removed/);
  assert.match(tamper(`${cutOff} UPDATE audit_head SET seq = 9, count = NULL, mac = NULL, hash = (SELECT hash FROM audit_log WHERE seq = 9)`).problem ?? '', /end of the log is not signed/);
  assert.match(tamper(`${cutOff} DELETE FROM audit_head`).problem ?? '', /signed record of the end of the log is missing/);
  assert.match(tamper('DELETE FROM audit_log; DELETE FROM audit_archive; DELETE FROM audit_head').problem ?? '', /signed record of the end of the log is missing/);
  assert.match(tamper('DELETE FROM audit_log; DELETE FROM audit_archive').problem ?? '', /The log ends at entry none, but entry 10 was the last one written/);
  // An entry removed from the archive, with the numbering closed up, is found by the count as well as the chain.
  assert.equal(tamper(`DELETE FROM audit_archive WHERE seq = (SELECT MIN(seq) FROM audit_archive)`).ok, false);
  // Triggers left off, or put back as something that refuses nothing, are reported even when no entry was touched.
  assert.match(tamper('SELECT 1', 'SELECT 1').problem ?? '', /The trigger audit_log_no_update, which is part of how the audit log is protected, is missing/);
  assert.match(tamper('SELECT 1', `${RECREATE.replace(AUDIT_TRIGGERS.audit_log_no_delete as string, "CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log WHEN 1 = 0 BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: entries cannot be removed'); END")}`).problem ?? '', /The trigger audit_log_no_delete, .* has been altered/);
  // An entry added by someone without the key does not make a cut-off log look whole again.
  copyOf();
  const forged = new Db(backup);
  forged.exec(`${DROP} ${cutOff} UPDATE sqlite_sequence SET seq = 9 WHERE name = 'audit_log'; UPDATE audit_head SET seq = 9, count = 9, hash = (SELECT hash FROM audit_log WHERE seq = 9); ${RECREATE}`);
  forged.close();
  // The server does not start on it, and does not offer to sign it either (only the key holder can accept an end).
  assert.throws(() => createSqliteStores({ path: backup, keys }), /end of the log has been altered: its signature does not match[^]*will not sign the end of a log it cannot vouch for/);
  // The same done to a database a server has OPEN: the next entry is refused, with whatever it was to record.
  copyOf();
  const running = createSqliteStores({ path: backup, keys });
  const other = new Db(backup);
  other.exec(`${DROP} ${cutOff} UPDATE sqlite_sequence SET seq = 9 WHERE name = 'audit_log'; UPDATE audit_head SET seq = 9, count = 9, hash = (SELECT hash FROM audit_log WHERE seq = 9); ${RECREATE}`);
  other.close();
  await assert.rejects(async () => running.audit.append(system('event.after', 11)), /audit log cannot be written to, so the action was refused[^]*signature does not match/);
  assert.equal(running.db.get<{ seq: number }>('SELECT MAX(seq) AS seq FROM audit_log')?.seq, 9, 'nothing was written over the cut');
  assert.equal(running.verifyAudit().ok, false);
  running.close();

  // What the file alone cannot show: the whole database replaced by an older, honest copy. A checkpoint kept
  // somewhere else shows it.
  const older = path.join(folder, 'older.sqlite');
  copyOf();
  renameSync(backup, older);
  const later = createSqliteStores({ path: file, keys, audit: { liveLimit: 6, notice: () => {} } });
  await later.audit.append(system('event.11', 11));
  await later.audit.append(system('event.12', 12));
  const checkpoint = later.audit.checkpoint(12);
  later.close();
  assert.equal(verdictOf(file, checkpoint).ok, true);
  assert.equal(verdictOf(older).ok, true, 'an older copy is a valid log in itself');
  assert.match(verdictOf(older, checkpoint).problem ?? '', /no longer contains what it contained at the checkpoint of 1970-01-01T00:00:00\.012Z \(entry 12, 12 entries\): it has been cut back or replaced by an older copy/);
  assert.match(verdictOf(file, { ...checkpoint, seq: 11, count: 11 }).problem ?? '', /checkpoint file is not one this server made, or it has been altered/);
  // The same through the commands: the checkpoint is a file outside the database, for this user only, never overwritten.
  const checkpointFile = path.join(folder, 'audit.checkpoint');
  const run = (...args: string[]) => spawnSync(tsx, ['src/cli/db.ts', ...args], { cwd: serverDir, env: { PATH: process.env.PATH ?? '', DATABASE_PATH: file, DATA_ENCRYPTION_KEY: TEST_DATA_KEY }, encoding: 'utf8' });
  const made = run('audit-checkpoint', checkpointFile);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(statSync(checkpointFile).mode & 0o777, 0o600);
  const again = run('audit-checkpoint', checkpointFile);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /already exists/);
  const withCheckpoint = run('audit-verify', '--checkpoint', checkpointFile);
  assert.equal(withCheckpoint.status, 0, withCheckpoint.stderr);
  assert.match(withCheckpoint.stdout, /Audit log verified: 12 entries[^]*Everything recorded at the checkpoint/);
  const rolledBack = spawnSync(tsx, ['src/cli/db.ts', 'audit-verify', '--checkpoint', checkpointFile], { cwd: serverDir, env: { PATH: process.env.PATH ?? '', DATABASE_PATH: older, DATA_ENCRYPTION_KEY: TEST_DATA_KEY }, encoding: 'utf8' });
  assert.equal(rolledBack.status, 1);
  assert.match(rolledBack.stderr, /AUDIT LOG VERIFICATION FAILED[^]*replaced by an older copy/);

  // The command itself fails, loudly, on the real file once it has been altered.
  const db = new Db(file);
  db.exec(`DROP TRIGGER audit_log_no_update; UPDATE audit_log SET outcome = 'failure' WHERE action = 'event.12'; ${AUDIT_TRIGGERS.audit_log_no_update as string}`);
  db.close();
  const found = cli();
  assert.equal(found.status, 1);
  assert.match(found.stderr, /AUDIT LOG VERIFICATION FAILED after 11 good entries[^]*event\.12\) has been changed/);
});

test('db:backup writes a complete, consistent copy while the database is open, and refuses to overwrite', async () => {
  h = await harness({}, undefined, { databasePath: file });
  const amira = await h.activate(AMIRA);
  const target = path.join(folder, 'backup', 'copy.sqlite');
  const env = { PATH: process.env.PATH ?? '', DATABASE_PATH: file, DATA_ENCRYPTION_KEY: TEST_DATA_KEY };
  assert.equal(spawnSync(tsx, ['src/cli/db.ts', 'backup'], { cwd: serverDir, env, encoding: 'utf8' }).status, 2, 'a path is required');
  rmSync(path.dirname(target), { recursive: true, force: true });
  writeFileSync(path.join(folder, 'taken.sqlite'), 'x');
  assert.match(spawnSync(tsx, ['src/cli/db.ts', 'backup', path.join(folder, 'taken.sqlite')], { cwd: serverDir, env, encoding: 'utf8' }).stderr, /already exists/);
  const run = spawnSync(tsx, ['src/cli/db.ts', 'backup', path.join(folder, 'copy.sqlite')], { cwd: serverDir, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const copy = createSqliteStores({ path: path.join(folder, 'copy.sqlite'), keys });
  assert.equal((await copy.directory.getUser('usr_amira'))?.totpSecret, amira.secret);
  assert.equal(copy.verifyAudit().ok, true);
  assert.equal(copy.verifyAudit().entries, h.stores.verifyAudit().entries);
  copy.close();
  assert.ok(!existsSync(target));
});

// --- restart -------------------------------------------------------------------------------------------

test('restart: sessions, locks, pending requests, invitations and the audit log are all still there', async () => {
  h = await harness({}, undefined, { databasePath: file });
  const amira = await h.activate(AMIRA);
  const token = (await h.login(AMIRA, amira.secret)).json.token as string;
  const invitation = await h.invite(BEN);
  // Lock an account by guessing.
  const dana = await h.activate('dana@adviser.example');
  void dana;
  let status = 0;
  for (let attempt = 0; attempt < 12 && status !== 429; attempt += 1) status = (await h.call('POST', '/v1/auth/login', { body: { email: 'dana@adviser.example', password: 'wrong password here' } })).status;
  assert.equal(status, 429);
  await h.stores.ops.approvals.put('req_1', { id: 'req_1', action: 'client.unlock', params: { id: 'usr_dana' }, summary: 's', warnings: ['w'], target: null, requestedBy: { id: 'ops_1', email: 'a@globalconnect.example' }, requestedAt: h.clock.now, expiresAt: h.clock.now + 60_000, status: 'pending', decidedBy: null, decidedAt: null });
  await h.stores.providerKeys.put('co_northfield:payment:k1', { orderId: 'o1', createdAt: 1 });
  const entries = h.stores.verifyAudit().entries;
  const at = h.clock.now;
  await h.close();

  h = await harness({}, undefined, { databasePath: file });
  h.clock.now = at + 1000;
  assert.equal((await h.call('GET', '/v1/company', { token })).status, 200, 'the session survived');
  assert.equal((await h.call('POST', '/v1/auth/login', { body: { email: 'dana@adviser.example', password: PASSWORD } })).status, 429, 'the lock survived');
  assert.equal((await h.stores.ops.approvals.get('req_1'))?.status, 'pending');
  assert.equal((await h.stores.providerKeys.get('co_northfield:payment:k1'))?.orderId, 'o1');
  assert.equal((await h.call('POST', '/v1/activation/start', { body: { activationCode: invitation } })).status, 200, 'the invitation survived');
  const verdict = h.stores.verifyAudit();
  assert.ok(verdict.ok && verdict.entries >= entries);
  // The sample people were not seeded a second time over the real ones.
  assert.ok((await h.stores.directory.getUser('usr_amira'))?.activatedAt);
});

// --- Review of fe9d053 -----------------------------------------------------------------------------------

/** Undoes what the migrations after 5 added (kept up to date with migrations.ts). */
const AFTER_5 = 'DROP TABLE mail_outbox; DROP TABLE password_resets; DROP TABLE ops_password_resets; DROP TABLE authenticator_resets;';
/** Turns a current database back into one as commit 2ac6785 left it (schema 4): the end of the log signed without the archive boundary, a plain development marker, no signed state. */
function asSchema4(target: string): void {
  const db = new Db(target);
  const head = db.get<{ seq: number; hash: string; count: number }>('SELECT seq, hash, count FROM audit_head') as { seq: number; hash: string; count: number };
  db.exec(`${AFTER_5} DROP TABLE direct_payments; ALTER TABLE audit_head DROP COLUMN archived_through; DELETE FROM schema_version WHERE version >= 5;
    DELETE FROM meta WHERE key = 'state'; INSERT OR REPLACE INTO meta (key, value) VALUES ('used_in_development', '1');`);
  db.run('UPDATE audit_head SET mac = ?, key_id = ?', legacyHeadMac(keys.current, head.seq, head.hash, head.count), keys.current.id);
  db.close();
}
/** ...and one as the version before that left it (schema 3): nothing about the end of the log is signed. */
function asSchema3(target: string): void {
  asSchema4(target);
  const db = new Db(target, MIGRATIONS.slice(0, 4));
  db.exec(`DROP INDEX companies_provider_account; DROP INDEX companies_name_key; ALTER TABLE companies DROP COLUMN name_key;
    ALTER TABLE audit_head DROP COLUMN count; ALTER TABLE audit_head DROP COLUMN mac; ALTER TABLE audit_head DROP COLUMN key_id;
    DELETE FROM schema_version WHERE version = 4; DELETE FROM meta WHERE key = 'used_in_development';`);
  db.close();
}
/** The version table as it is on disk, read without this code's help. */
const versionOf = (target: string, _known?: number): number => {
  const db = new DatabaseSync(target, { readOnly: true });
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_version'").get() ? Number((db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number | null }).version ?? 0) : 0;
  } finally {
    db.close();
  }
};
const modeOf = (target: string) => (statSync(target).mode & 0o777).toString(8);
/** A database with some real history: sample people, an activated account, audit entries. */
async function withHistory(): Promise<{ secret: string; entries: number }> {
  h = await harness({}, undefined, { databasePath: file });
  const amira = await h.activate(AMIRA);
  for (let n = 0; n < 6; n += 1) await h.stores.audit.append(system(`event.${n}`, n + 1));
  const entries = h.stores.verifyAudit().entries;
  await h.close();
  h = undefined;
  return { secret: amira.secret, entries };
}
const open5 = (extra: Partial<Parameters<typeof createSqliteStores>[0]> = {}) => createSqliteStores({ path: file, keys, mode: 'development', ...extra });

test('upgrade: a schema-4 database keeps the end of its log exactly as that version signed it; a schema-3 one with entries is taken on only by the key holder, on record', async () => {
  const { secret, entries } = await withHistory();

  // --- From schema 4 (the previous commit): automatic, because the end of the log verifies as that version signed it.
  asSchema4(file);
  assert.equal(versionOf(file, 4), 4);
  let stores = open5();
  assert.equal(stores.db.schemaVersion(), MIGRATIONS.length);
  assert.deepEqual(stores.verifyAudit(), { ok: true, entries, archived: 0, problem: null });
  assert.equal(stores.acceptedLogEnd, false);
  assert.equal((await stores.directory.getUser('usr_amira'))?.totpSecret, secret);
  stores.close();
  // It was a development database and stays one, though the old plain marker is gone.
  const plain = new Db(file);
  plain.run("DELETE FROM meta WHERE key = 'used_in_development'");
  plain.close();
  assert.throws(() => createSqliteStores({ path: file, keys, mode: 'strict' }), /has been used in development mode/);
  // Brought up to date by something that is not the development server (a command): it is a development database all the same.
  asSchema4(file);
  createSqliteStores({ path: file, keys }).close();
  assert.throws(() => createSqliteStores({ path: file, keys, mode: 'strict' }), /has been used in development mode/);
  // Nor is a database from before schema 5 ever taken on outside development, marker or no marker: nothing but
  // development could run then.
  asSchema4(file);
  const unmarked = new Db(file, MIGRATIONS.slice(0, 4));
  unmarked.run("DELETE FROM meta WHERE key = 'used_in_development'");
  unmarked.close();
  assert.throws(() => createSqliteStores({ path: file, keys, mode: 'strict' }), /made by an earlier version of the server[^]*cannot be used outside development/);
  assert.equal(versionOf(file), 4);

  // A schema-4 database whose newest entries were cut off BEFORE the upgrade: the signed end is carried over, not
  // recomputed from the tables, so the cut is still found.
  asSchema4(file);
  const cut = new Db(file, MIGRATIONS.slice(0, 4));
  cut.exec(`${DROP_TRIGGERS} DELETE FROM audit_log WHERE seq > ${entries - 2}; ${RECREATE_TRIGGERS}`);
  cut.close();
  assert.throws(() => open5(), /The log ends at entry \d+, but entry \d+ was the last one written: the newest entries have been removed/);
  // ...and one whose record of the end was edited too is not taken on at all.
  const edited = new Db(file);
  edited.exec(`UPDATE audit_head SET seq = ${entries - 2}, count = ${entries - 2}, hash = (SELECT hash FROM audit_log WHERE seq = ${entries - 2})`);
  edited.close();
  assert.throws(() => open5(), /newest entries have been removed|signature does not match/);
});

test('N5: nothing is signed on the word of the version table. A log cut short and "downgraded" is refused, in every variant, and so is every deleted or forged marker', async () => {
  const { entries } = await withHistory();
  const pristine = path.join(folder, 'pristine.sqlite');
  const reset = () => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
    const db = new Db(pristine);
    db.backupTo(file);
    db.close();
  };
  const first = new Db(file);
  first.backupTo(pristine);
  first.close();
  const attack = (sql: string, known = MIGRATIONS.length) => {
    reset();
    const db = new Db(file, MIGRATIONS.slice(0, known));
    db.exec(sql);
    db.close();
  };
  const CUT = `${DROP_TRIGGERS} DELETE FROM audit_log WHERE seq > ${entries - 3}; ${RECREATE_TRIGGERS}`;
  const TO_4 = `${AFTER_5} DROP TABLE direct_payments; ALTER TABLE audit_head DROP COLUMN archived_through; DELETE FROM schema_version WHERE version >= 5;`;
  const TO_3 = `${TO_4} DROP INDEX companies_provider_account; DROP INDEX companies_name_key; ALTER TABLE companies DROP COLUMN name_key; ALTER TABLE audit_head DROP COLUMN count; ALTER TABLE audit_head DROP COLUMN mac; ALTER TABLE audit_head DROP COLUMN key_id; DELETE FROM schema_version WHERE version = 4;`;
  const NO_STATE = `DELETE FROM meta WHERE key = 'state';`;
  const cli = (...args: string[]) => spawnSync(tsx, ['src/cli/db.ts', ...args], { cwd: serverDir, env: { PATH: process.env.PATH ?? '', DATABASE_PATH: file, DATA_ENCRYPTION_KEY: TEST_DATA_KEY }, encoding: 'utf8' });
  const refusedWith = (pattern: RegExp, what: string) => {
    const before = versionOf(file);
    for (const mode of ['development', 'strict'] as const) assert.throws(() => createSqliteStores({ path: file, keys, mode }), mode === 'strict' ? /./ : pattern, `${what} (${mode})`);
    // Nothing was run on it: not one migration.
    assert.equal(versionOf(file), before, what);
    assert.notEqual(cli('audit-verify').status, 0, what);
  };

  // The audit's attack: cut the newest entries, remove what migrations 4 and 5 added, and let the next start "upgrade" it.
  attack(`${CUT} ${TO_3}`);
  refusedWith(/version table says schema 3, but its signed record says \d+: the database has been altered/, 'cut and downgraded to 3');
  attack(`${CUT} ${TO_3} ${NO_STATE}`);
  refusedWith(/end of this database’s audit log is not signed[^]*The server will not sign the end of a log it cannot vouch for[^]*npm run audit:reseal/, 'cut, downgraded to 3, state removed');
  attack(`${CUT} ${TO_4} ${NO_STATE}`);
  refusedWith(/audit log is not signed/, 'cut, downgraded to 4, state removed');
  attack(`${CUT} ${TO_4} ${NO_STATE} UPDATE audit_head SET seq = ${entries - 3}, count = ${entries - 3}, hash = (SELECT hash FROM audit_log WHERE seq = ${entries - 3});`);
  refusedWith(/audit log is not signed/, 'the same with the record of the end edited to match');
  // Without cutting anything: the markers themselves.
  attack(TO_4);
  refusedWith(/version table says schema 4, but its signed record says \d+/, 'version row removed');
  attack(NO_STATE);
  refusedWith(/lost the signed record of its state/, 'state removed');
  attack(`UPDATE meta SET value = json_set(value, '$.dev', json(CASE WHEN json_extract(value, '$.dev') THEN 'false' ELSE 'true' END)) WHERE key = 'state'`);
  refusedWith(/signed record of this database’s state[^]*does not verify/, 'development mark edited out of the state');
  attack(`UPDATE meta SET value = json_set(value, '$.schema', 4) WHERE key = 'state'; ${TO_4}`);
  refusedWith(/does not verify/, 'state edited to agree with a downgrade');
  attack(`DELETE FROM meta WHERE key = 'key_check'`);
  refusedWith(/lost the marker that says which encryption key/, 'key marker removed');
  attack('DROP TABLE schema_version');
  refusedWith(/version table says schema 0, but its signed record says \d+/, 'version table removed');
  attack(`${NO_STATE} DELETE FROM schema_version; DELETE FROM meta WHERE key = 'key_check'`);
  refusedWith(/lost the marker/, 'every marker removed');
  // The end of the log on a current database: unsigned, removed, or pointing at a cut log.
  attack(`${CUT}`);
  refusedWith(/newest entries have been removed/, 'cut');
  attack(`${CUT} UPDATE audit_head SET mac = NULL, count = NULL, seq = ${entries - 3}, hash = (SELECT hash FROM audit_log WHERE seq = ${entries - 3})`);
  refusedWith(/end of the log is not signed/, 'cut, end unsigned');
  attack(`${CUT} DELETE FROM audit_head`);
  refusedWith(/signed record of the end of the log is missing/, 'cut, end removed');

  // An honest database from schema 3 (the first pushed version) with entries: refused in the same words, until the key
  // holder accepts it. A wrong label accepts nothing; the right one works once and leaves its own record.
  reset();
  asSchema3(file);
  assert.throws(() => open5(), /audit log is not signed[^]*its end is "[0-9a-f]{16}"/);
  assert.equal(versionOf(file, 3), 3);
  let label = '';
  try {
    open5();
  } catch (error) {
    label = /AUDIT_ACCEPT_LOG_END=([0-9a-f]{16})/.exec((error as Error).message)?.[1] ?? '';
  }
  assert.throws(() => open5({ acceptLogEnd: 'empty' }), /audit log is not signed/);
  assert.throws(() => open5({ acceptLogEnd: `${label.slice(0, 15)}0` === label ? `${label.slice(0, 15)}1` : `${label.slice(0, 15)}0` }), /audit log is not signed/);
  const adopted = open5({ acceptLogEnd: label });
  assert.equal(adopted.acceptedLogEnd, true);
  assert.deepEqual(adopted.verifyAudit(), { ok: true, entries: entries + 1, archived: 0, problem: null });
  const record = (await adopted.audit.query({ limit: 1 }))[0];
  assert.deepEqual([record?.action, record?.actor.type, record?.detail.entries, record?.detail.endedAtEntry], ['system.audit.resealed', 'system', String(entries), String(entries)]);
  assert.match(record?.detail.reason ?? '', /brought from schema 3/);
  adopted.close();
  // The setting must then be removed: left in place it would accept a log cut back to exactly that entry.
  assert.throws(() => open5({ acceptLogEnd: label }), /AUDIT_ACCEPT_LOG_END is set, but the end of the audit log is properly signed[^]*Remove the setting/);
  open5().close();
  // A schema-3 database with NO entries has nothing to accept, and upgrades by itself.
  reset();
  asSchema3(file);
  const empty = new Db(file, MIGRATIONS.slice(0, 3));
  empty.exec(`${DROP_TRIGGERS} DELETE FROM audit_log; DELETE FROM audit_head; ${RECREATE_TRIGGERS}`);
  empty.close();
  const fresh = open5();
  assert.deepEqual(fresh.verifyAudit(), { ok: true, entries: 0, archived: 0, problem: null });
  fresh.close();

  // Through the command: the key holder accepts a schema-3 log, and it says what that can hide.
  reset();
  asSchema3(file);
  const resealed = cli('audit-reseal');
  assert.equal(resealed.status, 0, resealed.stderr);
  assert.match(resealed.stdout, new RegExp(`accepted as it stood[^]*${entries + 1} entries[^]*can hide entries that were cut off`));
  assert.equal(cli('audit-verify').status, 0);
  assert.match(cli('audit-reseal').stdout, /properly signed\. Nothing was changed/);
  // What can never be accepted: entries that were changed. Only the END of a log can be taken as it stands.
  attack(`${DROP_TRIGGERS} UPDATE audit_log SET detail = '{}' WHERE seq = 2; UPDATE audit_head SET mac = NULL, count = NULL; ${RECREATE_TRIGGERS}`);
  const altered = cli('audit-reseal');
  assert.notEqual(altered.status, 0);
  assert.match(altered.stderr, /cannot be accepted as it stands: Entry 2 [^]*has been changed/);

  // Two companies on one provider account stop the upgrade from schema 3, by name.
  reset();
  asSchema3(file);
  const clash = new Db(file, MIGRATIONS.slice(0, 3));
  clash.run("INSERT INTO companies (id, name, provider_key, provider_account_id, provider_contact_id) SELECT 'co_twin', 'Twin Ltd', provider_key, provider_account_id, provider_contact_id FROM companies WHERE id = 'co_northfield'");
  clash.close();
  assert.throws(() => open5({ acceptLogEnd: true }), /The companies “Northfield Trading Ltd” and “Twin Ltd” are mapped to the same provider account \(sample-account-0001\)[^]*Nothing was changed/);
  assert.equal(versionOf(file, 3), 3);
});

test('M5: the database, its write-ahead files, its lock, its backup and its folder are for this user only, and a database others can read is refused', async () => {
  const before = process.umask(0o022);
  try {
    // Made through the server's own start-up, under an ordinary umask.
    const nested = path.join(folder, 'made', 'here', 'data.sqlite');
    const runtime = createRuntime({ ...loadConfig({ APP_ENV: 'development' }), databasePath: nested });
    await runtime.stores.audit.append(system('event.1'));
    assert.equal(modeOf(path.dirname(nested)), '700');
    for (const suffix of ['', '-wal', '-shm', '.dev-key', '.lock']) assert.equal(modeOf(`${nested}${suffix}`), '600', suffix);
    const backup = path.join(folder, 'made', 'backup.sqlite');
    runtime.stores.db.backupTo(backup);
    assert.equal(modeOf(backup), '600');
    runtime.stores.close();
    // The same through the commands, which set their own umask.
    const env = { PATH: process.env.PATH ?? '', DATABASE_PATH: nested };
    const viaCli = path.join(folder, 'made', 'cli.sqlite');
    const copied = spawnSync(tsx, ['src/cli/db.ts', 'backup', viaCli], { cwd: serverDir, env, encoding: 'utf8' });
    assert.equal(copied.status, 0, copied.stderr);
    assert.equal(modeOf(viaCli), '600');

    // A database file, or a folder, that other users of the machine can read or write: refused, with the command that puts it right.
    for (const [target, mode, wanted] of [[nested, 0o644, 0o600], [nested, 0o660, 0o600], [path.dirname(nested), 0o755, 0o700], [path.dirname(nested), 0o770, 0o700]] as const) {
      chmodSync(target, mode);
      const refusal = new RegExp(`${target.replace(/[.]/g, '\\.')} can be read or changed by other users of this machine \\(its permissions are ${mode.toString(8)}; they must be ${wanted.toString(8)}\\)[^]*chmod ${wanted.toString(8)} `);
      assert.throws(() => createRuntime({ ...loadConfig({ APP_ENV: 'development' }), databasePath: nested }), refusal);
      assert.throws(() => new Db(nested), refusal);
      const cli = spawnSync(tsx, ['src/cli/db.ts', 'audit-verify'], { cwd: serverDir, env, encoding: 'utf8' });
      assert.equal(cli.status, 2);
      assert.match(cli.stderr, refusal);
      chmodSync(target, wanted);
    }
    createRuntime({ ...loadConfig({ APP_ENV: 'development' }), databasePath: nested }).stores.close();
  } finally {
    process.umask(before);
  }
});

test('one server process per database: a second start on the same file is refused until the first has stopped; the commands are not', () => {
  const config = { ...loadConfig({ APP_ENV: 'development' }), databasePath: file };
  const first = createRuntime(config);
  assert.throws(() => createRuntime(config), /Another Global Connect server process is already running on .*data\.sqlite\. Only one may use a database at a time/);
  // A real second process is refused in the same way, and the maintenance commands still run beside a live server.
  const script = `import('./src/startup.ts').then(async ({ createRuntime }) => { const { loadConfig } = await import('./src/config.ts'); createRuntime({ ...loadConfig({ APP_ENV: 'development' }), databasePath: process.env.FILE }); }).catch((error) => { console.error(error.message); process.exit(3); });`;
  const second = spawnSync(tsx, ['-e', script], { cwd: serverDir, env: { PATH: process.env.PATH ?? '', FILE: file }, encoding: 'utf8' });
  assert.equal(second.status, 3, second.stderr);
  assert.match(second.stderr, /Another Global Connect server process is already running/);
  assert.equal(spawnSync(tsx, ['src/cli/db.ts', 'audit-verify'], { cwd: serverDir, env: { PATH: process.env.PATH ?? '', DATABASE_PATH: file }, encoding: 'utf8' }).status, 0);
  first.stores.close();
  const third = createRuntime(config);
  // A failed start does not keep the lock.
  third.stores.close();
  assert.throws(() => createRuntime({ ...config, dataEncryptionKey: OTHER_KEY }), /not the key this database was written with/);
  createRuntime(config).stores.close();
});

test('L1, L10: a database without its key marker is refused whatever key is offered, and one that was ever used in development is refused outside it', () => {
  createSqliteStores({ path: file, keys }).close();
  const raw = new Db(file);
  const marker = raw.get<{ value: string }>("SELECT value FROM meta WHERE key = 'key_check'")?.value as string;
  raw.run("DELETE FROM meta WHERE key = 'key_check'");
  raw.close();
  // Deleting the marker used to let ANY key in, which then wrote its own marker.
  for (const offered of [dataKeys(OTHER_KEY), keys]) assert.throws(() => createSqliteStores({ path: file, keys: offered }), /lost the marker that says which encryption key it was written with[^]*Refusing to open it/);
  const check = new Db(file);
  assert.equal(check.get("SELECT 1 FROM meta WHERE key = 'key_check'"), undefined, 'and no marker was written');
  check.run("INSERT INTO meta (key, value) VALUES ('key_check', ?)", marker);
  check.close();

  // Not yet used in development: strict opens it, again and again.
  createSqliteStores({ path: file, keys, mode: 'strict' }).close();
  createSqliteStores({ path: file, keys, mode: 'strict' }).close();
  // The commands (no mode, read-only) leave no mark either.
  createSqliteStores({ path: file, keys, readOnly: true }).close();
  createSqliteStores({ path: file, keys, mode: 'development', readOnly: true }).close();
  createSqliteStores({ path: file, keys, mode: 'strict' }).close();
  // One start in development (sample people, activation codes kept readable for them) and it is a development database for good.
  const dev = createSqliteStores({ path: file, keys, mode: 'development', seed: seedDirectory() });
  dev.close();
  assert.throws(() => createSqliteStores({ path: file, keys, mode: 'strict' }), /has been used in development mode[^]*cannot be used outside development: start with a new database/);
  createSqliteStores({ path: file, keys, mode: 'development' }).close();
  createSqliteStores({ path: file, keys, readOnly: true }).close();
});

test('L5: key rotation is all or nothing: a secret that cannot be decrypted stops it, names the row, and leaves every other row as it was', async () => {
  h = await harness({}, undefined, { databasePath: file });
  await h.activate(AMIRA);
  const invitation = await h.invite(BEN);
  await h.call('POST', '/v1/activation/password', { body: { activationCode: invitation, password: PASSWORD } });
  await h.close();
  h = undefined;
  const raw = new Db(file);
  // One in-progress activation's stored secret is damaged.
  const row = raw.get<{ key: string; data: string }>('SELECT key, data FROM activations LIMIT 1') as { key: string; data: string };
  const damaged = row.data.replace(/("pendingTotpSecret":"gcm1:[^:]+:[^:]+:.{5})(.)/, (_all, head: string, char: string) => `${head}${char === 'A' ? 'B' : 'A'}`);
  assert.notEqual(damaged, row.data);
  raw.run('UPDATE activations SET data = ? WHERE key = ?', damaged, row.key);
  const state = () => JSON.stringify([raw.all('SELECT id, totp_secret FROM users ORDER BY id'), raw.all('SELECT * FROM meta ORDER BY key'), raw.all('SELECT * FROM audit_head'), raw.all('SELECT key, data FROM activations ORDER BY key')]);
  const before = state();
  const env = { PATH: process.env.PATH ?? '', DATABASE_PATH: file, DATA_ENCRYPTION_KEY: OTHER_KEY, DATA_ENCRYPTION_KEY_PREVIOUS: TEST_DATA_KEY };
  const rotate = spawnSync(tsx, ['src/cli/db.ts', 'rotate-key'], { cwd: serverDir, env, encoding: 'utf8' });
  assert.equal(rotate.status, 1, rotate.stdout);
  assert.match(rotate.stderr, new RegExp(`The secret in table activations, row ${row.key}, could not be decrypted[^]*Nothing was changed`));
  // Amira's key was NOT left re-encrypted under the new key while the rest stayed under the old one.
  assert.equal(state(), before);
  raw.close();
  const stores = createSqliteStores({ path: file, keys });
  assert.equal(stores.verifyAudit().ok, true);
  stores.close();
});

test('L8: audit:verify, audit:checkpoint and db:backup open the database read-only: they do not upgrade it, mark it or write to it', async () => {
  const stores = createSqliteStores({ path: file, keys, mode: 'strict' });
  await stores.audit.append(system('event.1'));
  stores.close();
  const digest = () => createHash('sha256').update(readFileSync(file)).digest('hex');
  const before = digest();
  const env = { PATH: process.env.PATH ?? '', DATABASE_PATH: file, DATA_ENCRYPTION_KEY: TEST_DATA_KEY };
  for (const args of [['audit-verify'], ['audit-checkpoint', path.join(folder, 'cp.json')], ['backup', path.join(folder, 'b.sqlite')], ['audit-verify', '--checkpoint', path.join(folder, 'cp.json')]]) {
    const run = spawnSync(tsx, ['src/cli/db.ts', ...args], { cwd: serverDir, env, encoding: 'utf8' });
    assert.equal(run.status, 0, `${args.join(' ')}: ${run.stderr}`);
  }
  assert.equal(digest(), before);
  // A read-only connection really cannot write.
  const readOnly = createSqliteStores({ path: file, keys, readOnly: true });
  assert.throws(() => readOnly.db.run("INSERT INTO meta (key, value) VALUES ('x', 'y')"), /readonly|read-only/i);
  await assert.rejects(async () => readOnly.audit.append(system('event.2')), /readonly|read-only/i);
  readOnly.close();
  // A database from the previous version is NOT upgraded by a command: that is the server's job, at its next start.
  asSchema3(file);
  for (const args of [['audit-verify'], ['backup', path.join(folder, 'old.sqlite')]]) {
    const run = spawnSync(tsx, ['src/cli/db.ts', ...args], { cwd: serverDir, env, encoding: 'utf8' });
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /schema version 3 and this version of the commands needs \d+\. Start the server once/);
  }
  const old = new Db(file, MIGRATIONS.slice(0, 3));
  assert.equal(old.schemaVersion(), 3);
  old.close();
});

test('L6: "last seen" is written at most once a minute per session, and reads are limited per session', async () => {
  h = await harness({ readRequestsPerMinute: 5 }, undefined, { databasePath: file });
  const amira = await h.activate(AMIRA);
  const token = (await h.login(AMIRA, amira.secret)).json.token as string;
  const seen = () => (JSON.parse((h as Harness).stores.db.get<{ data: string }>('SELECT data FROM sessions')?.data ?? '{}') as { lastSeenAt: number }).lastSeenAt;
  const first = seen();
  h.clock.advance(20_000);
  assert.equal((await h.call('GET', '/v1/balances', { token })).status, 200);
  h.clock.advance(20_000);
  assert.equal((await h.call('GET', '/v1/balances', { token })).status, 200);
  assert.equal(seen(), first, 'two requests within the minute: no write');
  h.clock.advance(21_000);
  assert.equal((await h.call('GET', '/v1/balances', { token })).status, 200);
  assert.equal(seen(), first + 61_000);
  // Reads: five a minute here. The sixth is refused, for this session only, and the limit lifts with time.
  const other = (await h.login(AMIRA, amira.secret)).json.token as string;
  const statuses: number[] = [];
  h.clock.advance(61_000);
  for (let n = 0; n < 7; n += 1) statuses.push((await h.call('GET', '/v1/balances', { token })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal((await h.call('GET', '/v1/balances', { token: other })).status, 200);
  h.clock.advance(61_000);
  assert.equal((await h.call('GET', '/v1/balances', { token })).status, 200);
});

// --- Audit of 2ac6785 ---------------------------------------------------------------------------------

test('N7: anything added to the database that could hide or drop audit entries is found by verify and at start-up, and an entry the database did not really store refuses the action', async () => {
  await withHistory();
  const additions: [string, string, RegExp][] = [
    ['a trigger that silently drops chosen entries', "CREATE TRIGGER quiet BEFORE INSERT ON audit_log WHEN NEW.action LIKE 'event.%' BEGIN SELECT RAISE(IGNORE); END", /contains a trigger quiet that this server did not create/],
    ['a trigger that keeps the end of the log from moving', 'CREATE TRIGGER still BEFORE UPDATE ON audit_head BEGIN SELECT RAISE(IGNORE); END', /trigger still/],
    ['a trigger on another table altogether', 'CREATE TRIGGER elsewhere AFTER INSERT ON users BEGIN DELETE FROM sessions; END', /trigger elsewhere/],
    ['a trigger on the markers', 'CREATE TRIGGER marks BEFORE UPDATE ON meta BEGIN SELECT RAISE(IGNORE); END', /trigger marks/],
    ['a view', 'CREATE VIEW recent AS SELECT * FROM audit_log', /view recent/],
    ['a view with a trigger that swallows writes', 'CREATE VIEW audit_sink AS SELECT * FROM audit_log; CREATE TRIGGER sink INSTEAD OF INSERT ON audit_sink BEGIN SELECT 1; END', /trigger sink|view audit_sink/],
    ['an index on the log', 'CREATE UNIQUE INDEX one_action ON audit_log (action)', /index one_action/],
    ['a column added to the log', "ALTER TABLE audit_log ADD COLUMN hidden TEXT GENERATED ALWAYS AS ('x') VIRTUAL", /table audit_log, which is part of how the audit log is protected, has been altered/],
    ['a trigger replaced by one of the same name on another table', 'DROP TRIGGER audit_archive_no_delete; CREATE TRIGGER audit_archive_no_delete BEFORE DELETE ON sessions BEGIN SELECT 1; END', /trigger audit_archive_no_delete, which is part of how the audit log is protected, has been altered/],
  ];
  const pristine = path.join(folder, 'pristine.sqlite');
  const first = new Db(file);
  first.backupTo(pristine);
  first.close();
  for (const [what, sql, problem] of additions) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
    const copy = new Db(pristine);
    copy.backupTo(file);
    copy.close();
    // A server is running on the database when the change is made...
    const running = createSqliteStores({ path: file, keys });
    const before = running.verifyAudit().entries;
    const other = new Db(file);
    other.exec(sql);
    other.close();
    // ...and the check that the audit command runs finds it, with or without any entry having been touched.
    assert.match(running.verifyAudit().problem ?? '', problem, what);
    running.close();
    assert.throws(() => createSqliteStores({ path: file, keys }), problem, `${what}: refused at start-up`);
    const cli = spawnSync(tsx, ['src/cli/db.ts', 'audit-verify'], { cwd: serverDir, env: { PATH: process.env.PATH ?? '', DATABASE_PATH: file, DATA_ENCRYPTION_KEY: TEST_DATA_KEY }, encoding: 'utf8' });
    assert.equal(cli.status, 1, what);
    assert.match(cli.stderr, problem, what);
    void before;
  }

  // The two that make the server lose entries without an error from the database: the write itself notices, and
  // refuses whatever was being recorded, in the same transaction.
  for (const sql of [additions[0]?.[1] as string, additions[1]?.[1] as string]) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
    const copy = new Db(pristine);
    copy.backupTo(file);
    copy.close();
    const running = createSqliteStores({ path: file, keys });
    const state = () => JSON.stringify([running.db.all('SELECT seq, hash FROM audit_log ORDER BY seq'), running.db.all('SELECT * FROM audit_head'), running.db.get("SELECT approvals_required FROM companies WHERE id = 'co_northfield'")]);
    const before = state();
    const other = new Db(file);
    other.exec(sql);
    other.close();
    await assert.rejects(async () => running.audit.append(system('event.lost', 99)), /audit log cannot be written to, so the action was refused and nothing was recorded[^]*did not store/);
    // A change that carries its audit entry is not made either.
    await assert.rejects(async () => running.directory.updateCompany('co_northfield', (current) => ({ ...current, approvalsRequired: 2 }), () => system('event.rule', 99)), /audit log cannot be written to/);
    assert.equal(state(), before);
    running.close();
  }
});

test('N6: entries moved to the archive by anyone but the server are found, the console reads both tables as one log, and says how many are archived', async () => {
  const { entries } = await withHistory();
  // Allowed by the triggers (a copy exists, so the delete passes), and it used to hide the entries from the console.
  const mover = new Db(file);
  const FIELDS = 'seq, id, at, actor_type, actor_id, actor_label, target_type, target_id, target_label, action, outcome, source, detail, prev_hash, hash, key_id';
  mover.exec(`INSERT INTO audit_archive (${FIELDS}, archived_at) SELECT ${FIELDS}, 1 FROM audit_log WHERE seq < ${entries}; DELETE FROM audit_log WHERE seq < ${entries};`);
  mover.close();
  const moved = /Entries have been moved between the live log and the archive by something other than this server \(the archive reaches entry \d+; the server archived up to entry 0\)/;
  assert.throws(() => createSqliteStores({ path: file, keys }), moved);
  const readOnly = createSqliteStores({ path: file, keys, readOnly: true });
  assert.match(readOnly.verifyAudit().problem ?? '', moved);
  // Even so, nothing has left the view: whoever reads the log reads all of it.
  assert.equal((await readOnly.audit.query({ limit: 10_000 })).length, entries);
  assert.deepEqual(readOnly.audit.counts(), { live: 1, archived: entries - 1 });
  readOnly.close();
  // The same the other way round: an archived entry put back in the live table.
  const stores = createSqliteStores({ path: path.join(folder, 'b.sqlite'), keys, audit: { liveLimit: 4, notice: () => {} } });
  for (let n = 1; n <= 9; n += 1) await stores.audit.append(system(`event.${n}`, n));
  assert.equal(stores.verifyAudit().ok, true);
  const { archived } = stores.audit.counts();
  assert.ok(archived > 0);
  // Searching finds archived entries like any other.
  assert.deepEqual((await stores.audit.query({ action: 'event.1' })).map((entry) => entry.action), ['event.1']);
  stores.db.exec(`INSERT INTO audit_log (${FIELDS}) SELECT ${FIELDS} FROM audit_archive WHERE seq = ${archived}`);
  assert.match(stores.verifyAudit().problem ?? '', /Entry \d+ is missing|moved between the live log and the archive|does not follow/);
  stores.close();

  // The console says how many entries there are and how many of them are archived.
  h = await harness({}, undefined, { audit: { liveLimit: 4 } });
  for (let n = 1; n <= 9; n += 1) await h.stores.audit.append(system(`event.${n}`, n));
  const total = h.stores.audit.counts();
  assert.match(readFileSync(path.join(serverDir, 'src', 'ops', 'console.ts'), 'utf8'), /The log holds \$\{String\(held\.live \+ held\.archived\)\}[^`]*of the oldest are in the archive, and are searched and shown here like the rest/);
  assert.ok(total.archived > 0 && total.live + total.archived === 9);
});

test('N9: key rotation and re-sealing need the database to themselves; a server that cannot vouch for the end of its log writes nothing; the key holder can recover, on record', async () => {
  const config = { ...loadConfig({ APP_ENV: 'development' }), databasePath: file, dataEncryptionKey: TEST_DATA_KEY };
  const running = createRuntime(config);
  await running.stores.audit.append(system('event.1'));
  const env = { PATH: process.env.PATH ?? '', DATABASE_PATH: file, DATA_ENCRYPTION_KEY: OTHER_KEY, DATA_ENCRYPTION_KEY_PREVIOUS: TEST_DATA_KEY };
  const cli = (command: string, with_: Record<string, string> = env) => spawnSync(tsx, ['src/cli/db.ts', command], { cwd: serverDir, env: with_, encoding: 'utf8' });
  // Beside a running server both are refused, and nothing is changed.
  const before = running.stores.db.get<{ mac: string }>('SELECT mac FROM audit_head')?.mac;
  for (const command of ['rotate-key', 'audit-reseal']) {
    const refused = cli(command);
    assert.equal(refused.status, 2, command);
    assert.match(refused.stderr, /The server is running on .*data\.sqlite\. Stop it first/, command);
  }
  assert.equal(running.stores.db.get<{ mac: string }>('SELECT mac FROM audit_head')?.mac, before);
  // The read-only commands still run beside it.
  assert.equal(cli('audit-verify').status, 0);

  // What a rotation beside a running server used to do, forced here through the store: the end of the log is now
  // signed with a key the running server does not have. It must not write an unsigned end over it: it writes nothing.
  const rotating = createSqliteStores({ path: file, keys: dataKeys(OTHER_KEY, [TEST_DATA_KEY]) });
  rotating.rotateKeys();
  rotating.close();
  await assert.rejects(async () => running.stores.audit.append(system('event.2')), /audit log cannot be written to[^]*signed with a key this server was not given/);
  // (Everything keyed followed the rotation: the new key alone opens the database, the old one alone no longer does.)
  createSqliteStores({ path: file, keys: dataKeys(OTHER_KEY) }).close();
  assert.throws(() => createSqliteStores({ path: file, keys }), /not the key this database was written with/);
  running.stores.close();
  // Restarted with the new key (the documented order), everything is as it was left: the log verifies and goes on.
  const restarted = createRuntime({ ...config, dataEncryptionKey: OTHER_KEY, previousDataEncryptionKeys: [TEST_DATA_KEY] });
  await restarted.stores.audit.append(system('event.3'));
  assert.deepEqual([restarted.stores.verifyAudit().ok, restarted.stores.verifyAudit().entries], [true, 2]);
  restarted.stores.close();
  // With the server stopped the command works, and the state record follows the key.
  assert.equal(cli('rotate-key', { ...env, DATA_ENCRYPTION_KEY: TEST_DATA_KEY, DATA_ENCRYPTION_KEY_PREVIOUS: OTHER_KEY }).status, 0);
  createSqliteStores({ path: file, keys, mode: 'development' }).close();

  // An end that was left unsigned (by the version before this one, in exactly that situation): the server refuses
  // to start, the key holder accepts the log as it stands, and the log says so.
  const raw = new Db(file);
  raw.exec('UPDATE audit_head SET mac = NULL, count = NULL, key_id = NULL');
  raw.close();
  assert.throws(() => createRuntime({ ...config, previousDataEncryptionKeys: [OTHER_KEY] }), /end of the log is not signed[^]*npm run audit:reseal/);
  const plain = { PATH: process.env.PATH ?? '', DATABASE_PATH: file, DATA_ENCRYPTION_KEY: TEST_DATA_KEY, DATA_ENCRYPTION_KEY_PREVIOUS: OTHER_KEY };
  const both = { ...config, previousDataEncryptionKeys: [OTHER_KEY] };
  assert.equal(cli('audit-verify', plain).status, 1);
  // Without the key nobody can do it.
  assert.notEqual(cli('audit-reseal', { PATH: plain.PATH, DATABASE_PATH: file, DATA_ENCRYPTION_KEY: OTHER_KEY }).status, 0);
  const resealed = cli('audit-reseal', plain);
  assert.equal(resealed.status, 0, resealed.stderr);
  const after = createRuntime(both);
  const record = (await after.stores.audit.query({ limit: 1 }))[0];
  assert.deepEqual([record?.action, record?.detail.entries, record?.detail.recordedEnd], ['system.audit.resealed', '2', 'entry 2 (unsigned)']);
  assert.equal(after.stores.verifyAudit().ok, true);
  after.stores.close();
});

test('N8: a stored secret whose authentication tag was shortened is refused', async () => {
  const sealed = seal(keys, 'JBSWY3DPEHPK3PXP', 'users:usr_x:totp').text;
  assert.equal(open(keys, sealed, 'users:usr_x:totp'), 'JBSWY3DPEHPK3PXP');
  const parts = sealed.split(':');
  const tag = Buffer.from(parts[4] as string, 'base64');
  assert.equal(tag.length, 16);
  for (const length of [4, 8, 12, 13, 15]) {
    const cut = [...parts.slice(0, 4), tag.subarray(0, length).toString('base64')].join(':');
    assert.throws(() => open(keys, cut, 'users:usr_x:totp'), /not in the expected encrypted form/, `${length} bytes`);
  }
  assert.throws(() => open(keys, [...parts.slice(0, 4), Buffer.concat([tag, Buffer.alloc(1)]).toString('base64')].join(':'), 'users:usr_x:totp'));
  // In the database: a row edited that way does not give up its key.
  const { secret } = await withHistory();
  const stores = createSqliteStores({ path: file, keys });
  const stored = stores.db.get<{ totp_secret: string }>("SELECT totp_secret FROM users WHERE id = 'usr_amira'")?.totp_secret as string;
  const pieces = stored.split(':');
  stores.db.run("UPDATE users SET totp_secret = ? WHERE id = 'usr_amira'", [...pieces.slice(0, 4), Buffer.from(pieces[4] as string, 'base64').subarray(0, 13).toString('base64')].join(':'));
  await assert.rejects(async () => (await stores.directory.getUser('usr_amira'))?.totpSecret, /not in the expected encrypted form/);
  stores.db.run("UPDATE users SET totp_secret = ? WHERE id = 'usr_amira'", stored);
  assert.equal((await stores.directory.getUser('usr_amira'))?.totpSecret, secret);
  stores.close();
});

test('N4: the one-server lock belongs to the database file, not to the path it was reached by, and a server whose lock file disappears stops', async () => {
  const config = { ...loadConfig({ APP_ENV: 'development' }), databasePath: file };
  const first = createRuntime(config);
  // The same file through a symlink to it, through a symlinked folder, and through a path with dots in it.
  const link = path.join(folder, 'link.sqlite');
  symlinkSync(file, link);
  writeFileSync(`${link}.dev-key`, readFileSync(`${file}.dev-key`), { mode: 0o600 });
  const side = mkdtempSync(path.join(tmpdir(), 'gc-side-'));
  try {
    symlinkSync(folder, path.join(side, 'data'));
    for (const other of [link, path.join(side, 'data', 'data.sqlite'), path.join(folder, '.', 'nested', '..', 'data.sqlite')]) {
      assert.throws(() => createRuntime({ ...config, databasePath: other }), /Another Global Connect server process is already running/, other);
    }
    assert.deepEqual(readdirSync(folder).filter((name) => name.endsWith('.lock')), ['data.sqlite.lock'], 'one lock file, beside the real database');
  } finally {
    rmSync(side, { recursive: true, force: true });
  }
  first.stores.close();

  // The lock file removed, or replaced by another, while a server holds it: that server is told within seconds
  // (and, running for real, exits), so a second one that took the new file is not left sharing the database.
  for (const replace of [false, true]) {
    let message = '';
    const unlock = lockForServer(file, (text) => (message = text));
    rmSync(`${file}.lock`);
    if (replace) writeFileSync(`${file}.lock`, '', { mode: 0o600 });
    for (let waited = 0; !message && waited < 2 * LOCK_WATCH_MS; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(message, /lock file .*data\.sqlite\.lock was removed or replaced while the server was running\. The server is stopping/, String(replace));
    unlock();
    rmSync(`${file}.lock`, { force: true });
  }
  // Left alone, it says nothing.
  let spoke = false;
  const unlock = lockForServer(file, () => (spoke = true));
  await new Promise((resolve) => setTimeout(resolve, LOCK_WATCH_MS + 300));
  assert.equal(spoke, false);
  unlock();
  // By default a lost lock ends the process.
  assert.match(readFileSync(path.join(serverDir, 'src', 'store', 'sqlite', 'db.ts'), 'utf8'), /console\.error\(message\);\s+process\.exit\(1\);/);
});

test('M5: any permission at all for group or others is refused, on the write-ahead files, the key file and the lock as well, and in the real folder of a symlinked path', async () => {
  const config = { ...loadConfig({ APP_ENV: 'development' }), databasePath: file };
  const running = createRuntime(config);
  await running.stores.audit.append(system('event.1'));
  // While it runs the write-ahead files exist.
  const refusal = (target: string, mode: number) => new RegExp(`${target.replace(/[.]/g, '\\.')} can be read or changed by other users of this machine \\(its permissions are ${mode.toString(8)}`);
  for (const suffix of ['-wal', '-shm']) {
    assert.ok(existsSync(`${file}${suffix}`), suffix);
    chmodSync(`${file}${suffix}`, 0o666);
    assert.throws(() => createSqliteStores({ path: file, keys: keysFor(config), readOnly: true }), refusal(`${file}${suffix}`, 0o666));
    chmodSync(`${file}${suffix}`, 0o600);
  }
  running.stores.close();
  // Others only, group only, read only, write only, execute only: each is refused, on every file that matters.
  for (const suffix of ['', '.dev-key', '.lock']) {
    for (const mode of [0o604, 0o640, 0o602, 0o620, 0o601, 0o610, 0o644, 0o666]) {
      chmodSync(`${file}${suffix}`, mode);
      assert.throws(() => createRuntime(config), refusal(`${file}${suffix}`, mode), `${suffix} ${mode.toString(8)}`);
      chmodSync(`${file}${suffix}`, 0o600);
    }
  }
  for (const mode of [0o701, 0o710, 0o705, 0o750]) {
    chmodSync(folder, mode);
    assert.throws(() => createRuntime(config), refusal(folder, mode), mode.toString(8));
    chmodSync(folder, 0o700);
  }
  // A private folder holding only a symlink to a database that sits in a folder others can read.
  const shared = path.join(folder, 'shared');
  mkdirSync(shared, { mode: 0o700 });
  const real = path.join(shared, 'real.sqlite');
  createSqliteStores({ path: real, keys }).close();
  const linked = path.join(folder, 'linked.sqlite');
  symlinkSync(real, linked);
  createSqliteStores({ path: linked, keys }).close();
  chmodSync(shared, 0o755);
  assert.throws(() => createSqliteStores({ path: linked, keys }), refusal(shared, 0o755));
  chmodSync(shared, 0o700);
  chmodSync(real, 0o640);
  assert.throws(() => createSqliteStores({ path: linked, keys }), /can be read or changed by other users of this machine \(its permissions are 640/);
});

test('upgrade from a REAL schema-5 database (built by commit 50c4112, kept in test/support): every later migration applies, nothing is lost, the log still verifies', async () => {
  // The fixture was made by running that commit's server in development mode with the test key and sending two activation links.
  const fixture = path.join(serverDir, 'test', 'support', 'schema5-50c4112.sqlite');
  writeFileSync(file, readFileSync(fixture), { mode: 0o600 });
  assert.equal(versionOf(file), 5);
  const before = new DatabaseSync(file, { readOnly: true });
  const users = before.prepare('SELECT id, email FROM users ORDER BY id').all();
  const logged = (before.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
  before.close();
  assert.equal(logged, 2);
  // Not outside development: it is a development database, and says so in its signed state.
  assert.throws(() => createSqliteStores({ path: file, keys, mode: 'strict' }), /has been used in development mode/);
  assert.equal(versionOf(file), 5, 'a refused open runs no migration');
  const stores = createSqliteStores({ path: file, keys, mode: 'development' });
  assert.equal(stores.db.schemaVersion(), MIGRATIONS.length);
  assert.ok(MIGRATIONS.length > 5);
  assert.deepEqual(stores.verifyAudit(), { ok: true, entries: 2, archived: 0, problem: null });
  assert.deepEqual(stores.db.all('SELECT id, email FROM users ORDER BY id'), users);
  assert.equal((await stores.directory.listCompanies()).length, 2);
  // What the later migrations added is there and empty.
  assert.deepEqual(await stores.mail.list(), []);
  await stores.audit.append(system('event.after'));
  assert.equal(stores.verifyAudit().entries, 3);
  stores.close();
  // And it opens again as it is, with the commands too.
  createSqliteStores({ path: file, keys, mode: 'development' }).close();
  const verify = spawnSync(tsx, ['src/cli/db.ts', 'audit-verify'], { cwd: serverDir, env: { PATH: process.env.PATH ?? '', DATABASE_PATH: file, DATA_ENCRYPTION_KEY: TEST_DATA_KEY }, encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr);
});
