/**
 * The offline demo backend, used when EXPO_PUBLIC_API_URL is not set: the
 * Currencycloud-shaped client wired to an in-memory server, plus a stand-in
 * for Global Connect sign-in. Nothing here touches the network.
 *
 *   screens -> ProviderClient -> CurrencycloudClient -> Transport
 *                                 (validate + map)      (MockCurrencycloudServer)
 *
 * THE SIGN-IN HERE CHECKS NOTHING REAL. It accepts any email and password and
 * one fixed sample code, so the screens can be shown without a server. The real
 * rules (password hashing, authenticator codes, lockout, step-up tokens) live
 * in server/.
 */
import type { AuthClient } from '../auth';
import { ProviderError } from '../errors';
import type { MockControls } from '../mockControls';
import type { ProviderClient } from '../provider';
import type { ActivationResult, ActivationStart, CodeMethod, LoginChallenge, Session, SessionUser, SignInResult, TotpEnrolment } from '../types';
import { CurrencycloudClient } from './currencycloud/client';
import { MockCurrencycloudServer } from './currencycloud/mockServer';

/** The one authenticator code the demo accepts. */
export const DEMO_CODE = '000000';
export const DEMO_RECOVERY_CODE = 'SAMPLE-RECOVERY';
export const DEMO_ACTIVATION_CODE = 'SAMPLE-ACTIVATION';
/** Not a real key: the demo never checks a code computed from it. */
const DEMO_TOTP_KEY = 'SAMPLEKEYSAMPLEKEYSAMPLEKEY23456';
const DEMO_COMPANY = { id: 'demo-company', name: 'Northfield Trading Ltd' };
export const DEMO_MIN_PASSWORD_LENGTH = 12;

export interface DemoBackendOptions {
  getControls: () => MockControls;
  planName: string | null;
  /** Server clock. */
  now?: () => number;
  /** Device clock, when a test wants it to differ from the server's. Defaults to `now`. */
  clientNow?: () => number;
  requestTimeoutMs?: number;
  random?: () => number;
}

export interface DemoBackend {
  client: ProviderClient;
  auth: AuthClient;
  /** Restore the sample data. */
  reset: () => void;
  /** Tests: open a session without going through the screens. */
  signInDirectly: (email?: string) => Promise<Session>;
}

function displayNameFor(email: string): string {
  return email.split('@')[0] ?? email;
}

export function createDemoBackend(options: DemoBackendOptions): DemoBackend {
  const server = new MockCurrencycloudServer({ getControls: options.getControls, now: options.now, random: options.random });
  const client = new CurrencycloudClient(server, {
    planName: options.planName,
    now: options.clientNow ?? options.now,
    requestTimeoutMs: options.requestTimeoutMs,
  });

  let pendingEmail: string | null = null;
  let user: SessionUser | null = null;
  let activating = false;

  const sessionFor = (who: SessionUser): Session => ({
    user: who,
    company: DEMO_COMPANY,
    role: 'admin',
    capabilities: { forwardContracts: true, paymentApprovals: true },
    stepUpActions: ['payment.create', 'payment.approve', 'payment.reject', 'beneficiary.create'],
  });

  const openSession = async (email: string): Promise<Session> => {
    await client.authenticate(email, 'demo-api-key');
    user = { id: `demo-user-${email.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, email, displayName: displayNameFor(email) };
    return sessionFor(user);
  };

  const auth: AuthClient = {
    sampleCode: DEMO_CODE,

    async signIn(email: string, password: string): Promise<LoginChallenge> {
      const address = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address) || password === '') {
        throw new ProviderError('validation', { reason: 'invalid_credentials' });
      }
      pendingEmail = address;
      return { challengeId: 'demo-challenge' };
    },

    async completeSignIn(_challengeId: string, code: string, method: CodeMethod): Promise<SignInResult> {
      if (!pendingEmail) throw new ProviderError('validation', { reason: 'challenge_expired' });
      if (code.trim() !== (method === 'totp' ? DEMO_CODE : DEMO_RECOVERY_CODE)) {
        throw new ProviderError('validation', { reason: 'invalid_code' });
      }
      const session = await openSession(pendingEmail);
      pendingEmail = null;
      return { user: session.user, companies: [DEMO_COMPANY], session };
    },

    async selectCompany(): Promise<Session> {
      if (!user) throw new ProviderError('unauthorized');
      return sessionFor(user);
    },

    async signOut(): Promise<void> {
      user = null;
      pendingEmail = null;
      await client.closeSession();
    },

    async beginActivation(activationCode: string): Promise<ActivationStart> {
      if (activationCode.trim().toUpperCase() !== DEMO_ACTIVATION_CODE) {
        throw new ProviderError('validation', { reason: 'activation_invalid' });
      }
      activating = true;
      return { email: 'sample.user@example.com', displayName: 'Sample User', passwordPolicy: { minLength: DEMO_MIN_PASSWORD_LENGTH } };
    },

    async setActivationPassword(password: string): Promise<TotpEnrolment> {
      if (!activating) throw new ProviderError('validation', { reason: 'activation_invalid' });
      if (password.length < DEMO_MIN_PASSWORD_LENGTH) throw new ProviderError('validation', { reason: 'weak_password' });
      return {
        secret: DEMO_TOTP_KEY,
        otpauthUri: `otpauth://totp/Global%20Connect:sample.user%40example.com?secret=${DEMO_TOTP_KEY}&issuer=Global%20Connect`,
      };
    },

    async confirmActivation(code: string): Promise<ActivationResult> {
      if (!activating) throw new ProviderError('validation', { reason: 'activation_invalid' });
      if (code.trim() !== DEMO_CODE) throw new ProviderError('validation', { reason: 'invalid_code' });
      activating = false;
      return { recoveryCodes: ['SAMPLE-RECOVERY', 'SAMPLE-CODE-0002', 'SAMPLE-CODE-0003', 'SAMPLE-CODE-0004'] };
    },

    async authorizeAction(_action, _payload, code: string): Promise<void> {
      if (code.trim() !== DEMO_CODE) throw new ProviderError('validation', { reason: 'invalid_code' });
    },
  };

  return { client, auth, reset: () => server.reset(), signInDirectly: (email = 'tester@example.com') => openSession(email) };
}
