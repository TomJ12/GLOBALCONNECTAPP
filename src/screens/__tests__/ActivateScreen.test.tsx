import { activationCodeFromLink } from '@/lib/activationLink';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';

import { getAuthClient } from '@/api';
import { DEMO_ACTIVATION_CODE, DEMO_CODE } from '@/api/adapters/demoBackend';
import { qrPath } from '@/components/QrCode';
import { ActivateScreen, groupKey, passwordProblem } from '@/screens/ActivateScreen';
import { useSession } from '@/state/session';
import { installMockBackend, renderScreen, openedFromLink } from '@/test/utils';

const expoRouter = jest.requireMock<{ __setParams: (params: Record<string, string>) => void; router: { replace: jest.Mock } }>('expo-router');

beforeEach(() => {
  installMockBackend();
  useSession.setState({ session: null, signedOutReason: null });
  expoRouter.__setParams({});
  expoRouter.router.replace.mockClear();
});

async function toPasswordStep(): Promise<void> {
  await fireEvent.changeText(screen.getByTestId('activation-code'), DEMO_ACTIVATION_CODE);
  await fireEvent.press(screen.getByTestId('activation-start'));
  expect(await screen.findByText('Step 1 of 3: choose a password')).toBeOnTheScreen();
}

async function setPassword(password: string, repeat = password): Promise<void> {
  await fireEvent.changeText(screen.getByTestId('activation-password'), password);
  await fireEvent.changeText(screen.getByTestId('activation-password-repeat'), repeat);
  await fireEvent.press(screen.getByTestId('activation-set-password'));
}

describe('ActivateScreen', () => {
  it('refuses an activation code that is not valid', async () => {
    await renderScreen(<ActivateScreen />);
    await fireEvent.changeText(screen.getByTestId('activation-code'), 'WRONG-CODE-12345');
    await fireEvent.press(screen.getByTestId('activation-start'));
    expect(await screen.findByText(/not valid or has expired/)).toBeOnTheScreen();
    expect(screen.queryByText(/choose a password/)).not.toBeOnTheScreen();
  });

  it('walks code -> password -> authenticator -> recovery codes, and only finishes once the codes are saved', async () => {
    await renderScreen(<ActivateScreen />);
    await toPasswordStep();
    expect(screen.getByText(/At least 12 characters/)).toBeOnTheScreen();

    await setPassword('short');
    expect(await screen.findByText(/Use at least 12 characters\./)).toBeOnTheScreen();
    await setPassword('a long enough password', 'a different password');
    expect(await screen.findByText(/The two passwords do not match\./)).toBeOnTheScreen();
    await setPassword('a long enough password');

    // The QR code and the same key as copyable text.
    expect(await screen.findByTestId('qr-code')).toBeOnTheScreen();
    const key = String(screen.getByTestId('totp-key').props.children);
    expect(key).toMatch(/^([A-Z2-7]{4} )+[A-Z2-7]{1,4}$/);
    await fireEvent.press(screen.getByTestId('copy-totp-key'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(key.replace(/ /g, ''));

    // A wrong code does not complete activation.
    await fireEvent.changeText(screen.getByTestId('activation-totp'), '111111');
    await fireEvent.press(screen.getByTestId('activation-confirm'));
    expect(await screen.findByText(/That code is not right/)).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByTestId('activation-totp'), DEMO_CODE);
    await fireEvent.press(screen.getByTestId('activation-confirm'));

    expect(await screen.findByText('Step 3 of 3: save your recovery codes')).toBeOnTheScreen();
    expect(screen.getByText('SAMPLE-RECOVERY')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('copy-recovery'));
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(expect.stringContaining('SAMPLE-RECOVERY\n'));

    // Finishing needs the explicit "I have saved these" step.
    expect(screen.getByTestId('activation-finish')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('activation-finish'));
    expect(expoRouter.router.replace).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('recovery-saved'));
    await fireEvent.press(screen.getByTestId('activation-finish'));
    expect(expoRouter.router.replace).toHaveBeenCalledWith('/sign-in');
    // Activation does not sign anyone in.
    expect(useSession.getState().session).toBeNull();
  });

  it('reads the code from the link fragment (which a browser never sends to a server) and takes it out of the address bar', async () => {
    const spy = jest.spyOn(getAuthClient(), 'beginActivation');
    spy.mockClear();
    const replaceState = jest.fn();
    const address = globalThis as { location?: unknown; history?: unknown };
    const before = { location: address.location, history: address.history };
    address.location = { hash: `#code=${DEMO_ACTIVATION_CODE}`, pathname: '/activate', search: '' };
    address.history = { replaceState };
    try {
      expoRouter.__setParams({});
      await renderScreen(<ActivateScreen />);
      expect(await screen.findByText('Step 1 of 3: choose a password')).toBeOnTheScreen();
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      expect(spy).toHaveBeenCalledWith(DEMO_ACTIVATION_CODE);
      expect(replaceState).toHaveBeenCalledWith(null, '', '/activate');
    } finally {
      address.location = before.location;
      address.history = before.history;
    }
    expect(activationCodeFromLink('#code=ABCDE-FGHIJ-KLMNO-PQRST')).toBe('ABCDE-FGHIJ-KLMNO-PQRST');
    expect(activationCodeFromLink('#other=1&code=FROM-FRAGMENT')).toBe('FROM-FRAGMENT');
    expect(activationCodeFromLink('')).toBe('');
    expect(activationCodeFromLink('#code=<script>')).toBe('');
  });

  it('ignores a code in the QUERY string (it would be in every log on its way) and removes it from the address bar', async () => {
    const spy = jest.spyOn(getAuthClient(), 'beginActivation');
    spy.mockClear();
    const link = openedFromLink('/activate', '', `?code=${DEMO_ACTIVATION_CODE}&x=1`);
    try {
      // Even if the router hands the query parameter over, it is not used.
      expoRouter.__setParams({ code: DEMO_ACTIVATION_CODE });
      await renderScreen(<ActivateScreen />);
      expect(screen.queryByText('Step 1 of 3: choose a password')).not.toBeOnTheScreen();
      expect(spy).not.toHaveBeenCalled();
      expect(link.replaceState).toHaveBeenCalledWith(null, '', '/activate?x=1');
    } finally {
      link.restore();
      expoRouter.__setParams({});
    }
  });

  it('starts by itself when opened from an activation link', async () => {
    const spy = jest.spyOn(getAuthClient(), 'beginActivation');
    const link = openedFromLink('/activate', `#code=${DEMO_ACTIVATION_CODE}`);
    try {
      await renderScreen(<ActivateScreen />);
      expect(await screen.findByText('Step 1 of 3: choose a password')).toBeOnTheScreen();
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      expect(spy).toHaveBeenCalledWith(DEMO_ACTIVATION_CODE);
    } finally {
      link.restore();
    }
  });

  it('formats the key, checks passwords and draws a QR code on the device', () => {
    expect(groupKey('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
    expect(passwordProblem('elevenchars', 'elevenchars', 12)).toBe('Use at least 12 characters.');
    expect(passwordProblem('twelve chars', 'twelve chars', 12)).toBeNull();
    const qr = qrPath('otpauth://totp/Global%20Connect:a%40b.example?secret=JBSWY3DPEHPK3PXP&issuer=Global%20Connect');
    expect(qr.size).toBeGreaterThan(21);
    expect(qr.path.startsWith('M4 4h1v1h-1z')).toBe(true);
  });
});
