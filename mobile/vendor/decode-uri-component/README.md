# decode-uri-component CommonJS security backport

Source: upstream `decode-uri-component@0.5.1` from the npm registry, under the
included MIT license. Upstream `index.js` SHA-256:
`6a86ac891edf15c5efa0841ebb31935e3669d58b98318b57d7b08a4530317cb0`.

This carries upstream's linear-time decoder fixing GHSA-vcc3-ghjq-m6fr. Expo
Router 57 uses CommonJS `query-string@7`, which calls the decoder as a function;
overriding it directly with upstream's ESM-only 0.5.1 breaks that interface.

Changes from upstream: strict CommonJS export instead of `export default`, and
the 0.2.x `+` → space behavior before decoding. The decoding algorithm is unchanged.
The root npm override and lockfile install this package for query-string. Tests
exercise that actual dependency path, Unicode/query semantics, malformed input,
and a large malformed run in a subprocess with a deadline.

Remove this compatibility package when a supported Expo Router release upgrades
to a fixed decoder with a compatible module interface. Do not replace it with
the vulnerable 0.2.2 implementation merely to satisfy its old semver range.
