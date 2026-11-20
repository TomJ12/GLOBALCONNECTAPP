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
import type { MailQueue } from '../mail/queue';
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

export class SecurityNotices {
  constructor(
    private readonly mail: MailQueue,
    private readonly now: () => number,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  /** Never throws: a notice that cannot be queued must not undo or fail what it is about. */
  async send(person: NoticePerson, audience: 'client' | 'staff', kind: SecurityNotice, extra: { until?: number } = {}): Promise<void> {
    const at = this.now();
    try {
      await this.mail.enqueue(
        mailOf({
          to: person.email,
          template: 'security.notice',
          data: { name: person.name, audience, kind, at, ...extra },
          key: `security:${audience}:${person.id}:${kind}:${Math.floor(at / WINDOW_MS[kind])}`,
          category: 'security',
        }),
      );
    } catch (error) {
      this.onError(error instanceof Error ? error.message : 'security notice failed');
    }
  }
}
