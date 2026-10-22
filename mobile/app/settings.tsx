import { useAccountDeletion } from '../components/account-deletion-gate';
import { useRef, useState } from 'react';
import { Button, Text } from 'react-native';
import { Link } from 'expo-router';
import { Field, Form, Message, styles } from '../components/form';
import { NotificationControls } from '../components/notification-controls';
import { ApiError } from '../lib/api';
import { profileInput } from '../lib/profile-input';
import { useSession } from '../lib/session';
export default function Settings() {
  const { profile, session, store } = useSession();
  const deletion = useAccountDeletion();
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  async function deleteAccount() {
    try {
      if (!password || confirmation !== 'DELETE MY ACCOUNT') throw new Error('Enter your current password and type DELETE MY ACCOUNT.');
      const value = password; setPassword('');
      if (!session) throw new Error('Sign in again');
      await deletion.begin(value, confirmation, session.user.id);
    } catch { setMessage('Enter your current password and type DELETE MY ACCOUNT.'); }
  }
  const [username, setUsername] = useState(profile?.username ?? '');
  const [name, setName] = useState(profile?.display_name ?? '');
  const [timezone, setTimezone] = useState(profile?.timezone ?? '');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  async function save() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      const input = profileInput({ username, display_name: name, timezone });
      if (await store.update(input)) {
        const saved = store.snapshot().profile!;
        setUsername(saved.username); setName(saved.display_name); setTimezone(saved.timezone); setMessage('Profile saved.');
      }
    } catch (error) {
      setMessage(error instanceof ApiError ? error.code === 'username_taken' ? 'That username is already taken. Choose another.'
        : error.status === 422 ? 'Check the fields. That timezone may be unavailable on the server; use an IANA name such as Asia/Jerusalem or UTC.'
        : error.status === 401 ? 'Your session expired. Sign out and sign in again.'
        : 'Unable to confirm the save. Reload your profile from the server before retrying.'
        : error instanceof Error ? error.message : 'Unable to save. Please retry.');
    } finally { pending.current = false; setBusy(false); }
  }
  async function reload() {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      if (await store.refreshProfile()) {
        const saved = store.snapshot().profile!;
        setUsername(saved.username); setName(saved.display_name); setTimezone(saved.timezone); setMessage('Profile reloaded from the server.');
      }
    } catch { setMessage('Unable to reload. Check your connection, or sign out and sign in again if your session expired.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Form><Text style={styles.title}>Settings</Text><Text>Email (read-only): {session?.user.email}</Text>
    <Field label="Username" value={username} onChangeText={setUsername} editable={!busy} autoCapitalize="none" autoCorrect={false} />
    <Field label="Display name" value={name} onChangeText={setName} editable={!busy} />
    <Field label="IANA profile timezone" value={timezone} onChangeText={setTimezone} editable={!busy} autoCapitalize="none" autoCorrect={false} />
    <Text>Timezone changes affect future scheduling. Existing occurrence dates and deadlines remain fixed under the backend policy. Changing your device timezone does not change this account setting.</Text>
    <Message text={message} /><Button title={busy ? 'Saving…' : 'Save settings'} disabled={busy} onPress={save} />
    <Button title="Reload saved profile" disabled={busy} onPress={reload} />
    <NotificationControls />
    <Text style={styles.title}>Delete account permanently</Text>
    <Text>This permanently deletes your account, habits, excuses, friendships and registrations. Final decisions you made for friends remain anonymously as “Deleted friend”. This cannot be undone.</Text>
    {!deleting ? <Button title="Delete my account…" color="#b00020" disabled={busy} onPress={() => setDeleting(true)} /> : <>
      <Field label="Current password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} />
      <Field label="Type DELETE MY ACCOUNT to confirm" value={confirmation} onChangeText={setConfirmation} autoCapitalize="none" autoCorrect={false} />
      <Button title="Permanently delete my account" color="#b00020" disabled={busy || !password || confirmation !== 'DELETE MY ACCOUNT'} onPress={deleteAccount} />
      <Button title="Cancel deletion" onPress={() => { setPassword(''); setConfirmation(''); setDeleting(false); }} />
    </>}
    <Link href="/home" style={styles.message}>Back to home</Link><Button title="Sign out" onPress={store.signOut} />
  </Form>;
}
