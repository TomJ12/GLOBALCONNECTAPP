/**
 * EVERY WORD OF EVERY EMAIL THIS SERVER SENDS IS IN THIS FILE, so that it can
 * be read and approved in one place.
 *
 * Rules these templates keep (tests check them):
 *  - the subject line says nothing sensitive: no name, amount, payee, code or link;
 *  - no images, no tracking, nothing loaded from anywhere: the HTML part is the
 *    same lines as the plain-text part, escaped, with links as plain anchors;
 *  - a link only ever points at this server's own APP_URL or OPS_URL (`render`
 *    refuses anything else), and only two kinds of email carry one at all: an
 *    activation link and a password-reset link. A NOTICE never contains a link
 *    that does something;
 *  - no secret is ever written here except those two single-use links;
 *  - the legal footer is a bracketed PLACEHOLDER until compliance supplies it,
 *    like every other regulatory wording in this project (src/config/disclosures.ts).
 */
import { sha256 } from '../crypto';
import { plainText, singleLine } from '../validate';

/** PLACEHOLDER. The company details and regulatory wording an email must carry: to be supplied and approved by Global Connect compliance. */
export const MAIL_FOOTER = '[EMAIL FOOTER — company details and regulatory wording]';
/** PLACEHOLDER. How to reach Global Connect: to be supplied. */
export const MAIL_CONTACT = '[HOW TO CONTACT GLOBAL CONNECT]';

export type MailCategory = 'activation' | 'security' | 'payments' | 'rates';

/** A line of an email: text, or a link shown on a line of its own. */
type Line = string | { link: string };
interface Draft {
  subject: string;
  lines: Line[];
}

const utc = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
/** A name or other free text can never start a new line of a message. */
const safe = (value: string): string => singleLine(value).slice(0, 200);
const NOT_YOU = `If this was not you, tell Global Connect at once: ${MAIL_CONTACT}`;

/** What each security notice says. One or two plain sentences; never a link, a code, an amount or an address. */
export const SECURITY_NOTICES = {
  password_changed: () => ['The password of your account was changed. Every other signed-in session was signed out.'],
  password_reset: () => ['The password of your account was reset using an emailed link and a code from your authenticator. Every signed-in session was signed out.'],
  recovery_codes_regenerated: () => ['New recovery codes were made for your account. The old ones no longer work.'],
  new_network_sign_in: () => ['Your account was signed in to from a network it had not been used from before.'],
  account_locked: () => ['Too many wrong passwords or codes were entered for your account, so sign-in is locked for a while. If it was you, wait and try again; nothing else is needed.'],
  account_disabled: () => ['Your account has been disabled by Global Connect. You cannot sign in until it is enabled again.'],
  account_enabled: () => ['Your account has been enabled again by Global Connect.'],
  authenticator_reset_requested: (data: { until?: number }) => [
    'Global Connect staff have approved a reset of the authenticator on your account.',
    `It has NOT happened yet. It will not happen before ${utc(data.until ?? 0)}. After that your current password, authenticator and recovery codes will stop working and a new activation link will be emailed to this address.`,
    'If you did not ask for this: sign in now with your current password and authenticator code (that cancels the reset), and tell Global Connect.',
  ],
  authenticator_reset_cancelled: () => ['The reset of the authenticator on your account was cancelled. Nothing was changed: your password, authenticator and recovery codes work as before.'],
  authenticator_reset_completed: () => ['The authenticator on your account has been reset. Your earlier password, authenticator and recovery codes no longer work. A separate email carries a new activation link.'],
  session_revoked: () => ['One of the signed-in sessions of your account was signed out from your security settings.'],
} satisfies Record<string, (data: { until?: number }) => string[]>;
export type SecurityNotice = keyof typeof SECURITY_NOTICES;

/**
 * NOTIFICATIONS: what each in-app notification and its email say. The same words are used for both.
 *
 * Free text that a person typed (a payee's name, a colleague's name, the reason a payment was rejected) goes through
 * `plainText` (validate.ts): one line, cut to a length, and anything that a mail client or an app would turn into
 * a link (a scheme, a host name, www., an email address) is visibly broken, however it was nested. The HTML part of
 * the email escapes it; the app shows it as plain text with no link detection. NO bank details are ever here.
 * Nothing promises a rate, a time or an outcome.
 */
