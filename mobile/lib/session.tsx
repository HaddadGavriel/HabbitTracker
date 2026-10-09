import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { createProfile, readProfile } from './api';
import { supabase } from './supabase';
import { SessionStore } from './session-store';
const Context = createContext<SessionStore | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new SessionStore(supabase.auth, { readProfile, createProfile }));
  useEffect(() => {
    void store.start();
    const refresh = (state: string) => state === 'active' ? supabase.auth.startAutoRefresh() : supabase.auth.stopAutoRefresh();
    refresh(AppState.currentState);
    const subscription = AppState.addEventListener('change', refresh);
    return () => { store.stop(); subscription.remove(); supabase.auth.stopAutoRefresh(); };
  }, [store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useSession() {
  const store = useContext(Context);
  if (!store) throw new Error('SessionProvider is required');
  return { ...useSyncExternalStore(store.subscribe, store.snapshot), store };
}
