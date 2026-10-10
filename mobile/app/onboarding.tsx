import { useRef, useState } from 'react';
import { Button, Text } from 'react-native';
import { ApiError } from '../lib/api';
import { profileInput } from '../lib/profile-input';
import { useSession } from '../lib/session';
import { Field, Form, Loading, Message, styles } from '../components/form';
function deviceTimezone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } }
export default function Onboarding() {
  const { store } = useSession();
  const [username, setUsername] = useState(''); const [displayName, setDisplayName] = useState(''); const [timezone, setTimezone] = useState(deviceTimezone);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null); const [uncertain, setUncertain] = useState(false);
  const submitting = useRef(false);
  async function submit() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setMessage(null);
    try { await store.create(profileInput({ username, display_name: displayName, timezone })); }
    catch (error) {
      const ambiguous = error instanceof ApiError && ['request_timeout', 'network_error', 'invalid_response'].includes(error.code);
      setUncertain(ambiguous);
      setMessage(ambiguous ? 'The server may have created your profile. Check for it before deciding to submit again.' : error instanceof ApiError && error.code === 'username_taken' ? 'That username is already taken. Choose another username.' : error instanceof Error ? error.message : 'Unable to create your profile.');
    } finally { submitting.current = false; setBusy(false); }
  }
  return <Form><Text style={styles.title}>Set up your profile</Text><Text>Your username is unique. You can correct the suggested device timezone.</Text>
    <Field label="Username" value={username} onChangeText={setUsername} editable={!busy} autoCapitalize="none" autoCorrect={false} />
    <Field label="Display name" value={displayName} onChangeText={setDisplayName} editable={!busy} />
    <Field label="IANA timezone" value={timezone} onChangeText={setTimezone} editable={!busy} autoCapitalize="none" autoCorrect={false} placeholder="Asia/Jerusalem" />
    <Text>Examples: Asia/Jerusalem, America/New_York, UTC. The server validates the timezone.</Text><Message text={message} />{busy && <Loading />}
    {uncertain ? <><Button title="Check whether my profile exists" disabled={busy} onPress={store.retry} /><Button title="Submit again" disabled={busy} onPress={submit} /></> : <Button title="Create profile" disabled={busy} onPress={submit} />}
    <Button title="Sign out" disabled={busy} onPress={store.signOut} />
  </Form>;
}
