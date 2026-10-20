import { notificationService } from '../lib/notification-runtime';
import { NotificationTapGate } from '../components/notification-tap-gate';
import { Stack } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { SessionProvider, useSession } from '../lib/session';
import { AuthLinkProvider, useAuthLink } from '../lib/auth-link-context';
import { routeAccess } from '../lib/session-store';
Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: notificationService.canPresent(), shouldShowList: notificationService.canPresent(), shouldPlaySound: notificationService.canPresent(), shouldSetBadge: false }) });
function Routes() {
  const { status, session } = useSession();
  const access = routeAccess(status);
  const link = useAuthLink();
  return <><NotificationTapGate ready={link.phase === 'idle' && access.home} /><Stack key={session?.user.id ?? 'signed-out'} screenOptions={{ headerTitle: 'Habit Tracker', animation: 'none' }}>
    <Stack.Protected guard={link.phase === 'recovery'}><Stack.Screen name="new-password" /></Stack.Protected>
    <Stack.Protected guard={link.phase !== 'idle' && link.phase !== 'recovery'}><Stack.Screen name="auth-callback" /></Stack.Protected>
    <Stack.Protected guard={link.phase === 'idle' && access.pending}><Stack.Screen name="index" /></Stack.Protected>
    <Stack.Protected guard={link.phase === 'idle' && access.auth}><Stack.Screen name="sign-in" /><Stack.Screen name="sign-up" /><Stack.Screen name="forgot-password" /></Stack.Protected>
    <Stack.Protected guard={link.phase === 'idle' && access.onboarding}><Stack.Screen name="onboarding" /></Stack.Protected>
    <Stack.Protected guard={link.phase === 'idle' && access.home}><Stack.Screen name="home" /><Stack.Screen name="settings" options={{ headerTitle: 'Settings' }} /><Stack.Screen name="friends" options={{ headerTitle: 'Friends' }} /><Stack.Screen name="manage-sharing" options={{ headerTitle: 'Manage sharing' }} /><Stack.Screen name="shared-habits" options={{ headerTitle: "Friends’ habits" }} /><Stack.Screen name="pending-excuses" options={{ headerTitle: 'Pending decisions' }} /><Stack.Screen name="excuse-detail" options={{ headerTitle: 'Excuse details' }} /><Stack.Screen name="shared-habit" options={{ headerTitle: 'Shared habit' }} /><Stack.Screen name="today" options={{ headerTitle: 'Today' }} /><Stack.Screen name="my-habits" options={{ headerTitle: 'My habits' }} /><Stack.Screen name="create-habit" options={{ headerTitle: 'Create habit' }} /><Stack.Screen name="edit-habit" options={{ headerTitle: 'Edit habit' }} /><Stack.Screen name="habit-history" options={{ headerTitle: 'Habit history' }} /><Stack.Screen name="diagnostics" options={{ title: 'Infrastructure diagnostics' }} /></Stack.Protected>
  </Stack></>;
}
export default function RootLayout() { return <SessionProvider><AuthLinkProvider><Routes /></AuthLinkProvider></SessionProvider>; }
