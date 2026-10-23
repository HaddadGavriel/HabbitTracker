import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { AccountDeletionStore, type DeletionReceipt } from './account-deletion-store';
import { beginAccountDeletion, recoverAccountDeletion } from './api';
import { supabase } from './supabase';
import { notificationService } from './notification-runtime';
import { localReminderService } from './local-reminder-runtime';
import { reminderService } from './reminder-runtime';
import { notificationTaps } from './notification-tap-runtime';
import type { SessionStore } from './session-store';
const key = 'account-deletion-receipt-v1';
type Sessions = Pick<SessionStore, 'snapshot' | 'subscribe' | 'signOut'>;
export function createAccountDeletionStore(sessions: Sessions) {
  const currentOwner = () => {
    const state = sessions.snapshot();
    return state.session?.user.id ?? (state.status === 'signed_out' ? null : undefined);
  };
  return new AccountDeletionStore({
    async load() {
      const value = await AsyncStorage.getItem(key);
      if (!value) return [];
      const journal = JSON.parse(value);
      // Read v1 without discarding its unresolved capability. The next durable
      // write upgrades the same key atomically to an account-indexed journal.
      const entries: DeletionReceipt[] = journal?.version === 2 ? journal.entries : [journal];
      if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.receipt !== 'string'
        || !/^[0-9a-f]{64}$/.test(entry.receipt) || typeof entry.owner !== 'string' || !entry.owner)
        || new Set(entries.map(e => e.owner)).size !== entries.length
        || new Set(entries.map(e => e.receipt)).size !== entries.length) throw new Error('Invalid recovery state');
      return entries;
    },
    save: entries => entries.length ? AsyncStorage.setItem(key, JSON.stringify({ version: 2, entries })) : AsyncStorage.removeItem(key),
    currentOwner, subscribeAccount: sessions.subscribe,
    newReceipt: () => Array.from(Crypto.getRandomBytes(32), n => n.toString(16).padStart(2, '0')).join(''),
    async begin(password, receipt, expectedUser) {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session || data.session.user.id !== expectedUser || currentOwner() !== expectedUser) throw new Error('Account changed. Review deletion again.');
      return beginAccountDeletion(data.session, password, receipt);
    },
    recover: recoverAccountDeletion,
    async cleanup(owner) {
      // Recovery may complete long after another account has signed in. Keep
      // its receipt and defer device-wide cleanup; never sign out that account.
      let switched = false;
      const safe = () => !switched && (currentOwner() === owner || currentOwner() === null);
      const stop = sessions.subscribe(() => {
        const active = currentOwner();
        if (active !== null && active !== owner) switched = true;
      });
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw new Error('Unable to verify local account');
        if (!safe() || (data.session && (data.session.user.id !== owner || currentOwner() !== owner))) return false;
        if (currentOwner() === owner) await sessions.signOut();
        if (!safe()) return false;
        if (currentOwner() !== null) throw new Error('Local session cleanup failed');
        // Fence every continuation. An account switch during an awaited step
        // leaves the receipt available and prevents subsequent global cleanup.
        for (const cleanup of [
          () => notificationTaps.clearForAccountDeletion(safe),
          () => reminderService.clearForAccountDeletion(owner),
          () => localReminderService.beforeAccountDeletion(safe),
          () => notificationService.forgetDeletedAccount(owner, safe),
          () => Notifications.cancelAllScheduledNotificationsAsync(),
          () => Notifications.dismissAllNotificationsAsync(),
          () => Notifications.clearLastNotificationResponseAsync(),
          () => Notifications.setBadgeCountAsync(0),
        ]) {
          if (!safe()) return false;
          await cleanup();
        }
        if (!safe()) return false;
        const keys = await AsyncStorage.getAllKeys();
        if (!safe()) return false;
        // Shared service journals are cleared through their serialized services.
        // Never delete another owner's stored reminder requests.
        await AsyncStorage.multiRemove(keys.filter(k => k.startsWith(`friend-reminders-v1:${encodeURIComponent(owner)}:`)));
        return safe();
      } finally { stop(); }
    },
  });
}
