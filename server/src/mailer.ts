/**
 * Delivery of activation links. A link is only ever sent to the email address
 * on file for the account; it is never shown to staff or returned over HTTP.
 *
 * There is NO real mailer in this repository. In explicit development mode
 * the "email" is printed to the server console (the outbox below), which is
 * how the demo is used. Outside development the server refuses to start
 * until a real implementation of `Mailer` is supplied (see startup.ts).
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** DEVELOPMENT ONLY: prints each message to the server console and remembers the last few. */
export class ConsoleOutbox implements Mailer {
  readonly sent: MailMessage[] = [];
  constructor(private readonly print: (text: string) => void = console.log) {}

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    if (this.sent.length > 200) this.sent.shift();
    this.print(['', '--- DEVELOPMENT OUTBOX: this email was NOT sent anywhere ---', `To: ${message.to}`, `Subject: ${message.subject}`, '', message.text, '---', ''].join('\n'));
  }
}

/** `a…@domain`: enough for staff to recognise the address, not enough to learn it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 1 ? '…' : `${email[0]}…${email.slice(at)}`;
}

export function activationMessage(invite: { activationLink: string; expiresAt: number }, to: string, name: string, kind: 'client' | 'staff'): MailMessage {
  return {
    to,
    subject: kind === 'staff' ? 'Activate your Global Connect staff account' : 'Activate your Global Connect account',
    text: [
      `Hello ${name},`,
      '',
      'Use this link to set your password and add your authenticator app:',
      invite.activationLink,
      '',
      `The link works once and expires ${new Date(invite.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC. Any earlier link no longer works.`,
      'If you were not expecting this, do not use the link and tell Global Connect.',
    ].join('\n'),
  };
}
