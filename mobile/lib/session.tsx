import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState, View } from 'react-native';
import { createProfile, readProfile, updateProfile } from './api';
import { supabase } from './supabase';
import { SessionStore } from './session-store';
import { notificationService, startNotificationListeners } from './notification-runtime';
import { NotificationCleanupNotice } from '../components/notification-controls';
const Context = createContext<SessionStore | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new SessionStore(supabase.auth, { readProfile, createProfile, updateProfile }, notificationService));
  useEffect(() => {
    const stopNotifications = startNotificationListeners();
    void store.start();
    const refresh = (state: string) => state === 'active' ? supabase.auth.startAutoRefresh() : supabase.auth.stopAutoRefresh();
    refresh(AppState.currentState);
    const subscription = AppState.addEventListener('change', refresh);
    return () => { stopNotifications(); store.stop(); subscription.remove(); supabase.auth.stopAutoRefresh(); };
  }, [store]);
  return <Context.Provider value={store}><View style={{ flex: 1 }}><NotificationCleanupNotice />{children}</View></Context.Provider>;
}
export function useSession() {
  const store = useContext(Context);
  if (!store) throw new Error('SessionProvider is required');
  return { ...useSyncExternalStore(store.subscribe, store.snapshot), store };
}
