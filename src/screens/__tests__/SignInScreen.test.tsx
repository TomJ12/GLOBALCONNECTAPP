import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { MOCK_MAGIC_LINK_CODE } from '@/api/adapters/currencycloud/mockServer';
import { MagicLinkScreen } from '@/screens/MagicLinkScreen';
import { SignInScreen } from '@/screens/SignInScreen';
import { useSession } from '@/state/session';
import { installMockBackend, renderScreen, setControls } from '@/test/utils';

const expoRouter = jest.requireMock<{ __setParams: (params: Record<string, string>) => void; router: { replace: jest.Mock } }>('expo-router');

async function requestLink(): Promise<void> {
  await fireEvent.changeText(screen.getByLabelText('Registered email address'), 'finance@example.com');
  await fireEvent.press(screen.getByRole('button', { name: 'Send secure login link' }));
  expect(await screen.findByText('Check your email')).toBeOnTheScreen();
}

describe('SignInScreen', () => {
  beforeEach(() => {
    installMockBackend();
    useSession.setState({ session: null, signedOutReason: null });
  });

  it('validates the email before sending anything', async () => {
    await renderScreen(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Send secure login link' }));
    expect(await screen.findByText(/Enter a valid email address/)).toBeOnTheScreen();
    expect(screen.queryByText('Check your email')).not.toBeOnTheScreen();
  });

  it('signs in with the code typed from the email', async () => {
    await renderScreen(<SignInScreen />);
    await requestLink();
    await fireEvent.changeText(screen.getByTestId('magic-code'), MOCK_MAGIC_LINK_CODE);
    await fireEvent.press(screen.getByTestId('verify-code'));
    await waitFor(() => expect(useSession.getState().session?.user.email).toBe('finance@example.com'));
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

  it('offers no unlock of any kind: email is the only way in', async () => {
    useSession.setState({ signedOutReason: 'inactive' });
    await renderScreen(<SignInScreen />);
    expect(screen.getByText(/signed out because the app was in the background/)).toBeOnTheScreen();
    expect(screen.queryByText(/unlock/i)).not.toBeOnTheScreen();
    expect(screen.getByLabelText('Registered email address')).toBeOnTheScreen();
  });

  it('shows a readable message when the service is down', async () => {
    setControls({ forcedError: 'network' });
    await renderScreen(<SignInScreen />);
    await fireEvent.changeText(screen.getByLabelText('Registered email address'), 'finance@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Send secure login link' }));
    expect(await screen.findByText(/We could not reach the service/)).toBeOnTheScreen();
  });
});

describe('MagicLinkScreen (deep link)', () => {
  beforeEach(() => {
    useSession.setState({ session: null, signedOutReason: null });
    expoRouter.router.replace.mockClear();
  });

  it('verifies the link in the URL and signs in', async () => {
    const mock = installMockBackend();
    const link = await mock.client.requestMagicLink('finance@example.com');
    expoRouter.__setParams({ request: link.requestId, code: MOCK_MAGIC_LINK_CODE });
    await renderScreen(<MagicLinkScreen />);
    await waitFor(() => expect(useSession.getState().session?.user.email).toBe('finance@example.com'));
    expect(expoRouter.router.replace).toHaveBeenCalledWith('/');
  });

  it('explains a bad or incomplete link and does not sign in', async () => {
    installMockBackend();
    expoRouter.__setParams({ request: 'nope', code: 'nope' });
    await renderScreen(<MagicLinkScreen />);
    expect(await screen.findByText(/not valid or has expired/)).toBeOnTheScreen();
    expect(useSession.getState().session).toBeNull();
  });

  it('handles a link with missing parts', async () => {
    installMockBackend();
    expoRouter.__setParams({});
    await renderScreen(<MagicLinkScreen />);
    expect(screen.getByText(/incomplete/)).toBeOnTheScreen();
  });
});
