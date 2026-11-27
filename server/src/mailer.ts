/**
 * The wire an email leaves by. A link is only ever sent to the email address
 * on file for the account; it is never shown to staff or returned over HTTP.
 *
 * Two implementations: SMTP (mail/smtp.ts), and, in explicit development mode
 * when no SMTP server is configured, the console outbox below, which prints
 * the "email" to the server console (how the demo is used). Outside
 * development the server refuses to start without a real one (startup.ts).
 * Nothing is sent straight through this interface: every message goes through
 * the queue in mail/queue.ts, written with the wording in mail/templates.ts.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** The same lines as `text`, as simple HTML: no images, nothing loaded from anywhere. */
  html?: string;
  /** Stable for one queued message, so a mail server that receives a retry can recognise it. */
  messageId?: string;
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
