/**
 * Security notices by email: something about your account changed, or was
 * tried. A notice tells; it never asks. No link, no code (mail/templates.ts).
 *
 * THEY CANNOT BE TURNED INTO A FLOOD. One person gets at most one notice of
 * each kind per window (an hour for the two kinds an attacker can cause by
 * hammering sign-in, a few minutes for the rest), because the key of the
 * queued message is the person, the kind and the window; on top of that the
 * outbox has its own per-recipient limit.
 */
import type { Delivery, MailQueue } from '../mail/queue';
import { mailOf, type SecurityNotice } from '../mail/templates';

const HOUR = 60 * 60_000;
/** How often, at most, one person is told the same kind of thing. */
const WINDOW_MS: Record<SecurityNotice, number> = {
  account_locked: HOUR,
  new_network_sign_in: HOUR,
  password_changed: 5 * 60_000,
  password_reset: 5 * 60_000,
  recovery_codes_regenerated: 5 * 60_000,
  account_disabled: 5 * 60_000,
  account_enabled: 5 * 60_000,
  authenticator_reset_requested: 5 * 60_000,
  authenticator_reset_cancelled: 5 * 60_000,
  authenticator_reset_completed: 5 * 60_000,
  session_revoked: 5 * 60_000,
};

export interface NoticePerson {
  id: string;
  email: string;
  name: string;
}

/** Shows a client's security notice in the app as well (their notification list). Set by the app once the notifier exists. */
export type InAppNotice = (person: NoticePerson, kind: SecurityNotice, data: { at: number; until?: number }, key: string) => Promise<unknown>;

export class SecurityNotices {
  private inApp: InAppNotice | null = null;
  constructor(
    private readonly mail: MailQueue,
    private readonly now: () => number,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  attachInApp(inApp: InAppNotice): void {
    this.inApp = inApp;
  }

  /** The key a notice is queued under. With `key`, the caller names the message so that it can ask later what became of it. */
  keyOf(person: Pick<NoticePerson, 'id'>, audience: 'client' | 'staff', kind: SecurityNotice, at: number, key?: string): string {
    return key ?? `security:${audience}:${person.id}:${kind}:${Math.floor(at / WINDOW_MS[kind])}`;
  }

  /**
   * Never throws: a notice that cannot be queued must not undo or fail what it is about. Returns where the email
   * stands (sent, queued, deferred...), or null if it could not even be queued: a caller for whom the notice
   * MATTERS (the warning before an authenticator reset) must look at it.
   */
  async send(person: NoticePerson, audience: 'client' | 'staff', kind: SecurityNotice, extra: { until?: number } = {}, options: { key?: string } = {}): Promise<Delivery | null> {
    const at = this.now();
    const key = this.keyOf(person, audience, kind, at, options.key);
    let delivery: Delivery | null = null;
    try {
      delivery = await this.mail.enqueue(mailOf({ to: person.email, template: 'security.notice', data: { name: person.name, audience, kind, at, ...extra }, key, category: 'security' }));
    } catch (error) {
      this.onError(error instanceof Error ? error.message : 'security notice failed');
    }
    // A client also sees it in the app, whatever happens to the email.
    if (audience === 'client' && this.inApp) await this.inApp(person, kind, { at, ...extra }, key).catch((error: unknown) => this.onError(error instanceof Error ? error.message : 'security notice in the app failed'));
    return delivery;
  }
}
