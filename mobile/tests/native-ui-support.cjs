// Host adapters for shared native controls. Behavioral assertions in the existing
// screen suites remain unchanged; release-ui.test.cjs exercises the real wrappers.
module.exports = {
  'react-native': { Text: 'Text' },
  '../components/form': { Form: 'Form', styles: {} },
  'react-native-safe-area-context': { SafeAreaProvider: 'SafeAreaProvider', SafeAreaView: 'SafeAreaView' },
  './ui': { Button: 'Button', Link: 'Link' },
  '../components/ui': { Button: 'Button', Link: 'Link' },
};
