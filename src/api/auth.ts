/**
 * Sign-in, activation and step-up: the Global Connect account, which is
 * separate from whichever provider holds the company's money. Implemented by
 * the server adapter (adapters/globalConnectApi.ts) and by an in-app stand-in
 * for the offline demo (adapters/demoBackend.ts).
 *
 * Every method rejects with a ProviderError and nothing else.
 */
import type { AlertsStore } from '@/alerts/AlertsStore';

import type {
  ActivationResult,
  AppNotification,
  NotificationEmailChoices,
  ActivationStart,
  CodeMethod,
  LoginChallenge,
  Session,
  SignInResult,
  StepUpAction,
  OwnSession,
  TotpEnrolment,
} from './types';

/**
 * What a person can do about their own account without Global Connect staff:
 * reset a forgotten password (with the emailed link AND a second factor),
 * change the password, renew the recovery codes, see and end their sessions.
 * Only the Global Connect server offers it; the in-app demo has no accounts
 * to recover.
 */
export interface SelfServiceClient {
  /** Always resolves the same way, whether or not the address belongs to an account. */
  requestPasswordReset(email: string): Promise<void>;
  /** Checks the emailed link. The client keeps the code in memory until the reset completes. */
  beginPasswordReset(resetCode: string): Promise<{ minLength: number }>;
  /** The link, a code from the authenticator app (or a recovery code), and the new password. */
  completePasswordReset(code: string, method: CodeMethod, password: string): Promise<void>;
  /** "This was not me": cancels the reset of the authenticator that the emailed link names. Always resolves the same way. */
  cancelAuthenticatorReset(token: string): Promise<void>;
  changePassword(currentPassword: string, code: string, newPassword: string): Promise<void>;
  /** New recovery codes, to be shown once. The old ones stop working. */
  regenerateRecoveryCodes(code: string): Promise<string[]>;
  listSessions(): Promise<OwnSession[]>;
  endSession(id: string): Promise<void>;
}

/** The person's notification list, kept by the Global Connect server. */
export interface NotificationsClient {
  list(): Promise<{ items: AppNotification[]; unread: number }>;
  /** Marks one notification as read, or all of them. Returns how many are still unread. */
  markRead(id?: string): Promise<number>;
  emailChoices(): Promise<NotificationEmailChoices>;
  setEmailChoices(choices: NotificationEmailChoices): Promise<NotificationEmailChoices>;
}

export interface AuthClient {
  /** Null where there is nothing to recover (the in-app demo). */
  readonly selfService: SelfServiceClient | null;
  /** Null in the in-app demo: nothing there sends notifications. */
  readonly notifications: NotificationsClient | null;
  /** Rate alerts kept and checked by the server. Null in the in-app demo, which keeps them on the device and checks nothing. */
  readonly alerts: AlertsStore | null;
  /**
   * Set only by the in-app demo, so screens can show the sample code to type.
   * Always null against a server.
   */
  readonly sampleCode: string | null;

  /** Step 1: email and password. */
  signIn(email: string, password: string): Promise<LoginChallenge>;
  /** Step 2: a code from the authenticator app, or a one-time recovery code. The client keeps the session token in memory. */
  completeSignIn(challengeId: string, code: string, method: CodeMethod): Promise<SignInResult>;
  /** Scope the session to one of the person's companies. */
  selectCompany(companyId: string): Promise<Session>;
  /** Revoke the session on the backend and forget the token. Never rejects. */
  signOut(): Promise<void>;

  /** Activation, in order. The activation code is held in memory by the client until it completes. */
  beginActivation(activationCode: string): Promise<ActivationStart>;
  setActivationPassword(password: string): Promise<TotpEnrolment>;
  confirmActivation(code: string): Promise<ActivationResult>;

  /**
   * Exchange a fresh authenticator code for a one-time permission to perform
   * exactly this action with exactly this payload. The client keeps it and
   * attaches it to the matching request; nothing is returned to the screen.
   */
  authorizeAction(action: StepUpAction, payload: unknown, code: string): Promise<void>;
}
