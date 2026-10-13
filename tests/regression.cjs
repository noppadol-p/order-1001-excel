'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const HTML_PATH = process.env.INDEX_HTML || path.join(__dirname, '../index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

const qtyTextMatch = html.match(/function qtyText\(list\) \{[\s\S]*?\n  \}/);
assert.ok(qtyTextMatch, 'qtyText function not found in source');
const qtyTextSrc = qtyTextMatch[0];

function loadQtyText() {
  return vm.runInNewContext(qtyTextSrc + '\nqtyText;', { num: String });
}

test('qtyText groups mixed units separately', () => {
  const qtyText = loadQtyText();
  const result = qtyText([
    { qty: 2, uom: 'ชิ้น' },
    { qty: 5, uom: 'ชิ้น' },
    { qty: 3, uom: 'ผืน' },
  ]);
  assert.strictEqual(result, '7 ชิ้น · 3 ผืน');
});

test('qtyText falls back to ผืน when uom is missing', () => {
  const qtyText = loadQtyText();
  const result = qtyText([{ qty: 4 }]);
  assert.strictEqual(result, '4 ผืน');
});

test('qtyText returns 0 for an empty list', () => {
  const qtyText = loadQtyText();
  assert.strictEqual(qtyText([]), '0');
});

test('qtyText sums prototype-colliding uom keys correctly', () => {
  const qtyText = loadQtyText();
  let result;
  assert.doesNotThrow(() => {
    result = qtyText([
      { qty: 1, uom: '__proto__' },
      { qty: 2, uom: '__proto__' },
      { qty: 3, uom: 'constructor' },
      { qty: 4, uom: 'toString' },
    ]);
  });
  assert.strictEqual(result, '3 __proto__ · 3 constructor · 4 toString');
  assert.strictEqual(typeof ({}).constructor, 'function');
  assert.strictEqual(typeof Object.prototype.toString, 'function');
});

test('profilePushing guards re-entrant pushes before its processing loop', () => {
  assert.ok(/profilePushing/.test(html), 'profilePushing flag not found');
  const guardMatch = html.match(/if\s*\(\s*profilePushing\s*\|\|\s*offline\s*\|\|\s*!profileOk\(\)\s*\|\|\s*!\(API_URL\s*\|\|\s*onAppsScript\)\s*\)\s*return;?/);
  assert.ok(guardMatch, 'profilePushing re-entrancy guard not found');
  const after = html.slice(guardMatch.index, guardMatch.index + 2000);
  assert.ok(/while\s*\(\s*store\.get/.test(after), 'no while(store.get...) loop found following profilePushing guard');
});

test('productsLoading uses a single-flight guard without a stray netErr reset on success', () => {
  assert.ok(/productsLoading/.test(html), 'productsLoading flag not found');
  const guardMatch = html.match(/if\s*\(\s*productsLoading\s*\)\s*return\s+productsLoading;?/);
  assert.ok(guardMatch, 'productsLoading single-flight guard not found');
  const assignMatch = html.match(/productsLoading\s*=\s*loadProductsOnce\([^)]*\)\.finally\(\s*\(\)\s*=>\s*\{\s*productsLoading\s*=\s*null;?\s*\}\s*\);?/);
  assert.ok(assignMatch, 'productsLoading single-flight assignment with finally reset not found');
  const wrapper = html.slice(guardMatch.index, assignMatch.index + assignMatch[0].length);
  assert.ok(!/netErr\s*=\s*false/.test(wrapper), 'unexpected netErr = false assignment found inside productsLoading wrapper');
});

test('composition events guard IME input handling', () => {
  assert.ok(/compositionstart/.test(html), 'compositionstart handler not found');
  assert.ok(/compositionend/.test(html), 'compositionend handler not found');
  const compositionStartIdx = html.indexOf('compositionstart');
  const around = html.slice(Math.max(0, compositionStartIdx - 500), compositionStartIdx + 1500);
  assert.ok(/composing/i.test(around), 'no composing flag found near IME handlers');
  assert.ok(
    /addEventListener\(\s*['"]input['"]\s*,\s*e\s*=>\s*\{\s*if\s*\(\s*!composing\s*&&\s*!e\.isComposing\s*\)\s*normalize\(\);?\s*\}\s*\);?/.test(html),
    'input handler is not guarded by composing/e.isComposing checks'
  );
});

test('focus is applied semantically without decorative autofocus', () => {
  assert.ok(/el\.focus\(\s*\{\s*preventScroll:\s*true\s*\}\s*\)/.test(html), 'semantic el.focus({ preventScroll: true }) call not found');
  const icoMatch = html.match(/<div[^>]*class="[^"]*sw-cpn-ico[^"]*"[^>]*>/);
  assert.ok(icoMatch, 'sw-cpn-ico element not found');
  assert.ok(!/tabindex|autofocus/i.test(icoMatch[0]), 'sw-cpn-ico element should not have tabindex/autofocus');
});

test('uom is escaped when rendered in toast/validation messages', () => {
  const lines = html
    .split('\n')
    .filter(line => /toast\(|Swal\.showValidationMessage\(/.test(line) && /uomOf\(/.test(line));
  assert.ok(lines.length > 0, 'no toast/validation message lines with uomOf found');
  for (const line of lines) {
    const interpolations = [...line.matchAll(/\$\{[^}]*uomOf\([^}]*\}/g)];
    assert.ok(interpolations.length > 0, `no uomOf interpolation found in line: ${line}`);
    for (const match of interpolations) {
      assert.ok(/\besc\w*\(/i.test(match[0]), `uomOf interpolation not escaped: ${match[0]}`);
    }
  }
});
