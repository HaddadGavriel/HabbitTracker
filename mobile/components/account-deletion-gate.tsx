import { Button } from './ui';
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Text, View } from 'react-native';
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
  const [store] = useState(() => createAccountDeletionStore(session));
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => { void store.start(); return store.stop; }, [store]);
  return <Context.Provider value={store}>{state.phase === 'idle' ? <>
    {children}
    {state.saved.length > 0 && <View><Text>Saved account deletions can still be checked.</Text>
      {state.saved.map((entry, index) => <Button key={entry.owner} title={`Check saved deletion ${index + 1}`} onPress={() => store.recover(entry.owner)} />)}
    </View>}
  </> : <Form standalone><Text style={styles.title}>Account deletion</Text>
    <Message text={state.message ?? 'Checking account deletion…'} />
    {state.phase !== 'complete' && <Button title="Check and retry deletion" disabled={state.phase === 'checking'} onPress={() => store.recover()} />}
    {state.canDismiss && <Button title="Continue to app" onPress={store.dismiss} />}
  </Form>}</Context.Provider>;
}
