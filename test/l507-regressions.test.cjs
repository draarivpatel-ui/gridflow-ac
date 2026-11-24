'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/gridflow.cjs');
const { boot } = require('../dom-harness.cjs');

function netWith(patch) {
  const n = G.getPreset('ieee3');
  return Object.assign(n, patch);
}

test('L507: invalid supplied baseMVA is rejected instead of silently replaced', () => {
  for (const bad of [0, -5, NaN, Infinity]) {
    assert.throws(() => G.normalizeNetwork(netWith({ baseMVA: bad })), /baseMVA/);
  }
});

test('L507: bus voltage limits must form a real band', () => {
  const n = G.getPreset('ieee3');
  n.buses[1].vMin = 1.1;
  n.buses[1].vMax = 0.9;
  assert.throws(() => G.normalizeNetwork(n), /vMin.*vMax|voltage band/);
});

test('L507: aria-sort is exposed on column headers, not buttons', () => {
  const h = boot(__dirname + '/..');
  h.get('contBtn').click();
  const btn = h.get('contTable').querySelectorAll('thead .th-sort').find(b => b.getAttribute('data-key') === 'severity');
  btn.click();
  const th = btn.parentNode;
  assert.equal(th.getAttribute('aria-sort'), 'descending');
  assert.equal(btn.getAttribute('aria-sort'), null);
  h.dispose();
});

test('L507: contingency rows preview from the keyboard', () => {
  const h = boot(__dirname + '/..');
  h.get('contBtn').click();
  const btn = h.get('contTable').querySelectorAll('tbody tr')[0].querySelector('.cont-preview-btn');
  h.key(btn, 'Enter');
  assert.match(h.get('contPreview').textContent, /Preview: L\d+ out of service/);
  const btnAgain = h.get('contTable').querySelectorAll('tbody tr')[0].querySelector('.cont-preview-btn');
  h.key(btnAgain, ' ');
  assert.equal(h.get('contPreview').textContent, '');
  h.dispose();
});
