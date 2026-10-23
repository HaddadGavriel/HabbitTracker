import type { ReactNode } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, type TextInputProps } from 'react-native';
export function Form({ children, standalone = false }: { children: ReactNode; standalone?: boolean }) {
  return <SafeAreaView edges={standalone ? ['top'] : []} style={{ flex: 1 }}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.form}>{children}</ScrollView></KeyboardAvoidingView></SafeAreaView>;
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return <><Text style={styles.label}>{label}</Text><TextInput {...props} testID={props.testID ?? `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')}`} accessibilityLabel={label} placeholderTextColor="#526174" style={[styles.input, props.multiline && { minHeight: 96, textAlignVertical: 'top' }, props.style]} /></>;
}
export function Message({ text }: { text: string | null }) { return text ? <Text accessibilityLiveRegion="polite" style={styles.message}>{text}</Text> : null; }
export function Loading() { return <ActivityIndicator accessibilityLabel="Loading" size="large" />; }
export const styles = StyleSheet.create({ form: { padding: 20, gap: 16, flexGrow: 1, backgroundColor: '#f7f9fc' }, title: { fontSize: 28, fontWeight: '700', color: '#172b4d' }, label: { fontSize: 16, fontWeight: '600', color: '#172b4d' }, input: { minHeight: 48, color: '#172b4d', padding: 14, backgroundColor: 'white', borderColor: '#68778d', borderWidth: 1, borderRadius: 8, fontSize: 16 }, message: { fontSize: 16, color: '#263b59' } });
