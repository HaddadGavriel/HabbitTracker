const { CodeGenerator, withAppBuildGradle } = require('expo/config-plugins');

// The local-reminders AAR requires its consuming app to enable desugaring too.
// Configure the generated app here so clean EAS prebuilds retain the setting.
module.exports = function withCoreLibraryDesugaring(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('Core library desugaring requires a Groovy app/build.gradle.');
    }

    config.modResults.contents = CodeGenerator.mergeContents({
      src: config.modResults.contents,
      newSrc: '    compileOptions { coreLibraryDesugaringEnabled true }',
      tag: 'habit-tracker-core-library-desugaring-options',
      anchor: /^android\s*\{/,
      offset: 1,
      comment: '//',
    }).contents;
    config.modResults.contents = CodeGenerator.mergeContents({
      src: config.modResults.contents,
      // Keep the runtime aligned with modules/local-reminders/android/build.gradle.
      newSrc: "    coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5'",
      tag: 'habit-tracker-core-library-desugaring-dependency',
      anchor: /^dependencies\s*\{/,
      offset: 1,
      comment: '//',
    }).contents;
    return config;
  });
};
