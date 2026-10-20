import { Button, Text } from 'react-native';
import { Form, Loading, Message, styles } from '../components/form';
import { useAuthLink } from '../lib/auth-link-context';
export default function AuthCallback() {
  const { phase, email, error, store } = useAuthLink();
  return <Form><Text style={styles.title}>Email link</Text>
    {phase === 'loading' ? <Loading /> : phase === 'decision' ? <>
      <Text>This link belongs to a different account ({email}). Continue with this email link? Your signed-in account will remain signed in. Recovery will change only the linked account’s password.</Text>
      <Button title="Continue with linked account" onPress={store.continue} />
    </> : phase === 'confirmed' ? <Text>Email confirmed for {email}. Return to sign in with that account. Your existing session has not been replaced.</Text>
      : phase === 'updated' ? <Text>Password updated. Use your new password next time you sign in. Your existing app session has not been replaced.</Text>
      : <Message text={error ?? 'No usable authentication link. Request a new email and open its link.'} />}
    <Button title={phase === 'decision' ? 'Cancel and keep current account' : 'Back to app'} onPress={store.cancel} />
  </Form>;
}