const typed = (value: string | null | undefined, max = 200): string => plainText(value, max);
const sum = (data: { amount: string; currency: string }): string => `${typed(data.currency, 3)} ${typed(data.amount, 24)}`;
export interface PaymentNote {
  amount: string;
  currency: string;
  payee: string;
  /** The person who created the payment. */
  createdBy?: string;
  /** When a waiting payment runs out. */
  expiresAt?: number;
  /** Who rejected it, and the reason they gave (their own words). */
  by?: string;
  reason?: string | null;
}
export interface AlertNote {
  base: string;
  quote: string;
  side: 'sell' | 'buy';
  target: string;
  rate: string;
  at: number;
}
interface NoteText {
  title: string;
  lines: string[];
}
const payment = (data: PaymentNote): string => `${sum(data)} to ${typed(data.payee, 120)}`;
export const NOTIFICATIONS = {
  rate_alert: (data: AlertNote): NoteText => ({
    title: `Rate alert: ${typed(data.base, 3)}/${typed(data.quote, 3)}`,
    lines: [
      `Your rate to ${data.side === 'sell' ? 'sell' : 'buy'} ${typed(data.base, 3)} ${data.side === 'sell' ? 'for' : 'with'} ${typed(data.quote, 3)} reached ${typed(data.rate, 24)} when we checked at ${utc(data.at)}. Your alert was set at ${typed(data.target, 24)} or better.`,
      'This rate is indicative: it is not held for you and it may have moved since. To convert, open the app and get a rate there.',
      'This alert has now stopped. Turn it on again in the app if you want to be told the next time.',
    ],
  }),
  payment_awaiting: (data: PaymentNote): NoteText => ({
    title: 'A payment is waiting for your approval',
    lines: [`${typed(data.createdBy, 120)} created a payment of ${payment(data)}. It has not been sent.`, `It needs approval before ${utc(data.expiresAt ?? 0)}; after that it expires and is not sent. Open the app to review the payee details and approve or reject it.`],
  }),
  payment_expiring: (data: PaymentNote): NoteText => ({
    title: 'A payment waiting for approval is about to expire',
    lines: [`The payment of ${payment(data)}, created by ${typed(data.createdBy, 120)}, is still waiting for approval. It has not been sent.`, `It expires ${utc(data.expiresAt ?? 0)}. If it is not approved by then it will not be sent and would have to be created again.`],
  }),
  // A security notice, shown in the app as well as emailed. The same words as the email (SECURITY_NOTICES).
  security_notice: (data: { kind: SecurityNotice; at: number; until?: number }): NoteText => ({ title: 'Security notice about your account', lines: [...SECURITY_NOTICES[data.kind](data), `Time: ${utc(data.at)}.`, NOT_YOU] }),
  payment_approved: (data: PaymentNote): NoteText => ({ title: 'Your payment was approved', lines: [`Your payment of ${payment(data)} has all the approvals it needs and is being sent for processing.`] }),
  payment_rejected: (data: PaymentNote): NoteText => ({
    title: 'Your payment was rejected',
    lines: [`Your payment of ${payment(data)} was rejected by ${typed(data.by, 120)}. It was not sent.`, data.reason ? `Reason given: “${typed(data.reason, 200)}”` : 'No reason was given.'],
  }),
  payment_cancelled: (data: PaymentNote): NoteText => ({ title: 'Your payment was cancelled', lines: [`Your payment of ${payment(data)} was cancelled by ${typed(data.by, 120)} before it was approved. It was not sent.`] }),
  payment_expired: (data: PaymentNote): NoteText => ({ title: 'Your payment expired', lines: [`Your payment of ${payment(data)} was not approved in time and has expired. It was not sent. Create it again if it is still needed.`] }),
  payment_stopped: (data: PaymentNote): NoteText => ({ title: 'Your payment was stopped', lines: [`Your payment of ${payment(data)} was stopped because the payee’s details changed after you created it. It was not sent. Check the payee and create the payment again if it is still needed.`] }),
  payment_sent: (data: PaymentNote): NoteText => ({ title: 'Your payment was sent for processing', lines: [`Your payment of ${payment(data)} was approved and has been sent for processing.`] }),
  payment_failed: (data: PaymentNote): NoteText => ({ title: 'Your payment needs attention: it was not sent', lines: [`Your payment of ${payment(data)} was approved but could not be sent. No money has left the account for it. Open the app for details.`] }),
  payment_checking: (data: PaymentNote): NoteText => ({
    title: 'Your payment needs attention: its outcome is being checked',
    lines: [`Your payment of ${payment(data)} was approved, but we did not get a clear answer when it was sent, so we do not yet know whether it was made. We are checking.`, `Do NOT create it again. If you need to know now, contact Global Connect: ${MAIL_CONTACT}`],
  }),
  payment_mismatch: (data: PaymentNote): NoteText => ({
    title: 'Your payment needs attention: it was not sent as approved',
    lines: [`Your payment of ${payment(data)} was sent, but what was sent does not match what was approved. Contact Global Connect: ${MAIL_CONTACT}`],
  }),
} satisfies Record<string, (data: never) => NoteText>;
export type NotificationKind = keyof typeof NOTIFICATIONS;
export type NotificationData<K extends NotificationKind> = Parameters<(typeof NOTIFICATIONS)[K]>[0];
/** The words of a notification, from its kind and data. */
export const notificationText = (kind: NotificationKind, data: unknown): NoteText => (NOTIFICATIONS[kind] as (input: unknown) => NoteText)(data);
/** The subject of a notification email: which kind of thing it is, and nothing about it. */
const NOTIFICATION_SUBJECT = (kind: NotificationKind): string =>
  kind === 'security_notice' ? 'Security notice for your Global Connect account' : kind === 'rate_alert' ? 'A rate alert on your Global Connect account' : kind === 'payment_awaiting' || kind === 'payment_expiring' ? 'A payment is waiting for your approval in Global Connect' : 'An update on a payment you created in Global Connect';

