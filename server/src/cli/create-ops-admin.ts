/**
 * npm run create-ops-admin -- <email> "<name>"
 *
 * Asks the RUNNING server to create the first ops admin and prints the
 * activation link. Needs ADMIN_TOKEN (the same value the server was started
 * with). The server refuses once an active ops admin exists: further staff
 * are invited from the ops console.
 */
export {};

const [email, name] = process.argv.slice(2);
const token = process.env.ADMIN_TOKEN;
const server = process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;

if (!email || !name) {
  console.error('Usage: npm run create-ops-admin -- <email> "<name>"');
  process.exit(2);
}
if (!token || token.length < 16) {
  console.error('Set ADMIN_TOKEN (16+ characters) in server/.env for both the server and this command.');
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
      403: 'An active ops admin already exists (or that email belongs to another staff account). Invite further staff from the ops console.',
      404: 'ADMIN_TOKEN does not match the server, or the server has none set.',
    };
    console.error(reasons[response.status] ?? `The server answered ${response.status}.`);
    process.exit(1);
  }
  const invite = (await response.json()) as { activationCode: string; activationLink: string; expiresAt: string };
  console.log(`Activation link: ${invite.activationLink}`);
  console.log(`Activation code: ${invite.activationCode}`);
  console.log(`Expires:         ${invite.expiresAt}`);
  console.log('Pass the link to that person through an approved channel. It is not emailed.');
} catch {
  console.error(`Could not reach the server at ${server}. Is it running?`);
  process.exit(1);
}
