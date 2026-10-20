import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import * as Linking from 'expo-linking';
import { listenAuthLinks } from './auth-link-listener';
import { Loading, Form } from '../components/form';
import { AuthLinks } from './auth-links';
import { createLinkAuth } from './supabase';
import { useSession } from './session';
const Context = createContext<AuthLinks | null>(null);
export function AuthLinkProvider({ children }: { children: ReactNode }) {
  const { store: sessions } = useSession();
  const [store] = useState(() => new AuthLinks(createLinkAuth, () => sessions.snapshot().session?.user.id));
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    let active = true;
    const listener = listenAuthLinks(Linking, sessions, store);
    void listener.ready.finally(() => { if (active) setInitialized(true); });
    return () => { active = false; listener.stop(); };
  }, [store]);
  return <Context.Provider value={store}>{initialized ? children : <Form><Loading /></Form>}</Context.Provider>;
}
export function useAuthLink() {
  const store = useContext(Context);
  if (!store) throw new Error('AuthLinkProvider required');
  return { ...useSyncExternalStore(store.subscribe, store.snapshot), store };
}