export const TEMPLATES = {
  'activation.client': (data: { name: string; link: string; expiresAt: number }): Draft => ({
    subject: 'Activate your Global Connect account',
    lines: [
      `Hello ${safe(data.name)},`,
      '',
      'Use this link to set your password and add your authenticator app:',
      { link: data.link },
      '',
      `The link works once and expires ${utc(data.expiresAt)}. Any earlier link no longer works.`,
      'If you were not expecting this, do not use the link and tell Global Connect.',
    ],
  }),
  'activation.staff': (data: { name: string; link: string; expiresAt: number }): Draft => ({
    subject: 'Activate your Global Connect staff account',
    lines: [
      `Hello ${safe(data.name)},`,
      '',
      'Use this link to set your password and add your authenticator app:',
      { link: data.link },
      '',
      `The link works once and expires ${utc(data.expiresAt)}. Any earlier link no longer works.`,
      'If you were not expecting this, do not use the link and tell Global Connect.',
    ],
  }),
  // The link ALONE resets nothing: the page it opens also asks for a code from the authenticator app (or a recovery code).
  'reset.client': (data: { name: string; link: string; expiresAt: number }): Draft => ({
    subject: 'Reset the password of your Global Connect account',
    lines: [
      `Hello ${safe(data.name)},`,
      '',
      'A password reset was asked for on your Global Connect account. To choose a new password, open this link:',
      { link: data.link },
      '',
      `The link works once and expires ${utc(data.expiresAt)}. You will also be asked for a code from your authenticator app, or one of your recovery codes: the link alone changes nothing.`,
      'If you did not ask for this, you need do nothing: your password has not changed. If it keeps happening, tell Global Connect.',
    ],
  }),
  'reset.staff': (data: { name: string; link: string; expiresAt: number }): Draft => ({
    subject: 'Reset the password of your Global Connect staff account',
    lines: [
      `Hello ${safe(data.name)},`,
      '',
      'A password reset was asked for on your Global Connect staff account. To choose a new password, open this link:',
      { link: data.link },
      '',
      `The link works once and expires ${utc(data.expiresAt)}. You will also be asked for a code from your authenticator app, or one of your recovery codes: the link alone changes nothing.`,
      'If you did not ask for this, you need do nothing: your password has not changed. Tell an ops admin.',
    ],
  }),
  // A NOTICE: it tells, it never asks. No link, no code, nothing to click.
  'security.notice': (data: { name: string; audience: 'client' | 'staff'; kind: SecurityNotice; at: number; until?: number }): Draft => ({
    subject: data.audience === 'staff' ? 'Security notice for your Global Connect staff account' : 'Security notice for your Global Connect account',
    lines: [`Hello ${safe(data.name)},`, '', ...SECURITY_NOTICES[data.kind](data), '', `Time: ${utc(data.at)}.`, NOT_YOU],
  }),
  // A NOTIFICATION the person can turn off (rate alerts, approvals, their own payments). No link, no code, no bank details.
  notification: (data: { name: string; kind: NotificationKind; note: unknown }): Draft => ({
    subject: NOTIFICATION_SUBJECT(data.kind),
    lines: [`Hello ${safe(data.name)},`, '', ...notificationText(data.kind, data.note).lines, '', 'You can choose which of these emails you get in the app, under Notifications.'],
  }),
  // Sent at most once an hour to an address that had more ordinary notifications than are emailed one by one.
  'notification.digest': (_data: Record<string, never>): Draft => ({
    subject: 'More notifications are waiting for you in Global Connect',
    lines: ['Hello,', '', 'More notifications arrived for you in the last hour than we send by email one at a time.', 'All of them are in the Global Connect app, under Notifications. Nothing has been lost.'],
  }),
} satisfies Record<string, (data: never) => Draft>;

