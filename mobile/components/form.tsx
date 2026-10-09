import type { ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, type TextInputProps } from 'react-native';
export function Form({ children }: { children: ReactNode }) {
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>{children}</ScrollView></KeyboardAvoidingView>;
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return <><Text style={styles.label}>{label}</Text><TextInput {...props} accessibilityLabel={label} style={styles.input} /></>;
}
export function Message({ text }: { text: string | null }) { return text ? <Text accessibilityLiveRegion="polite" style={styles.message}>{text}</Text> : null; }
export function Loading() { return <ActivityIndicator accessibilityLabel="Loading" size="large" />; }
export const styles = StyleSheet.create({ form: { padding: 24, gap: 16, flexGrow: 1, backgroundColor: '#f7f9fc' }, title: { fontSize: 28, fontWeight: '700', color: '#172b4d' }, label: { fontSize: 16, fontWeight: '600' }, input: { padding: 14, backgroundColor: 'white', borderColor: '#68778d', borderWidth: 1, borderRadius: 8, fontSize: 16 }, message: { fontSize: 16, color: '#263b59' } });
