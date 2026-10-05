import { Stack } from 'expo-router';
import * as Notifications from 'expo-notifications';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export default function RootLayout() {
  return <Stack screenOptions={{ headerTitle: 'Infrastructure Test' }} />;
}
