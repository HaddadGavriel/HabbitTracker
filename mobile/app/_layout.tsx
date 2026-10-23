import { Text } from 'react-native';
import { Form, styles } from '../components/form';
import { AccountDeletionGate } from '../components/account-deletion-gate';
import { notificationService } from '../lib/notification-runtime';
import { NotificationTapGate } from '../components/notification-tap-gate';
import { Stack, router, type ErrorBoundaryProps } from 'expo-router';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '../components/ui';
import * as Notifications from 'expo-notifications';
import { SessionProvider, useSession } from '../lib/session';
import { AuthLinkProvider, useAuthLink } from '../lib/auth-link-context';
import { routeAccess } from '../lib/session-store';
Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: notificationService.canPresent(), shouldShowList: notificationService.canPresent(), shouldPlaySound: notificationService.canPresent(), shouldSetBadge: false }) });
export const unstable_settings = { initialRouteName: 'today' };
function Routes() {
  const { status, session } = useSession();
  const access = routeAccess(status);
  const link = useAuthLink();
  return <><NotificationTapGate ready={link.phase === 'idle' && access.home} /><Stack key={session?.user.id ?? 'signed-out'} screenOptions={({ navigation, route }) => ({ headerTitle: 'Habit Tracker', animation: 'none',
      headerRight: () => access.home && link.phase === 'idle' ? <Button title="Menu" accessibilityLabel="Open navigation menu" onPress={() => router.navigate('/home')} /> : null,
      ...(!navigation.canGoBack() && route.name !== 'today' && access.home && link.phase === 'idle' ? { headerLeft: () => <Button title="Today" accessibilityLabel="Go to Today" onPress={() => router.dismissTo('/today')} /> } : {}),
    })}>
    <Stack.Protected guard={link.phase === 'recovery'}><Stack.Screen name="new-password" /></Stack.Protected>
    <Stack.Protected guard={link.phase !== 'idle' && link.phase !== 'recovery'}><Stack.Screen name="auth-callback" /></Stack.Protected>
    <Stack.Protected guard={link.phase === 'idle' && access.pending}><Stack.Screen name="index" /></Stack.Protected>
    <Stack.Protected guard={link.phase === 'idle' && access.auth}><Stack.Screen name="sign-in" /><Stack.Screen name="sign-up" /><Stack.Screen name="forgot-password" /></Stack.Protected>
    <Stack.Protected guard={link.phase === 'idle' && access.onboarding}><Stack.Screen name="onboarding" /></Stack.Protected>
    <Stack.Protected guard={link.phase === 'idle' && access.home}><Stack.Screen name="today" options={{ headerTitle: 'Today' }} /><Stack.Screen name="home" options={{ headerTitle: 'Menu' }} /><Stack.Screen name="settings" options={{ headerTitle: 'Settings' }} /><Stack.Screen name="friends" options={{ headerTitle: 'Friends' }} /><Stack.Screen name="manage-sharing" options={{ headerTitle: 'Manage sharing' }} /><Stack.Screen name="shared-habits" options={{ headerTitle: "Friends’ habits" }} /><Stack.Screen name="pending-excuses" options={{ headerTitle: 'Pending decisions' }} /><Stack.Screen name="excuse-detail" options={{ headerTitle: 'Excuse details' }} /><Stack.Screen name="shared-habit" options={{ headerTitle: 'Shared habit' }} /><Stack.Screen name="my-habits" options={{ headerTitle: 'My habits' }} /><Stack.Screen name="create-habit" options={{ headerTitle: 'Create habit' }} /><Stack.Screen name="edit-habit" options={{ headerTitle: 'Edit habit' }} /><Stack.Screen name="habit-history" options={{ headerTitle: 'Habit history' }} /><Stack.Protected guard={process.env.EXPO_PUBLIC_ENABLE_DIAGNOSTICS === 'true'}><Stack.Screen name="diagnostics" options={{ headerTitle: 'Diagnostics' }} /></Stack.Protected></Stack.Protected>
  </Stack></>;
}
export default function RootLayout() { return <SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: '#f7f9fc' }} edges={['left', 'right', 'bottom']}><SessionProvider><AccountDeletionGate><AuthLinkProvider><Routes /></AuthLinkProvider></AccountDeletionGate></SessionProvider></SafeAreaView></SafeAreaProvider>; }

export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  return <Form standalone><Text accessibilityRole="header" style={styles.title}>Unable to open this screen</Text>
    <Text style={styles.message}>Please retry. If a change was in progress, refresh its saved status before submitting again.</Text>
    <Button title="Retry screen" onPress={() => { void retry(); }} />
  </Form>;
}
