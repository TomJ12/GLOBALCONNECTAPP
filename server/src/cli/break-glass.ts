/**
 * npm run break-glass -- <disable-staff|reset-staff|unlock-staff> <email> "<reason>"
 *
 * For when the ops console cannot help (staff who would have to approve each
 * other, a lost authenticator, a locked-out or compromised staff member).
 * Acts on ONE staff account without a second person:
 *
 *   disable-staff  the account is disabled and its sessions end
 *   reset-staff    password, authenticator and recovery codes are removed,
 *                  sessions end, and a new activation link is emailed to them
 *   unlock-staff   failed sign-in counters are cleared
 *
 * It talks to the server's loopback-only operator port, needs ADMIN_TOKEN and
 * a reason, and is written to the audit log, highlighted.
 */
export {};

const [action, email, reason] = process.argv.slice(2);
const token = process.env.ADMIN_TOKEN;
const server = process.env.ADMIN_URL ?? `http://127.0.0.1:${process.env.ADMIN_PORT ?? 3002}`;

if (!action || !email || !reason) {
  console.error('Usage: npm run break-glass -- <disable-staff|reset-staff|unlock-staff> <email> "<reason, at least 10 characters>"');
  process.exit(2);
}
if (!token) {
  console.error('Set ADMIN_TOKEN in server/.env for both the server and this command (openssl rand -base64 32).');
  process.exit(2);
}

try {
  const response = await fetch(`${server}/admin/break-glass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, email, reason }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { fields?: string[] } } | null;
    const field = body?.error?.fields?.[0];
    const reasons: Record<number, string> = {
      400: field === 'reason' ? 'Give a reason of 10 to 500 characters.' : field === 'action' ? 'The action must be disable-staff, reset-staff or unlock-staff.' : 'Not done: that account is disabled (a disabled account cannot be reset).',
      404: 'No staff account with that email, or ADMIN_TOKEN does not match the server.',
    };
    console.error(reasons[response.status] ?? `The server answered ${response.status}.`);
    process.exit(1);
  }
  const done = (await response.json()) as { done: string; staff: string; expiresAt?: string };
  console.log(`Done: ${done.staff} ${done.done}.${done.expiresAt ? ` A new activation email was sent; it expires ${done.expiresAt}.` : ''}`);
  console.log('This has been written to the audit log with your reason.');
} catch {
  console.error(`Could not reach the operator port at ${server}. Is the server running with ADMIN_TOKEN set, on this machine?`);
  process.exit(1);
}
