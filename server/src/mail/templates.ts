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
import { singleLine } from '../validate';

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
    `It has NOT happened yet. On ${utc(data.until ?? 0)} your current password, authenticator and recovery codes will stop working and a new activation link will be emailed to this address.`,
    'If you did not ask for this: sign in now with your current password and authenticator code (that cancels the reset), and tell Global Connect.',
  ],
  authenticator_reset_cancelled: () => ['The reset of the authenticator on your account was cancelled. Nothing was changed: your password, authenticator and recovery codes work as before.'],
  authenticator_reset_completed: () => ['The authenticator on your account has been reset. Your earlier password, authenticator and recovery codes no longer work. A separate email carries a new activation link.'],
  session_revoked: () => ['One of the signed-in sessions of your account was signed out from your security settings.'],
} satisfies Record<string, (data: { until?: number }) => string[]>;
export type SecurityNotice = keyof typeof SECURITY_NOTICES;

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
