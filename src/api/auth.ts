/**
 * Sign-in, activation and step-up: the Global Connect account, which is
 * separate from whichever provider holds the company's money. Implemented by
 * the server adapter (adapters/globalConnectApi.ts) and by an in-app stand-in
 * for the offline demo (adapters/demoBackend.ts).
 *
 * Every method rejects with a ProviderError and nothing else.
 */
import type {
  ActivationResult,
  ActivationStart,
  CodeMethod,
  LoginChallenge,
  Session,
  SignInResult,
  StepUpAction,
  TotpEnrolment,
} from './types';

export interface AuthClient {
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
