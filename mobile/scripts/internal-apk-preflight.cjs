// Configuration checks for the separately authorized internal build only.
const { readFileSync } = require('node:fs');
const EAS_PROJECT = '4f31560d-6323-41f7-ae0a-f792a4814c98';
const ANDROID_PACKAGE = 'com.haddadgavriel.habittracker';
const PRODUCTION_SUPABASE = 'zsqzenswefkjaundwyct';

function validate(env, { firebase, configurationOnly = false } = {}) {
  const need = key => {
    const value = env[key];
    if (!value || /REPLACE|YOUR_|CONFIGURE/i.test(value)) throw Error(`Configure ${key} for isolated testing.`);
    return value;
  };
  const origin = key => {
    const value = need(key);
    let url;
    try { url = new URL(value); } catch { throw Error(`${key} must be an HTTPS origin.`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || url.pathname !== '/') {
      throw Error(`${key} must be an HTTPS origin without credentials, path or port.`);
    }
    return url.origin;
  };
  if (need('EXPO_PUBLIC_EAS_PROJECT_ID') !== EAS_PROJECT) throw Error('Existing EAS project identity must be preserved.');
  const ref = need('INTERNAL_TESTING_SUPABASE_REF');
  if (!/^[a-z]{20}$/.test(ref) || ref === PRODUCTION_SUPABASE) throw Error('Use an isolated Supabase branch, never production.');
  if (origin('EXPO_PUBLIC_SUPABASE_URL') !== `https://${ref}.supabase.co`) throw Error('Mobile and isolated Supabase project must match.');
  if (!need('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY').startsWith('sb_publishable_')) throw Error('Use the isolated project publishable key; never a secret/service key.');
  const api = origin('EXPO_PUBLIC_API_URL');
  if (api !== origin('INTERNAL_TESTING_API_ORIGIN') || !/^https:\/\/habit-tracker-pr33-internal(?:-[a-z0-9]+)?\.onrender\.com$/.test(api)) {
    throw Error('Use the separately created habit-tracker-pr33-internal Render service.');
  }
  const firebaseProject = need('INTERNAL_TESTING_FIREBASE_PROJECT_ID');
  if (!configurationOnly) {
    if (!firebase || firebase.type === 'service_account' || firebase.private_key) throw Error('Supply the existing Firebase Android client file, not a service account.');
    if (firebase.project_info?.project_id !== firebaseProject || firebaseProject === 'local-build-test') throw Error('Firebase project identity does not match the existing app.');
    if (!firebase.client?.some(client => client.client_info?.android_client_info?.package_name === ANDROID_PACKAGE)) throw Error('Firebase client must match the existing Android package.');
  }
  return { easProjectId: EAS_PROJECT, androidPackage: ANDROID_PACKAGE, supabaseProjectRef: ref, apiOrigin: api, firebaseProjectId: firebaseProject };
}

module.exports = { validate };
if (require.main === module) {
  const hook = process.argv.includes('--build-hook');
  if (!hook || process.env.HABITTRACKER_INTERNAL_BUILD === '1' || process.env.EAS_BUILD_PROFILE === 'internal-testing') {
    try {
      const configurationOnly = process.argv.includes('--configuration-only');
      let firebase;
      if (!configurationOnly) {
        if (!process.env.GOOGLE_SERVICES_JSON) throw Error('Configure the existing GOOGLE_SERVICES_JSON EAS file variable.');
        try { firebase = JSON.parse(readFileSync(process.env.GOOGLE_SERVICES_JSON, 'utf8')); }
        catch { throw Error('Existing Firebase Android client file is missing or invalid JSON.'); }
      }
      validate(process.env, { firebase, configurationOnly });
      if (!configurationOnly) {
        const { exp } = require('expo/config').getConfig(process.cwd());
        if (exp.android?.package !== ANDROID_PACKAGE || exp.extra?.eas?.projectId !== EAS_PROJECT) throw Error('Resolved Expo signing/project identity changed.');
      }
      console.log('Internal APK configuration verified; existing project/package identities preserved.');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
