'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../src/gridflow.cjs');
const { boot } = require('../dom-harness.cjs');

function presetWithBusPatch(index, patch) {
  const net = G.getPreset('ieee3');
  Object.assign(net.buses[index], patch);
  return net;
}
function booted() {
  const h = boot(path.join(__dirname, '..'));
  assert.deepEqual(h.errors, [], 'startup console errors: ' + h.errors.join(' | '));
  return h;
}
function input(h, id, value) { h.get(id).value = value; h.event(h.get(id), 'input'); }

test('L515: bus and branch ids are required and unique', () => {
  const busDupe = G.getPreset('ieee3');
  busDupe.buses[2].id = busDupe.buses[0].id;
  assert.throws(() => G.normalizeNetwork(busDupe), /unique bus id|duplicate bus/i);
  const busBlank = G.getPreset('ieee3');
  busBlank.buses[1].id = '   ';
  assert.throws(() => G.normalizeNetwork(busBlank), /blank bus id|nonempty bus id/i);
  const branchDupe = G.getPreset('ieee3');
  branchDupe.branches[2].id = branchDupe.branches[0].id;
  assert.throws(() => G.normalizeNetwork(branchDupe), /unique branch id|duplicate branch/i);
  const branchBlank = G.getPreset('ieee3');
  branchBlank.branches[1].id = '';
  assert.throws(() => G.normalizeNetwork(branchBlank), /blank branch id|nonempty branch id/i);
});

test('L515: line resistance and voltage base stay physical', () => {
  const negativeR = G.getPreset('ieee3');
  negativeR.branches[0].r = -0.01;
  assert.throws(() => G.normalizeNetwork(negativeR), /resistance.*nonnegative|negative resistance/i);
  for (const badKv of [0, -230]) {
    const net = presetWithBusPatch(1, { baseKV: badKv });
    assert.throws(() => G.normalizeNetwork(net), /baseKV.*positive/i);
  }
});

test('L515: impossible infinite reactive limits fail closed', () => {
  for (const patch of [
    { qMin: Infinity, qMax: Infinity },
    { qMin: -Infinity, qMax: -Infinity },
    { qMin: Infinity, qMax: 0.5 },
    { qMin: -0.5, qMax: -Infinity }
  ]) {
    assert.throws(() => G.normalizeNetwork(presetWithBusPatch(2, patch)), /reactive limit|qMin|qMax/i);
  }
});

test('L515: scaleLoad rejects a nonfinite factor instead of poisoning loads', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'not-a-number']) {
    assert.throws(() => G.scaleLoad(G.getPreset('ieee3'), bad), /load factor|factor.*finite/i);
  }
});

test('L515: securityScan rejects nonfinite custom band edges', () => {
  for (const opts of [{ vLow: NaN }, { vHigh: Infinity }, { vLow: -Infinity }, { vHigh: 'bad' }]) {
    assert.throws(() => G.securityScan(G.getPreset('ieee3'), opts), /security band|vLow|vHigh/i);
  }
});

test('L515: audit export preserves the reactive-limit switch evidence', () => {
  const net = G.getPreset('ieee5');
  net.buses[3].qMin = -0.5;
  net.buses[3].qMax = -0.4;
  const sol = G.solveAC(net);
  assert.equal(sol.converged, true, sol.reason);
  assert.equal(sol.qLimited.length, 1);
  const audit = G.buildAudit({ solution: sol, preset: 'ieee5', loadFactor: 1 });
  assert.ok(Array.isArray(audit.operatingPoint.qLimited), 'audit must carry qLimited');
  assert.equal(audit.operatingPoint.qLimited.length, 1);
  assert.equal(audit.operatingPoint.qLimited[0].id, 'B4');
  assert.equal(audit.operatingPoint.qLimited[0].qSet, -0.4);
});

test('L515: aria-sort uses the WAI-ARIA ascending and descending tokens', () => {
  const h = booted();
  h.get('contBtn').click();
  const severity = h.get('contTable').querySelectorAll('thead .th-sort').find(b => b.getAttribute('data-key') === 'severity');
  severity.click();
  assert.equal(severity.parentNode.getAttribute('aria-sort'), 'descending');
  severity.click();
  assert.equal(severity.parentNode.getAttribute('aria-sort'), 'ascending');
  h.dispose();
});

test('L515: scan-only export buttons stay disabled until a scan exists', () => {
  const h = booted();
  assert.equal(h.get('contCsvBtn').disabled, true, 'N-1 CSV starts disabled');
  assert.equal(h.get('auditCsvBtn').disabled, true, 'audit CSV starts disabled');
  h.get('contCsvBtn').click();
  h.get('auditCsvBtn').click();
  assert.equal(h.document.downloads.length, 0);
  h.get('contBtn').click();
  assert.equal(h.get('contCsvBtn').disabled, false);
  assert.equal(h.get('auditCsvBtn').disabled, false);
  input(h, 'busLoadP', '1.2');
  assert.equal(h.get('contCsvBtn').disabled, true, 'editing the network invalidates scan exports');
  assert.equal(h.get('auditCsvBtn').disabled, true);
  h.dispose();
});

test('L515: outage preview is a native toggle button with pressed state', () => {
  const h = booted();
  h.get('contBtn').click();
  const row = h.get('contTable').querySelectorAll('tbody tr')[0];
  assert.equal(row.getAttribute('tabindex'), null, 'row itself must not be an unroled keyboard stop');
  let btn = row.querySelector('.cont-preview-btn');
  assert.ok(btn, 'outage cell carries a native preview button');
  assert.equal(btn.type, 'button');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  h.key(btn, 'Enter');
  btn = h.get('contTable').querySelectorAll('tbody tr')[0].querySelector('.cont-preview-btn');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.match(h.get('contPreview').textContent, /Preview: L\d+ out of service/);
  h.key(btn, ' ');
  btn = h.get('contTable').querySelectorAll('tbody tr')[0].querySelector('.cont-preview-btn');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.equal(h.get('contPreview').textContent, '');
  h.dispose();
});

test('L515: reduced motion and visible focus styles are real rules', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /var\(--focus\)/, 'focus ring must not reference an undefined token');
  assert.match(css, /\.th-sort:focus-visible/);
  assert.match(css, /\.cont-preview-btn:focus-visible/);
  assert.match(css, /\.th-sort\{[^}]*min-height:\s*24px|\.th-sort \{[^}]*min-height:\s*24px/);
});
