const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
function compile(file, modules) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../${file}`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, process: { env: {} }, require: name => {
    assert.ok(name in modules, name); return modules[name];
  } });
  return exports;
}
const modules = {
  'react/jsx-runtime': { jsx, jsxs: jsx },
  'react-native': { Pressable: 'Pressable', Text: 'Text', StyleSheet: { create: value => value } },
  'expo-router': { Link: 'RouterLink' },
};
test('shared native buttons expose disabled state and retain a scalable, high-contrast 48dp touch target', () => {
  const { Button } = compile('components/ui.tsx', modules);
  const node = Button({ title: 'A long translated action', disabled: true, testID: 'action' });
  assert.equal(node.props.accessibilityRole, 'button');
  assert.equal(node.props.accessibilityLabel, 'A long translated action');
  assert.equal(node.props.accessibilityState.disabled, true);
  assert.equal(node.props.disabled, true);
  assert.equal(node.props.style({ pressed: false })[0].minHeight, 48);
  assert.equal(node.props.children.props.style.color, '#fff');
  assert.equal(node.props.children.props.numberOfLines, undefined);
  assert.equal(node.props.children.props.allowFontScaling, undefined);
});
test('navigation links keep the href and descriptive accessibility label on a full-size native target', () => {
  const { Link } = compile('components/ui.tsx', modules);
  const node = Link({ href: '/habit-history', accessibilityLabel: 'View history for walking', children: 'History' });
  assert.equal(node.props.href, '/habit-history');
  assert.equal(node.props.asChild, true);
  assert.equal(node.props.children.props.accessibilityLabel, 'View history for walking');
  assert.equal(node.props.children.props.style({ pressed: false })[0].minHeight, 48);
});
