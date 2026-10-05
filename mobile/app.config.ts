import type { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Infrastructure Test',
  slug: 'habit-tracker-infrastructure-proof',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'habittrackerinfra',
  plugins: ['expo-router', 'expo-notifications'],
  android: {
    package: 'com.haddadgavriel.habittracker',
    // EAS file variables resolve to a temporary path on the remote builder.
    // The fallback supports a gitignored file during local native builds.
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json',
    permissions: ['POST_NOTIFICATIONS'],
  },
  extra: {
    router: { origin: false },
    eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID },
  },
});
