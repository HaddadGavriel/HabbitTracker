import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button, Text } from 'react-native';
import { Form, Message, styles } from './form';
import { AccountDeletionStore } from '../lib/account-deletion-store';
import { createAccountDeletionStore } from '../lib/account-deletion-runtime';
import { useSession } from '../lib/session';
const Context = createContext<AccountDeletionStore | null>(null);
export function useAccountDeletion() {
  const value = useContext(Context);
  if (!value) throw new Error('Deletion provider is required');
  return value;
}
export function AccountDeletionGate({ children }: { children: ReactNode }) {
  const { store: session } = useSession();
  const [store] = useState(() => createAccountDeletionStore(async () => {
    await session.signOut();
    if (session.snapshot().status !== 'signed_out') throw new Error('Local session cleanup failed');
  }));
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => { void store.start(); }, [store]);
  return <Context.Provider value={store}>{state.phase === 'idle' ? children :
    <Form><Text style={styles.title}>Account deletion</Text>
      <Message text={state.message ?? 'Checking account deletion…'} />
      {state.phase !== 'complete' && <Button title="Check and retry deletion" disabled={state.phase === 'checking'} onPress={store.recover} />}
      {(state.phase === 'not_found' || state.phase === 'complete') && <Button title={state.phase === 'complete' ? 'Continue to sign in' : 'Return to account'} onPress={store.dismiss} />}
    </Form>}</Context.Provider>;
}
