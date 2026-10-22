import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState, View } from 'react-native';
import { createProfile, readProfile, updateProfile } from './api';
import { supabase } from './supabase';
import { SessionStore } from './session-store';
import { notificationService, startNotificationListeners } from './notification-runtime';
import * as Notifications from 'expo-notifications';
import { notificationTaps } from './notification-tap-runtime';
import { listenNotificationTaps } from './notification-taps';
import { reminderService } from './reminder-runtime';
import { localReminderService, startLocalReminderListeners } from './local-reminder-runtime';
import { NotificationCleanupNotice } from '../components/notification-controls';
const Context = createContext<SessionStore | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new SessionStore(supabase.auth, { readProfile, createProfile, updateProfile }, {
    async setSession(session, cleanupSession) {
      // SessionStore invokes this synchronously at auth transitions and awaits
      // it before explicit sign-out. Local cleanup never needs old credentials.
      // Both services must fence immediately. Waiting for local cleanup before
      // notifying the remote service could deliver an old logout after B signs in.
      const local = !session ? localReminderService.disable() : Promise.resolve();
      const remote = notificationService.setSession(session, cleanupSession);
      await Promise.all([local, remote]);
    },
  }));
  useEffect(() => {
    const stopTaps = listenNotificationTaps(Notifications, notificationTaps);
    const stopLocalReminders = startLocalReminderListeners();
    const stopNotifications = startNotificationListeners();
    const syncSession = () => {
      const state = store.snapshot();
      notificationTaps.setSession(state);
      reminderService.setSession(state.status === 'ready' ? state.session : null);
      void localReminderService.setSession(state);
    };
    const stopSessionSync = store.subscribe(syncSession);
    syncSession();
    void store.start();
    const refresh = (state: string) => {
      notificationTaps.setForeground(state === 'active');
      if (state === 'active') supabase.auth.startAutoRefresh(); else supabase.auth.stopAutoRefresh();
    };
    refresh(AppState.currentState);
    const subscription = AppState.addEventListener('change', refresh);
    return () => {
      stopTaps(); notificationTaps.stop(); stopSessionSync(); reminderService.setSession(null);
      stopLocalReminders();
      stopNotifications(); store.stop(); subscription.remove(); supabase.auth.stopAutoRefresh();
    };
  }, [store]);
  return <Context.Provider value={store}><View style={{ flex: 1 }}><NotificationCleanupNotice />{children}</View></Context.Provider>;
}
export function useSession() {
  const store = useContext(Context);
  if (!store) throw new Error('SessionProvider is required');
  return { ...useSyncExternalStore(store.subscribe, store.snapshot), store };
}
