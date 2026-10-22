import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import { readLocalReminderPlan } from './api';
import { localReminders } from './local-reminders';
import { LocalReminderService } from './local-reminder-service';
import { notificationTaps } from './notification-tap-runtime';

const preferenceKey = 'local-habit-reminders-enabled-v1';
export async function localReminderPermission(request: boolean): Promise<boolean> {
  if (Platform.OS !== 'android' || !localReminders) return false;
  // Create the local channel before Android 13's runtime permission request.
  await Notifications.setNotificationChannelAsync('local-habit-reminders', {
    name: 'Habit reminders', importance: Notifications.AndroidImportance.DEFAULT,
    sound: 'default', lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && request && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
  const channel = await Notifications.getNotificationChannelAsync('local-habit-reminders');
  return permission.granted && channel?.importance !== Notifications.AndroidImportance.NONE;
}
export const localReminderService = new LocalReminderService({
  native: localReminders, readPlan: readLocalReminderPlan, permission: localReminderPermission,
  async loadEnabled() {
    const value = await AsyncStorage.getItem(preferenceKey);
    if (value !== null && !/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid reminder preference');
    return value;
  },
  saveEnabled: owner => owner === null ? AsyncStorage.removeItem(preferenceKey) : AsyncStorage.setItem(preferenceKey, owner),
});

/** Capture cold-start metadata before auth cleanup, then use the same validated,
 * authenticated navigation gate as friend reminders. No payload route is used. */
export function startLocalReminderListeners() {
  let active = true;
  const launch = async () => {
    try {
      const metadata = await localReminders?.launchMetadata();
      if (active && metadata) await notificationTaps.receiveLocal(metadata);
    } catch { /* A native tap failure never prevents ordinary app navigation. */ }
  };
  const taps = localReminders?.addListener('onLaunch', () => { void launch(); });
  void launch();
  const foreground = AppState.addEventListener('change', state => {
    if (state === 'active') void localReminderService.refresh();
  });
  // A bounded foreground refresh also covers an app left open across midnight
  // and a connection returning without another AppState transition. The native
  // recurrence engine continues independently while JS is suspended.
  const timer = setInterval(() => {
    if (AppState.currentState === 'active') void localReminderService.refresh();
  }, 60_000);
  return () => { active = false; taps?.remove(); foreground.remove(); clearInterval(timer); };
}
