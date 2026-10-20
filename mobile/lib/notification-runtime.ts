import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AppState, Linking, Platform } from 'react-native';
import { registerDevice, unregisterDevice } from './api';
import { NotificationService, type NotificationJournal } from './notification-service';

const storageKey = 'notification-registration-v1';
export const FRIEND_REMINDERS_CHANNEL = 'friend-reminders';
export const INFRASTRUCTURE_CHANNEL = 'infrastructure-tests';

// Native/network operations must not hold logout or previous credentials forever.
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Notification operation timed out')), 30_000);
    })]);
  } finally { clearTimeout(timer); }
}
export async function prepareNotificationChannels() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(FRIEND_REMINDERS_CHANNEL, {
    name: 'Friend reminders', importance: Notifications.AndroidImportance.DEFAULT,
    sound: 'default', lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
  await Notifications.setNotificationChannelAsync(INFRASTRUCTURE_CHANNEL, {
    name: 'Infrastructure tests', importance: Notifications.AndroidImportance.DEFAULT,
    sound: 'default', lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
}
export async function notificationPermission(request: boolean) {
  let permission = await Notifications.getPermissionsAsync();
  const allowed = () => Platform.OS === 'ios' ? [
    Notifications.IosAuthorizationStatus.AUTHORIZED, Notifications.IosAuthorizationStatus.PROVISIONAL,
    Notifications.IosAuthorizationStatus.EPHEMERAL,
  ].includes(permission.ios?.status ?? Notifications.IosAuthorizationStatus.NOT_DETERMINED) : permission.granted;
  if (!allowed() && request && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
  if (!allowed()) return false;
  if (Platform.OS === 'android') {
    const channel = await Notifications.getNotificationChannelAsync(FRIEND_REMINDERS_CHANNEL);
    if (channel?.importance === Notifications.AndroidImportance.NONE) return false;
  }
  return true;
}
export async function openNotificationSettings() {
  if (Platform.OS === 'android') {
    const packageName = Constants.expoConfig?.android?.package;
    if (packageName) {
      try {
        await Linking.sendIntent('android.settings.APP_NOTIFICATION_SETTINGS', [
          { key: 'android.provider.extra.APP_PACKAGE', value: packageName },
        ]);
        return;
      } catch { /* Older devices can still open the application's settings. */ }
    }
  }
  await Linking.openSettings();
}
export const notificationService = new NotificationService({
  async load() {
    const value = await bounded(AsyncStorage.getItem(storageKey));
    if (!value) return null;
    const parsed = JSON.parse(value) as NotificationJournal;
    if (!Array.isArray(parsed.registrations) || !(parsed.enabledUser === null || typeof parsed.enabledUser === 'string') ||
      parsed.registrations.some(entry => typeof entry.userId !== 'string' || typeof entry.registrationId !== 'string')) {
      throw new Error('Invalid notification journal');
    }
    return parsed;
  },
  save: journal => bounded(AsyncStorage.setItem(storageKey, JSON.stringify(journal))),
  newId: () => Crypto.randomUUID(),
  prepareChannels: () => bounded(prepareNotificationChannels()),
  permission: request => bounded(notificationPermission(request)),
  async getToken() {
    if (!Device.isDevice || (Platform.OS !== 'android' && Platform.OS !== 'ios')) throw new Error('Use a physical device build');
    const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID || Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
    if (!projectId || projectId.startsWith('REPLACE_')) throw new Error('Missing EAS project ID');
    return (await bounded(Notifications.getExpoPushTokenAsync({ projectId }))).data;
  },
  async register(session, token, registrationId) {
    const result = await registerDevice(session, token, registrationId, Platform.OS === 'ios' ? 'ios' : 'android');
    if (!result.registered || result.registration_id !== registrationId) throw new Error('Unconfirmed registration');
  },
  async unregister(session, registrationId) {
    const result = await unregisterDevice(session, registrationId);
    if (typeof result.removed !== 'boolean') throw new Error('Unconfirmed cleanup');
  },
  async clearPresented() {
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return;
    const results = await Promise.allSettled([
      bounded(Notifications.dismissAllNotificationsAsync()),
      bounded(Notifications.setBadgeCountAsync(0)),
      bounded(Notifications.clearLastNotificationResponseAsync()),
    ]);
    if (results.some(result => result.status === 'rejected')) throw new Error('Unable to clear presented notifications');
  },
});

export function startNotificationListeners() {
  const token = Notifications.addPushTokenListener(() => { void notificationService.tokenChanged(); });
  const foreground = AppState.addEventListener('change', state => {
    if (state === 'active') void notificationService.refresh(true);
  });
  return () => { token.remove(); foreground.remove(); };
}
