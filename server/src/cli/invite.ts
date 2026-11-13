/**
 * npm run invite -- <email>
 *
 * Asks the RUNNING server to email a new activation link to someone already
 * in the directory. The link is not printed here: it goes to the address on
 * file (in development mode, to the server's console outbox). Talks to the
 * server's loopback-only operator port and needs ADMIN_TOKEN (the same value
 * the server was started with).
 */
export {};

const email = process.argv[2];
const token = process.env.ADMIN_TOKEN;
const server = process.env.ADMIN_URL ?? `http://127.0.0.1:${process.env.ADMIN_PORT ?? 3002}`;

if (!email) {
  console.error('Usage: npm run invite -- <email>');
  process.exit(2);
}
if (!token) {
  console.error('Set ADMIN_TOKEN in server/.env for both the server and this command (openssl rand -base64 32).');
  process.exit(2);
}

try {
  const response = await fetch(`${server}/admin/invites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ email }),
  });
  if (response.status === 404) {
    console.error('Not found: either that email is not in the directory, or ADMIN_TOKEN does not match the server.');
    process.exit(1);
  }
  if (!response.ok) {
    console.error(response.status === 400 ? 'That account is already activated, or is disabled.' : `The server answered ${response.status}.`);
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
