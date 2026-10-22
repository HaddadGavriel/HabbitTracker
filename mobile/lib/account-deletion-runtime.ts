import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { AccountDeletionStore } from './account-deletion-store';
import { beginAccountDeletion, recoverAccountDeletion } from './api';
import { supabase } from './supabase';
import { notificationService } from './notification-runtime';
import { localReminderService } from './local-reminder-runtime';
import { reminderService } from './reminder-runtime';
import { notificationTaps } from './notification-tap-runtime';
const key = 'account-deletion-receipt-v1';
export function createAccountDeletionStore(signOut: () => Promise<void>) {
  let owner: string | null = null;
  return new AccountDeletionStore({
    async load() {
      const value = await AsyncStorage.getItem(key);
      if (!value) return null;
      const journal = JSON.parse(value);
      if (!journal || !/^[0-9a-f]{64}$/.test(journal.receipt) || typeof journal.owner !== 'string') throw new Error('Invalid recovery state');
      owner = journal.owner;
      return journal.receipt;
    },
    async save(receipt, expectedUser) {
      if (owner && owner !== expectedUser) throw new Error('Recovery belongs to a different account.');
      owner = expectedUser;
      await AsyncStorage.setItem(key, JSON.stringify({ receipt, owner }));
    },
    newReceipt: () => Array.from(Crypto.getRandomBytes(32), n => n.toString(16).padStart(2, '0')).join(''),
    async begin(password, receipt, expectedUser) {
      const { data } = await supabase.auth.getSession();
      if (!data.session || data.session.user.id !== expectedUser) throw new Error('Account changed. Review deletion again.');
      return beginAccountDeletion(data.session, password, receipt);
    },
    recover: recoverAccountDeletion,
    async cleanup() {
      const { data } = await supabase.auth.getSession();
      if (data.session && data.session.user.id !== owner) throw new Error('Account changed during deletion. Recovery state retained.');
      await signOut();
      await notificationTaps.clearForAccountDeletion();
      await reminderService.clearForAccountDeletion();
      await Promise.all([localReminderService.beforeAccountDeletion(), notificationService.forgetDeletedAccount()]);
      await Notifications.cancelAllScheduledNotificationsAsync();
      await Notifications.dismissAllNotificationsAsync();
      await Notifications.clearLastNotificationResponseAsync();
      await Notifications.setBadgeCountAsync(0);
      const keys = await AsyncStorage.getAllKeys();
      await AsyncStorage.multiRemove(keys.filter(k => k.startsWith('friend-reminders-v1:') ||
        k === 'handled-notification-taps-v1' || k === 'notification-registration-v1' || k === 'local-habit-reminders-enabled-v1'));
    },
    clear: () => AsyncStorage.removeItem(key),
  });
}
