import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { getAuthClient } from '@/api';
import type { SelfServiceClient } from '@/api/auth';
import { ProviderError } from '@/api/errors';
import { CANCEL_RESET_DONE, CancelResetScreen } from '@/screens/CancelResetScreen';
import { NO_SECOND_FACTOR, RESET_MAYBE_DONE, RESET_REQUESTED, ResetPasswordScreen } from '@/screens/ResetPasswordScreen';
import { SecurityScreen } from '@/screens/SecurityScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { SignInScreen } from '@/screens/SignInScreen';
import { useSession } from '@/state/session';
import { installMockBackend, openedFromLink, renderScreen, startTestSession } from '@/test/utils';

const expoRouter = jest.requireMock<{ __setParams: (params: Record<string, string>) => void; router: { replace: jest.Mock; push: jest.Mock } }>('expo-router');

/** What the Global Connect server offers; the in-app demo has none. */
function selfService(overrides: Partial<SelfServiceClient> = {}): jest.Mocked<SelfServiceClient> {
  const service: jest.Mocked<SelfServiceClient> = {
    requestPasswordReset: jest.fn(async () => undefined),
    beginPasswordReset: jest.fn(async () => ({ minLength: 12 })),
    completePasswordReset: jest.fn(async () => undefined),
    cancelAuthenticatorReset: jest.fn(async () => undefined),
    changePassword: jest.fn(async () => undefined),
    regenerateRecoveryCodes: jest.fn(async () => ['AAAAA-BBBBB-CCCCC-DDDDD', 'EEEEE-FFFFF-GGGGG-HHHHH']),
    listSessions: jest.fn(async () => [
      { id: 'ref-this', current: true, device: 'Chrome on Windows', signedInAt: '2026-11-11T10:00:00.000Z', lastActiveAt: '2026-11-11T10:15:00.000Z' },
      { id: 'ref-other', current: false, device: 'Global Connect app on Android', signedInAt: '2026-11-10T09:00:00.000Z', lastActiveAt: '2026-11-10T09:30:00.000Z' },
    ]),
    endSession: jest.fn(async () => undefined),
    ...overrides,
  } as jest.Mocked<SelfServiceClient>;
  (getAuthClient() as { selfService: SelfServiceClient | null }).selfService = service;
  return service;
}

beforeEach(() => {
  installMockBackend();
  useSession.setState({ session: null, signedOutReason: null });
  expoRouter.__setParams({});
  expoRouter.router.replace.mockClear();
  expoRouter.router.push.mockClear();
});

