import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { SignInScreen } from '@/screens/SignInScreen';
import { useSession } from '@/state/session';
import { installMockBackend, renderScreen, setControls } from '@/test/utils';

describe('SignInScreen', () => {
  beforeEach(async () => {
    installMockBackend();
    useSession.setState({ session: null, remembered: null, signedOutReason: null, hydrated: true });
    await useSession.getState().forgetDevice();
  });

  it('validates the email before sending anything', async () => {
    await renderScreen(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Send secure login link' }));
    expect(await screen.findByText(/Enter a valid email address/)).toBeOnTheScreen();
    expect(screen.queryByText('Check your email')).not.toBeOnTheScreen();
  });

  it('sends a link, completes it with the dev shortcut and offers quick unlock', async () => {
    await renderScreen(<SignInScreen />);
    await fireEvent.changeText(screen.getByLabelText('Registered email address'), 'finance@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Send secure login link' }));
    expect(await screen.findByText('Check your email')).toBeOnTheScreen();
    expect(screen.getByText(/finance@example.com/)).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('dev-complete-link'));
    expect(await screen.findByText('Unlock faster next time?')).toBeOnTheScreen();
    // Not signed in until the person has answered the offer.
    expect(useSession.getState().session).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Turn on quick unlock' }));
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(useSession.getState().session?.user.email).toBe('finance@example.com'));
    expect(useSession.getState().remembered?.biometricEnabled).toBe(true);
  });

  it('signs in without remembering the device when quick unlock is declined', async () => {
    await renderScreen(<SignInScreen />);
    await fireEvent.changeText(screen.getByLabelText('Registered email address'), 'finance@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Send secure login link' }));
    await fireEvent.press(await screen.findByTestId('dev-complete-link'));
    await fireEvent.press(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(useSession.getState().session).not.toBeNull());
    expect(useSession.getState().remembered).toBeNull();
  });

  it('offers unlock to a returning user and shows a clear error when it fails', async () => {
    useSession.setState({ remembered: { email: 'finance@example.com', displayName: 'Sample User', biometricEnabled: true } });
    await renderScreen(<SignInScreen />);
    expect(screen.getByText('Already set up on this phone')).toBeOnTheScreen();
    // No credential is stored, so unlocking must fail safely rather than sign in.
    await fireEvent.press(screen.getByRole('button', { name: 'Unlock' }));
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    // The stale device is forgotten and the email form comes back.
    expect(await screen.findByLabelText('Registered email address')).toBeOnTheScreen();
    expect(useSession.getState().remembered).toBeNull();
    expect(useSession.getState().session).toBeNull();
  });

  it('shows a readable message when the service is down', async () => {
    setControls({ forcedError: 'network' });
    await renderScreen(<SignInScreen />);
    await fireEvent.changeText(screen.getByLabelText('Registered email address'), 'finance@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Send secure login link' }));
    expect(await screen.findByText(/We could not reach the service/)).toBeOnTheScreen();
  });
});
