import { useRef, useState } from 'react';
import { Button, Text } from 'react-native';
import { Link } from 'expo-router';
import { supabase } from '../lib/supabase';
import { Field, Form, Loading, Message, styles } from './form';
export function AuthForm({ signup = false }: { signup?: boolean }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null);
  const submitting = useRef(false);
  async function submit() {
    if (submitting.current) return;
    if (!email.trim() || !password) { setMessage('Enter your email and password.'); return; }
    submitting.current = true; setBusy(true); setMessage(null);
    try {
      const credentials = { email: email.trim(), password };
      const response = signup ? await supabase.auth.signUp(credentials) : await supabase.auth.signInWithPassword(credentials);
      if (response.error) setMessage(response.error.message);
      else if (signup && !response.data.session) { setPassword(''); setMessage('Check your email for a confirmation link. Confirm your email, then return here to sign in.'); }
    } catch { setMessage('Unable to contact authentication. Check your connection and try again.'); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <Form><Text style={styles.title}>{signup ? 'Create an account' : 'Sign in'}</Text>
    <Field label="Email" value={email} onChangeText={setEmail} editable={!busy} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" />
    <Field label="Password" value={password} onChangeText={setPassword} editable={!busy} secureTextEntry autoCapitalize="none" autoComplete={signup ? 'new-password' : 'current-password'} onSubmitEditing={submit} returnKeyType="done" />
    {signup && <Text>Use at least 6 characters, or the longer minimum required by your account service.</Text>}
    <Message text={message} />{busy && <Loading />}<Button title={signup ? 'Sign up' : 'Sign in'} disabled={busy} onPress={submit} />
    {!busy && <Link href={signup ? '/sign-in' : '/sign-up'} style={styles.message}>{signup ? 'Already have an account? Sign in' : 'Create an account'}</Link>}
  </Form>;
}
