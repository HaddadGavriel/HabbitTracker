import { useState } from 'react';
import { Link } from 'expo-router';
import { Button, Text } from 'react-native';
import { Field, Form, Message, styles } from '../components/form';
import { EmailRequest } from '../lib/email-request';
import { supabase } from '../lib/supabase';
const requests = new EmailRequest(supabase.auth);
export default function ForgotPassword() {
  const [email, setEmail] = useState(''), [message, setMessage] = useState<string | null>(null), [busy, setBusy] = useState(false);
  async function send(confirmation = false) { if (busy) return; setBusy(true); try { setMessage(await requests.send(email, confirmation)); } finally { setBusy(false); } }
  return <Form><Text style={styles.title}>Email help</Text>
    <Field label="Email" value={email} onChangeText={setEmail} editable={!busy} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" />
    <Message text={message} /><Button title="Send recovery email" disabled={busy} onPress={() => send()} />
    <Button title="Resend signup confirmation" disabled={busy} onPress={() => send(true)} /><Text>Please wait at least 60 seconds between emails. Server limits may require longer.</Text>
    <Link href="/sign-in" style={styles.message}>Back to sign in</Link>
  </Form>;
}
