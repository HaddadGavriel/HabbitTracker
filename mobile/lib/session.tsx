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
import { NotificationCleanupNotice } from '../components/notification-controls';
const Context = createContext<SessionStore | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new SessionStore(supabase.auth, { readProfile, createProfile, updateProfile }, notificationService));
  useEffect(() => {
    const stopTaps = listenNotificationTaps(Notifications, notificationTaps);
    const stopNotifications = startNotificationListeners();
    const syncSession = () => {
      const state = store.snapshot();
      notificationTaps.setSession(state);
      reminderService.setSession(state.status === 'ready' ? state.session : null);
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
