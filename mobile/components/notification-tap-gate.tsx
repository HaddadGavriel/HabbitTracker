import { Button } from './ui';
import { useEffect, useSyncExternalStore } from 'react';
import { useRootNavigationState } from 'expo-router';
import { Text, View } from 'react-native';
import { notificationTaps } from '../lib/notification-tap-runtime';
import { styles } from './form';
export function NotificationTapGate({ ready }: { ready: boolean }) {
  const root = useRootNavigationState();
  const message = useSyncExternalStore(notificationTaps.subscribe, notificationTaps.snapshot);
  useEffect(() => {
    notificationTaps.setReady(ready && !!root?.key);
    return () => notificationTaps.setReady(false);
  }, [ready, root?.key]);
  return message && ready ? <View style={{ padding: 12 }}>
    <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text>
    <Button title="Dismiss notification message" onPress={notificationTaps.dismiss} />
  </View> : null;
}
