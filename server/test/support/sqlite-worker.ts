/**
 * A second (third...) process with its own connection to the same database
 * file, for the concurrency and crash tests. Node's SQLite calls are
 * synchronous, so two connections in ONE process never truly overlap; two
 * processes do.
 *
 *   tsx sqlite-worker.ts <database> <key> <mode> <name> <count> <go-file>
 *
 * Prints "ready", waits for <go-file> to exist (so every worker starts
 * together), does its work and prints one JSON line with what it won.
 */
import { existsSync } from 'node:fs';

import { createSqliteStores } from '../../src/store/sqlite';
import { dataKeys } from '../../src/store/sqlite/keys';

const [file, key, mode, name, countText, goFile] = process.argv.slice(2) as [string, string, string, string, string, string];
const count = Number(countText);
const stores = createSqliteStores({ path: file, keys: dataKeys(key) });
const won: number[] = [];

if (mode === 'crash') {
  // Whole transactions, each writing to two tables and the audit log; then one that is killed half-way.
  for (let n = 1; n <= count + 1; n += 1) {
    stores.db.tx(() => {
      void stores.auth.sessions.put(`s${n}`, { id: `s${n}`, userId: 'usr_amira', companyId: null, createdAt: n, lastSeenAt: n });
      if (n === count + 1) process.kill(process.pid, 'SIGKILL');
      void stores.providerKeys.put(`k${n}`, { orderId: `o${n}`, createdAt: n });
      void stores.audit.append({ at: n, actor: { type: 'system', id: null, label: 'worker' }, target: null, action: `crash.${n}`, outcome: 'success', source: '', detail: {} });
    });
  }
  // Not reached: SIGKILL cannot be caught.
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

console.log('ready');
while (!existsSync(goFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);

const pause = new Int32Array(new SharedArrayBuffer(4));
for (let n = 0; n < count; n += 1) {
  // A waiting SQLite connection sleeps a millisecond or more before it tries again, so a worker that never
  // paused would do all its work before the others got a turn. A short pause lets them interleave.
  Atomics.wait(pause, 0, 0, 1 + Math.random());
  if (mode === 'count') {
    // Attempt counting: read, add one, write.
    await stores.auth.attempts.mutate('counter', (current) => ({ failures: (current?.failures ?? 0) + 1, lockedUntil: 0, locks: 0, subject: 's', updatedAt: n }));
  } else if (mode === 'invitation') {
    // The invitation compare-and-swap: a password is set only on an invitation that has none.
    const saved = await stores.auth.activations.mutate(`inv${n}`, (current) => (current && current.pendingPasswordHash === null ? { ...current, pendingPasswordHash: name } : undefined));
    if (saved?.pendingPasswordHash === name) won.push(n);
  } else if (mode === 'activate') {
    if (await stores.auth.activations.take(`inv${n}`)) won.push(n);
  } else if (mode === 'stepup') {
    if (await stores.auth.stepUps.take(`su${n}`)) won.push(n);
  } else if (mode === 'revoke') {
    if (await stores.auth.sessions.take(`sess${n}`)) won.push(n);
  } else if (mode === 'totp') {
    // A code's 30-second step is accepted only if it is later than the last one used.
    if (await stores.directory.updateUser('usr_amira', (user) => (user.lastTotpStep < n + 1 ? { ...user, lastTotpStep: n + 1 } : null))) won.push(n);
  } else if (mode === 'recovery') {
    const hash = `hash${n}`;
    if (await stores.directory.updateUser('usr_amira', (user) => (user.recoveryCodeHashes.includes(hash) ? { ...user, recoveryCodeHashes: user.recoveryCodeHashes.filter((item) => item !== hash) } : null))) won.push(n);
  } else if (mode === 'decide') {
    const saved = await stores.ops.approvals.mutate(`req${n}`, (current) => (current && current.status === 'pending' ? { ...current, status: 'approved', decidedBy: { id: name, email: name }, decidedAt: 1 } : undefined));
    if (saved?.decidedBy?.id === name) won.push(n);
  } else if (mode === 'audit') {
    await stores.audit.append({ at: n, actor: { type: 'system', id: null, label: name }, target: null, action: `race.${name}.${n}`, outcome: 'success', source: '', detail: {} });
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
}
stores.close();
console.log(JSON.stringify({ name, won }));
