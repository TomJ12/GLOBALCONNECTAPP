import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import fs from 'fs';
import path from 'path';

import { getProviderClient } from '@/api';
import { MOCK_MAGIC_LINK_CODE } from '@/api/adapters/currencycloud/mockServer';
import { disclosures } from '@/config/disclosures';
import { loadSignInAttempt, saveSignInAttempt } from '@/lib/signInAttempt';
import { MagicLinkScreen } from '@/screens/MagicLinkScreen';
import { SignInScreen } from '@/screens/SignInScreen';
import { useSession } from '@/state/session';
import { installMockBackend, renderScreen, setControls, TEST_DEVICE_SECRET } from '@/test/utils';

const expoRouter = jest.requireMock<{ __setParams: (params: Record<string, string>) => void; router: { replace: jest.Mock } }>('expo-router');

async function requestLink(): Promise<void> {
  await fireEvent.changeText(screen.getByLabelText('Registered email address'), 'finance@example.com');
  await fireEvent.press(screen.getByRole('button', { name: 'Send login link' }));
  expect(await screen.findByText('Check your email')).toBeOnTheScreen();
}

beforeEach(async () => {
  installMockBackend();
  useSession.setState({ session: null, signedOutReason: null });
  await AsyncStorage.clear();
  expoRouter.router.replace.mockClear();
});

describe('SignInScreen', () => {
  it('validates the email before sending anything', async () => {
    await renderScreen(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Send login link' }));
    expect(await screen.findByText(/Enter a valid email address/)).toBeOnTheScreen();
    expect(screen.queryByText('Check your email')).not.toBeOnTheScreen();
  });

  it('signs in with the code typed from the email, then forgets the sign-in secret', async () => {
    const requestSpy = jest.spyOn(getProviderClient(), 'requestMagicLink');
    await renderScreen(<SignInScreen />);
    await requestLink();
    // A fresh random secret is made for each request and kept on this device until sign-in completes.
    const secret = requestSpy.mock.calls[0]?.[1] ?? '';
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await loadSignInAttempt())?.secret).toBe(secret);

    await fireEvent.changeText(screen.getByTestId('magic-code'), MOCK_MAGIC_LINK_CODE);
    await fireEvent.press(screen.getByTestId('verify-code'));
    await waitFor(() => expect(useSession.getState().session?.user.email).toBe('finance@example.com'));
    expect(await loadSignInAttempt()).toBeNull();
  });

  it('rejects a wrong or empty code with a clear message and stays signed out', async () => {
    await renderScreen(<SignInScreen />);
    await requestLink();
    await fireEvent.press(screen.getByTestId('verify-code'));
    expect(await screen.findByText('Error: Enter the code from the email.')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByTestId('magic-code'), 'WRONG');
    await fireEvent.press(screen.getByTestId('verify-code'));
    expect(await screen.findByText(/not valid or has expired/)).toBeOnTheScreen();
    expect(useSession.getState().session).toBeNull();
  });

  it('the developer shortcut completes the link on the mock', async () => {
    await renderScreen(<SignInScreen />);
    await requestLink();
    await fireEvent.press(screen.getByTestId('dev-complete-link'));
    await waitFor(() => expect(useSession.getState().session).not.toBeNull());
  });

  it('offers no unlock and no route to settings or the developer panel while signed out', async () => {
    useSession.setState({ signedOutReason: 'inactive' });
    await renderScreen(<SignInScreen />);
    expect(screen.getByText(/signed out because the app was in the background/)).toBeOnTheScreen();
    expect(screen.queryByText(/unlock/i)).not.toBeOnTheScreen();
    expect(screen.queryByText(/developer settings/i)).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /settings/i })).not.toBeOnTheScreen();
    // The settings route lives inside the signed-in group, whose layout redirects to sign-in without a session.
    const app = path.resolve(__dirname, '../../app');
    expect(fs.existsSync(path.join(app, 'settings.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(app, '(app)', 'settings.tsx'))).toBe(true);
    expect(fs.readFileSync(path.join(app, '(app)', '_layout.tsx'), 'utf8')).toMatch(/if \(!signedIn\) return <Redirect href="\/sign-in" \/>/);
  });

  it('takes its claims-like wording from disclosures, not from the screen', async () => {
    await renderScreen(<SignInScreen />);
    expect(screen.getByText(disclosures.signInTagline)).toBeOnTheScreen();
    expect(screen.getByText(disclosures.signInAssurance)).toBeOnTheScreen();
    expect(screen.queryByText(/secure/i)).not.toBeOnTheScreen();
    expect(screen.queryByText(/in your pocket/i)).not.toBeOnTheScreen();
  });

  it('shows a readable message when the service is down', async () => {
    setControls({ forcedError: 'network' });
    await renderScreen(<SignInScreen />);
    await fireEvent.changeText(screen.getByLabelText('Registered email address'), 'finance@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Send login link' }));
    expect(await screen.findByText(/We could not reach the service/)).toBeOnTheScreen();
  });
});

