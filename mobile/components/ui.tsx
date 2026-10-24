import { Link as RouterLink, type LinkProps } from 'expo-router';
import { Pressable, StyleSheet, Text, type ButtonProps } from 'react-native';

/** Native controls with wrapping labels and a 48 dp minimum target at every font size. */
export function Button({ title, onPress, disabled, color = '#174a80', accessibilityLabel, testID }: ButtonProps) {
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title}
    accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [ui.button, { backgroundColor: disabled ? '#526174' : color }, pressed && ui.pressed]}>
    <Text style={ui.buttonText}>{title}</Text>
  </Pressable>;
}
export function Link({ children, style, asChild, ...props }: LinkProps) {
  if (asChild) return <RouterLink {...props} asChild>{children}</RouterLink>;
  return <RouterLink {...props} asChild><Pressable accessibilityRole="link" accessibilityLabel={props.accessibilityLabel}
    style={({ pressed }) => [ui.link, pressed && ui.pressed]}>
    <Text style={[ui.linkText, style]}>{children}</Text>
  </Pressable></RouterLink>;
}
const ui = StyleSheet.create({
  button: { minHeight: 48, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  link: { minHeight: 48, paddingVertical: 12, justifyContent: 'center' },
  linkText: { color: '#174a80', fontSize: 16, textDecorationLine: 'underline', flexShrink: 1 },
  pressed: { opacity: 0.75 },
});
