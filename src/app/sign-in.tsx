import { Redirect } from 'expo-router';

import { SignInScreen } from '@/screens/SignInScreen';
import { useSession } from '@/state/session';

export default function SignInRoute() {
  const signedIn = useSession((state) => state.session !== null);
  if (signedIn) return <Redirect href="/" />;
  return <SignInScreen />;
}
