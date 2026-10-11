import { Stack } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { SessionProvider, useSession } from '../lib/session';
import { routeAccess } from '../lib/session-store';
Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
function Routes() {
  const { status, session } = useSession();
  const access = routeAccess(status);
  return <Stack key={session?.user.id ?? 'signed-out'} screenOptions={{ headerTitle: 'Habit Tracker', animation: 'none' }}>
    <Stack.Protected guard={access.pending}><Stack.Screen name="index" /></Stack.Protected>
    <Stack.Protected guard={access.auth}><Stack.Screen name="sign-in" /><Stack.Screen name="sign-up" /></Stack.Protected>
    <Stack.Protected guard={access.onboarding}><Stack.Screen name="onboarding" /></Stack.Protected>
    <Stack.Protected guard={access.home}><Stack.Screen name="home" /><Stack.Screen name="my-habits" options={{ headerTitle: 'My habits' }} /><Stack.Screen name="create-habit" options={{ headerTitle: 'Create habit' }} /><Stack.Screen name="diagnostics" options={{ title: 'Infrastructure diagnostics' }} /></Stack.Protected>
  </Stack>;
}
export default function RootLayout() { return <SessionProvider><Routes /></SessionProvider>; }
