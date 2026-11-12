/**
 * npm run invite -- <email>
 *
 * Asks the RUNNING server for an activation code for someone already in the
 * directory, and prints it. Stands in for an admin tool and for email
 * delivery. Needs ADMIN_TOKEN (the same value the server was started with).
 */
export {};

const email = process.argv[2];
const token = process.env.ADMIN_TOKEN;
const server = process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;

if (!email) {
  console.error('Usage: npm run invite -- <email>');
  process.exit(2);
}
if (!token || token.length < 16) {
  console.error('Set ADMIN_TOKEN (16+ characters) in server/.env for both the server and this command.');
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
    console.error(response.status === 400 ? 'That account is already activated.' : `The server answered ${response.status}.`);
    process.exit(1);
  }
  const invite = (await response.json()) as { activationCode: string; activationLink: string; expiresAt: string };
  console.log(`Activation code: ${invite.activationCode}`);
  console.log(`Activation link: ${invite.activationLink}`);
  console.log(`Expires:         ${invite.expiresAt}`);
} catch {
  console.error(`Could not reach the server at ${server}. Is it running?`);
  process.exit(1);
}
