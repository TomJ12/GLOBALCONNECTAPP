/**
 * npm run create-ops-admin -- <email> "<name>"
 *
 * Asks the RUNNING server to create an ops admin and email them an activation
 * link (in development mode the email is printed in the server console). The
 * link is not printed here. Works only while fewer than two active ops admins
 * exist (staff management needs one ops admin to ask and another to approve);
 * after that staff are invited from the ops console. The address must be at a
 * domain in STAFF_EMAIL_DOMAINS. Talks to the server's loopback-only operator port and
 * needs ADMIN_TOKEN (the same value the server was started with).
 */
export {};

const [email, name] = process.argv.slice(2);
const token = process.env.ADMIN_TOKEN;
const server = process.env.ADMIN_URL ?? `http://127.0.0.1:${process.env.ADMIN_PORT ?? 3002}`;

if (!email || !name) {
  console.error('Usage: npm run create-ops-admin -- <email> "<name>"');
  process.exit(2);
}
if (!token) {
  console.error('Set ADMIN_TOKEN in server/.env for both the server and this command (openssl rand -base64 32).');
  process.exit(2);
}

try {
  const response = await fetch(`${server}/admin/ops-admins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ email, name }),
  });
  if (!response.ok) {
    const reasons: Record<number, string> = {
      400: 'The email or name was not accepted.',
      403: 'Refused. Either two active ops admins already exist (invite further staff from the ops console), or the address is not at a domain in STAFF_EMAIL_DOMAINS, or it belongs to an existing staff account.',
      404: 'ADMIN_TOKEN does not match the server.',
    };
    console.error(reasons[response.status] ?? `The server answered ${response.status}.`);
    process.exit(1);
  }
  const sent = (await response.json()) as { sentTo: string; expiresAt: string };
  console.log(`Activation email sent to ${sent.sentTo}`);
  console.log(`Expires: ${sent.expiresAt}`);
  console.log('(In development mode the email is printed in the server console.)');
} catch {
  console.error(`Could not reach the operator port at ${server}. Is the server running with ADMIN_TOKEN set, on this machine?`);
  process.exit(1);
}
