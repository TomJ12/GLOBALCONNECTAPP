/**
 * Sending over SMTP (any email service), through nodemailer (pure JavaScript,
 * no native code). TLS is REQUIRED: either implicit TLS (port 465) or STARTTLS
 * that must succeed before anything is said. The one exception, for tests and
 * for a mail catcher on the developer's own machine, is `tls: 'off'`, which
 * config.ts only accepts in development and only for a loopback host.
 *
 * Nothing about a message is logged here: not its body, not its subject, not
 * its recipient. A failure is reported as a short code.
 */
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import type { MailMessage, Mailer } from '../mailer';

export interface SmtpSettings {
  host: string;
  port: number;
  /** `tls`: TLS from the first byte. `starttls`: upgraded, and refused if the server cannot. `off`: development on loopback only. */
  tls: 'tls' | 'starttls' | 'off';
  username: string | null;
  password: string | null;
  from: string;
  replyTo: string | null;
}

/** A short, bodiless description of why sending failed: an error code and, if the server answered, its reply code. */
export function failureCode(error: unknown): string {
  const item = (error ?? {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof item.code === 'string' && /^[A-Z0-9_]{1,30}$/.test(item.code) ? item.code : 'ERROR';
  return typeof item.responseCode === 'number' ? `${code} ${item.responseCode}` : code;
}

export class SmtpMailer implements Mailer {
  private readonly transport: nodemailer.Transporter;
  constructor(private readonly settings: SmtpSettings) {
    const options: SMTPTransport.Options & { disableFileAccess: boolean; disableUrlAccess: boolean } = {
      host: settings.host,
      port: settings.port,
      secure: settings.tls === 'tls',
      requireTLS: settings.tls === 'starttls',
      ignoreTLS: settings.tls === 'off',
      auth: settings.username ? { user: settings.username, pass: settings.password ?? '' } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      // One connection, one message: nothing is kept open, nothing is pooled.
      // No DNS or address tricks from message content: the envelope is exactly what this server set.
      disableFileAccess: true,
      disableUrlAccess: true,
    };
    this.transport = nodemailer.createTransport(options);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.settings.from,
      replyTo: this.settings.replyTo ?? undefined,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      messageId: message.messageId,
      // No tracking, no receipts, nothing that reports back.
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    });
  }
}