describe('MagicLinkScreen (deep link)', () => {
  async function linkRequestedHere(email = 'finance@example.com'): Promise<string> {
    const link = await getProviderClient().requestMagicLink(email, TEST_DEVICE_SECRET);
    await saveSignInAttempt({ requestId: link.requestId, secret: TEST_DEVICE_SECRET });
    return link.requestId;
  }

  it('signs in when the link is opened on the device that requested it', async () => {
    expoRouter.__setParams({ request: await linkRequestedHere(), code: MOCK_MAGIC_LINK_CODE });
    await renderScreen(<MagicLinkScreen />);
    await waitFor(() => expect(useSession.getState().session?.user.email).toBe('finance@example.com'));
    expect(expoRouter.router.replace).toHaveBeenCalledWith('/');
  });

  it('does not sign in on a device that did not request the link, and sends nothing', async () => {
    // Requested elsewhere: this device has no secret for it.
    const link = await getProviderClient().requestMagicLink('finance@example.com', TEST_DEVICE_SECRET);
    const verifySpy = jest.spyOn(getProviderClient(), 'verifyMagicLink');
    expoRouter.__setParams({ request: link.requestId, code: MOCK_MAGIC_LINK_CODE });
    await renderScreen(<MagicLinkScreen />);
    expect(await screen.findByText(/was not requested on this device/)).toBeOnTheScreen();
    expect(verifySpy).not.toHaveBeenCalled();
    expect(useSession.getState().session).toBeNull();
  });

  it('does not sign in with a secret from a different attempt', async () => {
    const link = await getProviderClient().requestMagicLink('finance@example.com', TEST_DEVICE_SECRET);
    await saveSignInAttempt({ requestId: link.requestId, secret: 'b'.repeat(64) });
    expoRouter.__setParams({ request: link.requestId, code: MOCK_MAGIC_LINK_CODE });
    await renderScreen(<MagicLinkScreen />);
    expect(await screen.findByText(/not valid or has expired/)).toBeOnTheScreen();
    expect(useSession.getState().session).toBeNull();
  });

  it('never replaces an existing session without asking', async () => {
    const client = getProviderClient();
    const first = await client.requestMagicLink('first@example.com', TEST_DEVICE_SECRET);
    useSession.getState().startSession(await client.verifyMagicLink(first.requestId, MOCK_MAGIC_LINK_CODE, TEST_DEVICE_SECRET));
    const verifySpy = jest.spyOn(client, 'verifyMagicLink');

    expoRouter.__setParams({ request: await linkRequestedHere('second@example.com'), code: MOCK_MAGIC_LINK_CODE });
    await renderScreen(<MagicLinkScreen />);
    expect(await screen.findByText('Switch account?')).toBeOnTheScreen();
    expect(screen.getByText(/You are signed in as first@example.com/)).toBeOnTheScreen();
    expect(verifySpy).not.toHaveBeenCalled();
    expect(useSession.getState().session?.user.email).toBe('first@example.com');

    await fireEvent.press(screen.getByTestId('magic-stay'));
    expect(expoRouter.router.replace).toHaveBeenCalledWith('/');
    expect(verifySpy).not.toHaveBeenCalled();
    expect(useSession.getState().session?.user.email).toBe('first@example.com');
  });

  it('switches account only after the person chooses to', async () => {
    const client = getProviderClient();
    const first = await client.requestMagicLink('first@example.com', TEST_DEVICE_SECRET);
    useSession.getState().startSession(await client.verifyMagicLink(first.requestId, MOCK_MAGIC_LINK_CODE, TEST_DEVICE_SECRET));
    expoRouter.__setParams({ request: await linkRequestedHere('second@example.com'), code: MOCK_MAGIC_LINK_CODE });
    await renderScreen(<MagicLinkScreen />);
    await fireEvent.press(await screen.findByTestId('magic-switch'));
    await waitFor(() => expect(useSession.getState().session?.user.email).toBe('second@example.com'));
    expect(expoRouter.router.replace).toHaveBeenCalledWith('/');
  });

  it('explains a bad link and a link with missing parts', async () => {
    await saveSignInAttempt({ requestId: 'nope', secret: TEST_DEVICE_SECRET });
    expoRouter.__setParams({ request: 'nope', code: 'nope' });
    await renderScreen(<MagicLinkScreen />);
    expect(await screen.findByText(/not valid or has expired/)).toBeOnTheScreen();
    expect(useSession.getState().session).toBeNull();
    await screen.unmount();

    expoRouter.__setParams({});
    await renderScreen(<MagicLinkScreen />);
    expect(screen.getByText(/incomplete/)).toBeOnTheScreen();
  });
});
