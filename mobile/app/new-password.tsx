import { Button } from '../components/ui';
import { useState } from 'react';
import { Text } from 'react-native';
import { Field, Form, Message, styles } from '../components/form';
import { useAuthLink } from '../lib/auth-link-context';
export default function NewPassword() {
  const { store, email, error } = useAuthLink();
  const [password, setPassword] = useState(''), [confirm, setConfirm] = useState(''), [busy, setBusy] = useState(false);
  async function save() { if (busy) return; setBusy(true); try { await store.updatePassword(password, confirm); } finally { setPassword(''); setConfirm(''); setBusy(false); } }
  return <Form><Text style={styles.title}>Set a new password</Text><Text>Recovering {email}</Text>
    <Field label="New password" value={password} onChangeText={setPassword} editable={!busy} secureTextEntry autoCapitalize="none" autoComplete="new-password" />
    <Field label="Confirm new password" value={confirm} onChangeText={setConfirm} editable={!busy} secureTextEntry autoCapitalize="none" autoComplete="new-password" />
    <Text>Use at least 6 characters and meet the password requirements configured for this app.</Text><Message text={error ?? null} />
    <Button title={busy ? 'Updating…' : 'Update password'} disabled={busy} onPress={save} /><Button title="Cancel recovery" onPress={store.cancel} />
  </Form>;
}
