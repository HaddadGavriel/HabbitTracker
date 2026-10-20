// Compile-only Firebase placeholder. Never a credential or a delivery test.
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
writeFileSync(join(process.env.RUNNER_TEMP || process.cwd(), 'reminder-google-services.json'), JSON.stringify({
  project_info: { project_number: '1234567890', project_id: 'local-build-test' },
  client: [{ client_info: { mobilesdk_app_id: '1:1234567890:android:0123456789abcdef',
    android_client_info: { package_name: 'com.haddadgavriel.habittracker' } },
    api_key: [{ current_key: 'not-a-real-api-key' }] }], configuration_version: '1',
}));