describe('forgotten password', () => {
  it('is offered on the sign-in screen only when the app talks to the server', async () => {
    await renderScreen(<SignInScreen />);
    expect(screen.queryByTestId('go-reset')).not.toBeOnTheScreen();
    selfService();
    await renderScreen(<SignInScreen />);
    await fireEvent.press(screen.getByTestId('go-reset'));
    expect(expoRouter.router.push).toHaveBeenCalledWith('/reset');
  });

  it('asking for a link says the same thing whatever the address, and says plainly that email alone is not enough', async () => {
    const service = selfService();
    await renderScreen(<ResetPasswordScreen />);
    // Without the authenticator or a recovery code there is no way back online: the screen says so, with how to reach Global Connect as a placeholder.
    expect(screen.getByTestId('reset-no-second-factor')).toHaveTextContent(NO_SECOND_FACTOR);
    expect(NO_SECOND_FACTOR).toMatch(/an email alone must never be enough[^]*\[HOW TO CONTACT GLOBAL CONNECT\]$/);
    await fireEvent.changeText(screen.getByTestId('reset-email'), 'not an address');
    await fireEvent.press(screen.getByTestId('reset-request'));
    expect(await screen.findByText(/Enter a valid email address/)).toBeOnTheScreen();
    expect(service.requestPasswordReset).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId('reset-email'), ' someone@company.com ');
    await fireEvent.press(screen.getByTestId('reset-request'));
    expect(await screen.findByText(RESET_REQUESTED)).toBeOnTheScreen();
    expect(service.requestPasswordReset).toHaveBeenCalledWith('someone@company.com');
    expect(RESET_REQUESTED).toMatch(/^If that address belongs to/);
  });

  it('the link is not enough: the new password needs a code from the authenticator, or a recovery code', async () => {
    const service = selfService();
    // Opened from the emailed link: the code arrives with the page, after "#". It is taken out of the address bar
    // AT ONCE, before anything has been sent anywhere (a link that turns out to be bad is not left there either).
    const link = openedFromLink('/reset', '#code=ABCDE-FGHIJ-KLMNO-PQRST');
    try {
      await renderScreen(<ResetPasswordScreen />);
      expect(link.replaceState).toHaveBeenCalledWith(null, '', '/reset');
      expect(service.beginPasswordReset).not.toHaveBeenCalled();
      await fireEvent.press(screen.getByTestId('reset-open'));
      await waitFor(() => expect(service.beginPasswordReset).toHaveBeenCalledWith('ABCDE-FGHIJ-KLMNO-PQRST'));
      expect(await screen.findByTestId('reset-second-factor')).toBeOnTheScreen();
    } finally {
      link.restore();
    }

    // No code: nothing is sent.
    await fireEvent.changeText(screen.getByTestId('reset-password'), 'a long enough password');
    await fireEvent.changeText(screen.getByTestId('reset-password-repeat'), 'a long enough password');
    await fireEvent.press(screen.getByTestId('reset-finish'));
    expect(await screen.findByText(/Enter the 6-digit code from your authenticator app/)).toBeOnTheScreen();
    expect(service.completePasswordReset).not.toHaveBeenCalled();
    // A weak or mismatched password: nothing is sent either.
    await fireEvent.changeText(screen.getByTestId('reset-second-factor'), '123456');
    await fireEvent.changeText(screen.getByTestId('reset-password-repeat'), 'a different password');
    await fireEvent.press(screen.getByTestId('reset-finish'));
    expect(await screen.findByText(/The two passwords do not match/)).toBeOnTheScreen();
    expect(service.completePasswordReset).not.toHaveBeenCalled();
    // The code and a good password: sent together, and the person is told what changed and what did not.
    await fireEvent.changeText(screen.getByTestId('reset-password-repeat'), 'a long enough password');
    await fireEvent.press(screen.getByTestId('reset-finish'));
    await waitFor(() => expect(service.completePasswordReset).toHaveBeenCalledWith('123456', 'totp', 'a long enough password'));
    expect(await screen.findByText(/Your password has been changed\. You have been signed out everywhere; your authenticator app and recovery codes are unchanged\./)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('reset-sign-in'));
    expect(expoRouter.router.replace).toHaveBeenCalledWith('/sign-in');
  });

  it('a reset code in the QUERY string is never used, and is taken out of the address bar', async () => {
    selfService();
    // A code in the QUERY string is not used (it would be in every log on its way): the person is asked for their email instead.
    const query = openedFromLink('/reset', '', '?code=ABCDE-FGHIJ-KLMNO-PQRST');
    try {
      expoRouter.__setParams({ code: 'ABCDE-FGHIJ-KLMNO-PQRST' });
      await renderScreen(<ResetPasswordScreen />);
      expect(screen.getAllByTestId('reset-email').length).toBeGreaterThan(0);
      expect(query.replaceState).toHaveBeenCalledWith(null, '', '/reset');
    } finally {
      query.restore();
      expoRouter.__setParams({});
    }
  });

  it('a recovery code can be used instead, and a link that is no longer valid sends the person back to ask for a new one', async () => {
    const service = selfService({ completePasswordReset: jest.fn(async () => Promise.reject(new ProviderError('validation', { reason: 'reset_invalid' }))) });
    const link = openedFromLink('/reset', '#code=ABCDE-FGHIJ-KLMNO-PQRST');
    await renderScreen(<ResetPasswordScreen />);
    link.restore();
    await fireEvent.press(screen.getByTestId('reset-open'));
    await fireEvent.press(await screen.findByTestId('reset-toggle-method'));
    await fireEvent.changeText(screen.getByTestId('reset-second-factor'), 'AAAAA-BBBBB-CCCCC-DDDDD');
    await fireEvent.changeText(screen.getByTestId('reset-password'), 'a long enough password');
    await fireEvent.changeText(screen.getByTestId('reset-password-repeat'), 'a long enough password');
    await fireEvent.press(screen.getByTestId('reset-finish'));
    await waitFor(() => expect(service.completePasswordReset).toHaveBeenCalledWith('AAAAA-BBBBB-CCCCC-DDDDD', 'recovery', 'a long enough password'));
    // The link works once, so this is also what a retry sees when the first answer was lost and the password WAS changed: the message says so.
    expect(await screen.findByText(RESET_MAYBE_DONE)).toBeOnTheScreen();
    expect(RESET_MAYBE_DONE).toMatch(/your password may already have been changed: try signing in with the new password/);
    expect(screen.getByTestId('reset-email')).toBeOnTheScreen();
  });
});

