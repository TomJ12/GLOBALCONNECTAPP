import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import fs from 'fs';
import path from 'path';

import { getAuthClient, getProviderClient, setProviderBackendForTests } from '@/api';
import { DEMO_CODE, DEMO_RECOVERY_CODE } from '@/api/adapters/demoBackend';
import { ProviderError } from '@/api/errors';
import type { Session } from '@/api/types';
import { disclosures } from '@/config/disclosures';
import { SignInScreen } from '@/screens/SignInScreen';
import { useSession } from '@/state/session';
import { installMockBackend, renderScreen } from '@/test/utils';

async function enterCredentials(email = 'finance@example.com', password = 'a long enough password'): Promise<void> {
  await fireEvent.changeText(screen.getByTestId('sign-in-email'), email);
  await fireEvent.changeText(screen.getByTestId('sign-in-password'), password);
  await fireEvent.press(screen.getByTestId('sign-in-continue'));
}

async function enterCode(code: string): Promise<void> {
  await fireEvent.changeText(await screen.findByTestId('sign-in-code'), code);
  await fireEvent.press(screen.getByTestId('sign-in-verify'));
}

beforeEach(async () => {
  installMockBackend();
  useSession.setState({ session: null, signedOutReason: null });
  await AsyncStorage.clear();
});

describe('SignInScreen', () => {
  it('validates the email and password before sending anything', async () => {
    const spy = jest.spyOn(getAuthClient(), 'signIn');
    await renderScreen(<SignInScreen />);
    await fireEvent.press(screen.getByTestId('sign-in-continue'));
    expect(await screen.findByText(/Enter a valid email address/)).toBeOnTheScreen();
    expect(screen.getByText(/Enter your password\./)).toBeOnTheScreen();
    expect(spy).not.toHaveBeenCalled();
  });

  it('signs in with email, password and a 6-digit code, and stores nothing on the device', async () => {
    await renderScreen(<SignInScreen />);
    await enterCredentials();
    expect(await screen.findByText('Enter your code')).toBeOnTheScreen();
    // No session until the code is accepted.
    expect(useSession.getState().session).toBeNull();
    await enterCode('12345');
    expect(await screen.findByText(/Enter the 6-digit code/)).toBeOnTheScreen();
    await enterCode('111111');
    expect(await screen.findByText(/That code is not right/)).toBeOnTheScreen();
    await enterCode(DEMO_CODE);
    await waitFor(() => expect(useSession.getState().session?.user.email).toBe('finance@example.com'));
    expect(useSession.getState().session?.company.name).toBe('Northfield Trading Ltd');
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
    await expect(getProviderClient().listBalances()).resolves.toHaveLength(3);
  });

  it('offers a recovery code in place of the authenticator code', async () => {
    const spy = jest.spyOn(getAuthClient(), 'completeSignIn');
    await renderScreen(<SignInScreen />);
    await enterCredentials();
    await fireEvent.press(await screen.findByTestId('sign-in-toggle-method'));
    expect(await screen.findByText('Use a recovery code')).toBeOnTheScreen();
    await enterCode(DEMO_RECOVERY_CODE);
    await waitFor(() => expect(useSession.getState().session).not.toBeNull());
    expect(spy).toHaveBeenCalledWith(expect.any(String), DEMO_RECOVERY_CODE, 'recovery');
  });

  it('shows wrong details, lockout and an expired attempt in plain words', async () => {
    const auth = getAuthClient();
    await renderScreen(<SignInScreen />);

    jest.spyOn(auth, 'signIn').mockRejectedValueOnce(new ProviderError('validation', { reason: 'invalid_credentials' }));
    await enterCredentials();
    expect(await screen.findByText(/do not match an account/)).toBeOnTheScreen();

    jest.spyOn(auth, 'signIn').mockRejectedValueOnce(new ProviderError('rate_limited', { reason: 'locked', retryAfterSeconds: 100 }));
    await fireEvent.changeText(screen.getByTestId('sign-in-password'), 'another password');
    await fireEvent.press(screen.getByTestId('sign-in-continue'));
    expect(await screen.findByText(/Too many attempts\. Try again in about 2 minutes\./)).toBeOnTheScreen();

    jest.restoreAllMocks();
    await fireEvent.changeText(screen.getByTestId('sign-in-password'), 'another password');
    await fireEvent.press(screen.getByTestId('sign-in-continue'));
    jest.spyOn(auth, 'completeSignIn').mockRejectedValueOnce(new ProviderError('validation', { reason: 'code_reused' }));
    await enterCode('222222');
    expect(await screen.findByText(/already been used/)).toBeOnTheScreen();

    jest.spyOn(auth, 'completeSignIn').mockRejectedValueOnce(new ProviderError('validation', { reason: 'challenge_expired' }));
    await enterCode('333333');
    expect(await screen.findByText(/That took too long\. Start again\./)).toBeOnTheScreen();
    // Back to the first step, with the password field empty.
    expect(screen.getByTestId('sign-in-password').props.value).toBe('');
  });

  it('asks which company when the person has more than one', async () => {
    const demo = installMockBackend();
    const companies = [
      { id: 'co-a', name: 'Alpha Ltd' },
      { id: 'co-b', name: 'Beta Ltd' },
    ];
    const session: Session = {
      user: { id: 'u1', email: 'finance@example.com', displayName: 'Finance' },
      company: { id: 'co-b', name: 'Beta Ltd' },
      role: 'admin',
      capabilities: { forwardContracts: false, paymentApprovals: false },
      stepUpActions: ['payment.create'],
    };
    const selectCompany = jest.fn(async () => session);
    setProviderBackendForTests({
      client: demo.client,
      auth: { ...demo.auth, completeSignIn: async () => ({ user: session.user, companies, session: null }), selectCompany },
    });
    await renderScreen(<SignInScreen />);
    await enterCredentials();
    await enterCode(DEMO_CODE);
    expect(await screen.findByText('Choose a company')).toBeOnTheScreen();
    expect(useSession.getState().session).toBeNull();
    await fireEvent.press(screen.getByTestId('company-co-b'));
    await waitFor(() => expect(useSession.getState().session?.company.name).toBe('Beta Ltd'));
    expect(selectCompany).toHaveBeenCalledWith('co-b');
  });

  it('shows the approved headline, placeholder wording for assurances, and why the person was signed out', async () => {
    useSession.setState({ signedOutReason: 'inactive' });
    await renderScreen(<SignInScreen />);
    expect(screen.getByText('Connecting Businesses Globally')).toBeOnTheScreen();
    expect(screen.getByText('Sign in to manage your currency accounts.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Global Connect')).toBeOnTheScreen();
    expect(screen.getByText(disclosures.signInAssurance)).toBeOnTheScreen();
    expect(screen.getByText(/in the background for a while/)).toBeOnTheScreen();
  });

  it('has no emailed-link sign-in left anywhere in the app source', () => {
    const src = path.resolve(__dirname, '..', '..');
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
        return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
      });
    const offenders = walk(src).filter((file) => /magic[-_ ]?link|deviceSecret|device_secret|login link/i.test(fs.readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(src, file))).toEqual([]);
    expect(fs.existsSync(path.join(src, 'app', 'magic-link.tsx'))).toBe(false);
  });
});
