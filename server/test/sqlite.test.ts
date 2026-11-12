/** The SQLite store itself: migrations, transactions under a crash and under real concurrency, encryption at rest, the audit chain, restarts. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config';
import { MINIMUM_NODE, nodeVersionProblem } from '../src/nodeVersion';
import { createRuntime, keysFor } from '../src/startup';
import { seedDirectory } from '../src/store/seed';
import { createSqliteStores } from '../src/store/sqlite';
import { Db } from '../src/store/sqlite/db';
import { dataKeys, newDataKey } from '../src/store/sqlite/keys';
import { MIGRATIONS } from '../src/store/sqlite/migrations';
import { AMIRA, BEN, harness, PASSWORD, TEST_DATA_KEY, type Harness } from './helpers';

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
  await assert.rejects(moved.directory.getUser('usr_dana'));
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

  // Someone with the FILE can drop the triggers. What they change is then found by the chain.
  const backup = path.join(folder, 'copy.sqlite');
  const tamper = (sql: string) => {
    rmSync(backup, { force: true });
    const db = new Db(file);
    db.backupTo(backup);
    db.close();
    const copy = new Db(backup);
    copy.exec('DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete; DROP TRIGGER audit_archive_no_update; DROP TRIGGER audit_archive_no_delete;');
    copy.exec(sql);
    copy.close();
    const result = createSqliteStores({ path: backup, keys });
    const verdict = result.verifyAudit();
    result.close();
    return verdict;
  };
  assert.equal(tamper('SELECT 1').ok, true, 'the copy itself verifies');
  assert.match(tamper(`UPDATE audit_log SET detail = '{"note":"y"}' WHERE action = 'event.9'`).problem ?? '', /event\.9\) has been changed since it was written/);
  assert.match(tamper(`UPDATE audit_archive SET actor_label = 'someone else' WHERE action = 'event.2'`).problem ?? '', /event\.2\) has been changed/);
  assert.match(tamper(`DELETE FROM audit_log WHERE action = 'event.9'`).problem ?? '', /Entry 9 is missing/);
  assert.match(tamper(`DELETE FROM audit_log WHERE action = 'event.10'`).problem ?? '', /the newest entries have been removed/);
  assert.match(tamper(`UPDATE audit_log SET at = at + 1 WHERE action = 'event.8'`).problem ?? '', /event\.8\) has been changed/);

  // The command itself fails, loudly, on the real file once it has been altered.
  const db = new Db(file);
  db.exec(`DROP TRIGGER audit_log_no_update; UPDATE audit_log SET outcome = 'failure' WHERE action = 'event.7'`);
  db.close();
  const found = cli();
  assert.equal(found.status, 1);
  assert.match(found.stderr, /AUDIT LOG VERIFICATION FAILED after 6 good entries[^]*event\.7\) has been changed/);
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