export type TemplateName = keyof typeof TEMPLATES;
export type TemplateData<N extends TemplateName> = Parameters<(typeof TEMPLATES)[N]>[0];

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);

/**
 * The finished message. `allowed` are this server's own addresses (APP_URL,
 * OPS_URL): a link anywhere else, or a web address written into a line of
 * text, is refused rather than sent.
 */
export function render<N extends TemplateName>(name: N, data: TemplateData<N>, allowed: string[]): RenderedMail {
  const draft = (TEMPLATES[name] as (input: TemplateData<N>) => Draft)(data);
  const own = (url: string): boolean => allowed.some((base) => base !== '' && (url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}#`) || url.startsWith(`${base}?`)));
  const lines = [...draft.lines, '', '--', MAIL_FOOTER];
  for (const line of lines) {
    if (typeof line === 'string') {
      if (/https?:\/\//i.test(line)) throw new Error(`The email template ${name} has a web address in its text. Links are given as links, and only to this server.`);
      if (/[\r\n]/.test(line)) throw new Error(`The email template ${name} has a line break inside a line.`);
    } else if (!own(line.link) || /[\s<>"]/.test(line.link)) {
      throw new Error(`The email template ${name} was given a link that does not point at this server.`);
    }
  }
  if (/[\r\n]/.test(draft.subject)) throw new Error(`The email template ${name} has a line break in its subject.`);
  const text = lines.map((line) => (typeof line === 'string' ? line : line.link)).join('\n');
  const body = lines.map((line) => (typeof line === 'string' ? (line === '' ? '<br>' : `<p>${escapeHtml(line)}</p>`) : `<p><a href="${escapeHtml(line.link)}">${escapeHtml(line.link)}</a></p>`)).join('\n');
  const html = `<!doctype html>\n<html lang="en-GB"><head><meta charset="utf-8"><title>${escapeHtml(draft.subject)}</title></head>\n<body>\n${body}\n</body></html>`;
  return { subject: draft.subject, text, html };
}

/** What a queued email is: who it is for, which template, and the key that makes it ONE logical message however often it is asked for. */
export interface MailRequest<N extends TemplateName = TemplateName> {
  to: string;
  template: N;
  data: TemplateData<N>;
  /** The same key is the same message: it is queued once. */
  key: string;
  category: MailCategory;
}

/** Builds a request with its template's data checked. */
export const mailOf = <N extends TemplateName>(request: MailRequest<N>): MailRequest => request as unknown as MailRequest;

/** The email that carries an activation link. One message per link: asking again for the same link queues nothing new. */
export function activationMail(invite: { activationLink: string; expiresAt: number }, to: string, name: string, kind: 'client' | 'staff'): MailRequest {
  return mailOf({ to, template: kind === 'staff' ? 'activation.staff' : 'activation.client', data: { name, link: invite.activationLink, expiresAt: invite.expiresAt }, key: `activation:${sha256(invite.activationLink)}`, category: 'activation' });
}