describe('security settings', () => {
  it('are reached from settings only when the app talks to the server', async () => {
    await startTestSession();
    await renderScreen(<SettingsScreen />);
    expect(screen.queryByTestId('open-security')).not.toBeOnTheScreen();
    selfService();
    await renderScreen(<SettingsScreen />);
    await fireEvent.press(screen.getByTestId('open-security'));
    expect(expoRouter.router.push).toHaveBeenCalledWith('/security');
  });

  it('changing the password needs the current password and a code; new recovery codes need a code and are shown once', async () => {
    await startTestSession();
    const service = selfService();
    await renderScreen(<SecurityScreen />);
    // Everything but the current password: nothing is sent.
    await fireEvent.changeText(screen.getByTestId('security-new-password'), 'a long enough password');
    await fireEvent.changeText(screen.getByTestId('security-new-password-repeat'), 'a long enough password');
    await fireEvent.changeText(screen.getByTestId('security-password-code'), '123456');
    await fireEvent.press(screen.getByTestId('security-change-password'));
    expect(await screen.findByText(/Enter your current password\./)).toBeOnTheScreen();
    expect(service.changePassword).not.toHaveBeenCalled();
    // Everything but the code: nothing is sent.
    await fireEvent.changeText(screen.getByTestId('security-current-password'), 'my current password');
    await fireEvent.changeText(screen.getByTestId('security-password-code'), '');
    await fireEvent.press(screen.getByTestId('security-change-password'));
    expect(await screen.findByText(/Enter the 6-digit code from your authenticator app/)).toBeOnTheScreen();
    expect(service.changePassword).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId('security-password-code'), '123 456');
    await fireEvent.press(screen.getByTestId('security-change-password'));
    await waitFor(() => expect(service.changePassword).toHaveBeenCalledWith('my current password', '123456', 'a long enough password'));
    expect(await screen.findByText('Your password has been changed.')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('security-regenerate'));
    expect(service.regenerateRecoveryCodes).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId('security-recovery-code'), '654321');
    await fireEvent.press(screen.getByTestId('security-regenerate'));
    expect(await screen.findByText('AAAAA-BBBBB-CCCCC-DDDDD')).toBeOnTheScreen();
    expect(screen.getByText(/These are shown only now/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('security-codes-saved'));
    expect(screen.queryByText('AAAAA-BBBBB-CCCCC-DDDDD')).not.toBeOnTheScreen();
  });

  it('lists sessions by kind of device and rough time, ends another one, and ending this one signs out', async () => {
    await startTestSession();
    const service = selfService();
    await renderScreen(<SecurityScreen />);
    expect(await screen.findByText('Chrome on Windows (this one)')).toBeOnTheScreen();
    expect(screen.getByText('Global Connect app on Android')).toBeOnTheScreen();
    // Nothing that identifies a network is shown: only what the server sent, which has none.
    expect(screen.queryByText(/\d+\.\d+\.\d+\.\d+/)).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('end-session-other'));
    await waitFor(() => expect(service.endSession).toHaveBeenCalledWith('ref-other'));
    expect(useSession.getState().session).not.toBeNull();
    await fireEvent.press(screen.getByTestId('end-session-current'));
    await waitFor(() => expect(service.endSession).toHaveBeenCalledWith('ref-this'));
    await waitFor(() => expect(useSession.getState().session).toBeNull());
    expect(expoRouter.router.replace).toHaveBeenCalledWith('/sign-in');
  });
});

describe('“This was not me”: the link in the warning before an authenticator reset', () => {
  it('reads the token from the fragment only, wipes the address bar at once, does nothing until the button is pressed, and says the same whatever the link was', async () => {
    const service = selfService();
    const link = openedFromLink('/cancel-reset', '#token=ar_0123456789abcdef.c2lnbmF0dXJl');
    try {
      await renderScreen(<CancelResetScreen />);
      // The token left the address bar before anything was sent, and nothing has been sent: opening the link cancels nothing.
      expect(link.replaceState).toHaveBeenCalledWith(null, '', '/cancel-reset');
      expect(service.cancelAuthenticatorReset).not.toHaveBeenCalled();
      expect(screen.getByText(/This only cancels the reset: it does not sign you in and changes nothing else\./)).toBeOnTheScreen();
      await fireEvent.press(screen.getByTestId('cancel-reset-confirm'));
      expect(await screen.findByText(CANCEL_RESET_DONE)).toBeOnTheScreen();
      expect(service.cancelAuthenticatorReset).toHaveBeenCalledTimes(1);
      expect(service.cancelAuthenticatorReset).toHaveBeenCalledWith('ar_0123456789abcdef.c2lnbmF0dXJl');
      expect(CANCEL_RESET_DONE).toMatch(/^If a reset of the authenticator was waiting/);
      expect(useSession.getState().session).toBeNull();
    } finally {
      link.restore();
    }
  });

  it('without the link (or with the token in the query string, which is never read) there is nothing to press', async () => {
    const service = selfService();
    const query = openedFromLink('/cancel-reset', '', '?token=ar_0123456789abcdef.c2lnbmF0dXJl');
    try {
      await renderScreen(<CancelResetScreen />);
      expect(screen.queryByTestId('cancel-reset-confirm')).toBeNull();
      expect(screen.getByText(/This page works only from that link\./)).toBeOnTheScreen();
      expect(service.cancelAuthenticatorReset).not.toHaveBeenCalled();
    } finally {
      query.restore();
    }
  });
});
