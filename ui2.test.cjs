/**
 * GridFlow AC UI tests for the N-1 security scanner, the Solar PV + BESS
 * Volt-VAR panel, deterministic audit exports and the self-test battery.
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./dom-harness.cjs');
const G = require('./src/gridflow.cjs');

function bench(options) {
  const h = boot(__dirname, options);
  assert.deepEqual(h.errors, [], 'startup console errors: ' + h.errors.join(' | '));
  return h;
}
function input(h, id, value) { h.get(id).value = value; h.event(h.get(id), 'input'); }
function change(h, id, value) { h.get(id).value = value; h.event(h.get(id), 'change'); }
function rows(h) { return h.get('contTable').querySelectorAll('tbody tr'); }
function sortBtn(h, key) { return h.get('contTable').querySelectorAll('thead .th-sort').find(b => b.getAttribute('data-key') === key); }

describe('N-1 security scanner table', () => {
  test('the scan button fills a ranked row per in-service branch', () => {
    const h = bench();
    h.get('contBtn').click();
    assert.equal(rows(h).length, 7);
    assert.match(h.get('contStatus').textContent, /7 outages screened/);
    assert.match(h.get('contStatus').textContent, /grid is N-1 secure/);
    assert.equal(h.sandbox.__GRIDFLOW__.scan.results.length, 7);
    assert.deepEqual(h.errors, []);
    h.dispose();
  });

  test('rows show rank, outage id, solve status, loading, counts and severity', () => {
    const h = bench();
    h.get('contBtn').click();
    for (const tr of rows(h)) {
      const tds = tr.querySelectorAll('td');
      assert.equal(tds.length, 7);
      assert.match(tds[0].textContent, /^\d+$/);
      assert.match(tds[1].textContent, /^L\d+$/);
      assert.match(tds[2].textContent, /^(yes|NO)$/);
      assert.match(tds[6].textContent, /^\d+(\.\d)?$/);
    }
    h.dispose();
  });

  test('default order is rank ascending (severity first)', () => {
    const h = bench();
    change(h, 'presetSelect', 'stress');
    h.get('contBtn').click();
    const ranks = rows(h).map(tr => Number(tr.querySelectorAll('td')[0].textContent));
    assert.deepEqual(ranks, ranks.slice().sort((a, b) => a - b));
    // Rank 1 leads the table.
    assert.equal(ranks[0], 1);
    h.dispose();
  });

  test('a sort header toggles order and reports aria-sort', () => {
    const h = bench();
    h.get('contBtn').click();
    const sev = sortBtn(h, 'severity');
    assert.equal(sev.getAttribute('aria-sort'), 'none');
    sev.click();
    assert.equal(sev.getAttribute('aria-sort'), 'desc');
    const sevs = rows(h).map(tr => Number(tr.querySelectorAll('td')[6].textContent));
    assert.deepEqual(sevs, sevs.slice().sort((a, b) => b - a));
    sev.click();
    assert.equal(sev.getAttribute('aria-sort'), 'asc');
    h.dispose();
  });

  test('sorting by outage id orders alphabetically', () => {
    const h = bench();
    h.get('contBtn').click();
    sortBtn(h, 'outage').click();
    const ids = rows(h).map(tr => tr.querySelectorAll('td')[1].textContent);
    assert.deepEqual(ids, ids.slice().sort());
    h.dispose();
  });

  test('non-convergent rows get the fail class and honest cells', () => {
    const h = bench();
    change(h, 'presetSelect', 'radial');
    h.get('contBtn').click();
    const list = rows(h);
    assert.ok(list.length === 5);
    let fails = 0;
    for (const tr of list) {
      if (tr.classList.contains('row-fail')) {
        fails++;
        const tds = tr.querySelectorAll('td');
        assert.equal(tds[2].textContent, 'NO');
        assert.equal(tds[3].textContent, '--', 'no fabricated loading');
        assert.equal(tds[6].textContent, '1000.0');
      }
    }
    assert.ok(fails >= 3, 'radial outages must honestly fail');
    h.dispose();
  });
});

describe('contingency click-preview', () => {
  test('clicking a row previews the outage and marks the row', () => {
    const h = bench();
    h.get('contBtn').click();
    rows(h)[0].click();
    // The table re-renders on click, so re-query: exactly one row highlighted.
    const marked = rows(h).filter(tr => tr.classList.contains('row-preview'));
    assert.equal(marked.length, 1, 'clicked row not highlighted');
    assert.match(h.get('contPreview').textContent, /Preview: L\d+ out of service/);
    assert.match(h.get('contPreview').textContent, /rank 1 of 7/);
    assert.equal(h.sandbox.__GRIDFLOW__.state.previewBranch, 0);
    h.dispose();
  });

  test('the preview draws the tripped branch dashed with an OUT tag', () => {
    const h = bench();
    h.get('contBtn').click();
    rows(h)[0].click();
    const texts = h.get('networkSvg').querySelectorAll('text').map(t => t.textContent);
    assert.ok(texts.some(t => /L12 OUT/.test(t)), 'no OUT label: ' + texts.join(' | '));
    const dashed = h.get('networkSvg').querySelectorAll('line').filter(l => l.getAttribute('stroke-dasharray') === '4,4');
    assert.equal(dashed.length, 1, 'exactly one previewed branch should be dashed');
    h.dispose();
  });

  test('violated buses are named in the preview readout', () => {
    const h = bench();
    change(h, 'presetSelect', 'stress');
    h.get('contBtn').click();
    // Find a converged row with violations and click it.
    const tr = rows(h).find(r => r.querySelectorAll('td')[5].textContent !== '0' && r.querySelectorAll('td')[2].textContent === 'yes');
    assert.ok(tr, 'need a converged violating row');
    tr.click();
    assert.match(h.get('contPreview').textContent, /violated: B\d+/);
    h.dispose();
  });

  test('clicking the same row again clears the preview', () => {
    const h = bench();
    h.get('contBtn').click();
    const tr = rows(h)[0];
    tr.click();
    assert.match(h.get('contPreview').textContent, /Preview:/);
    rows(h)[0].click();
    assert.equal(h.get('contPreview').textContent, '');
    assert.equal(h.sandbox.__GRIDFLOW__.state.previewBranch, null);
    h.dispose();
  });

  test('editing the network clears stale scan rows and the preview', () => {
    const h = bench();
    h.get('contBtn').click();
    rows(h)[0].click();
    input(h, 'loadFactor', '1.2');
    assert.equal(h.sandbox.__GRIDFLOW__.scan, null);
    assert.match(h.get('contStatus').textContent, /Not yet computed/);
    assert.equal(h.get('contPreview').textContent, '');
    assert.equal(rows(h).length, 1);
    assert.match(rows(h)[0].textContent, /Press Run N-1 screen to compute/);
    h.dispose();
  });
});

describe('Solar PV + BESS Volt-VAR panel', () => {
  test('the host selector lists only PQ load buses', () => {
    const h = bench();
    const opts = h.get('derBus').querySelectorAll('option').map(o => o.value);
    assert.deepEqual(opts, ['1', '2', '4'], 'ieee5 PQ buses are B2, B3, B5');
    h.dispose();
  });

  test('enabling DER runs the assisted solve and fills the impact panel', () => {
    const h = bench();
    h.get('derEnable').click();
    assert.equal(h.get('derEnable').checked, true);
    const r = h.sandbox.__GRIDFLOW__.derResult;
    assert.ok(r && r.solution.converged, 'DER solve should converge on ieee5');
    assert.match(h.get('derVBefore').textContent, /\d+\.\d+ pu/);
    assert.match(h.get('derVAfter').textContent, /\d+\.\d+ pu/);
    assert.match(h.get('derMWh').textContent, /MWh/);
    assert.match(h.get('derCO2').textContent, / t$/);
    assert.match(h.get('derReadout').textContent, /DER @B\d/);
    assert.match(h.get('statusLine').textContent, /DER @B\d/);
    h.dispose();
  });

  test('slider edits update state live and the readout follows', () => {
    const h = bench();
    input(h, 'derSolar', '0.30');
    assert.equal(h.sandbox.__GRIDFLOW__.state.der.pSolar, 0.3);
    assert.equal(h.get('derSolarOut').textContent, '0.30');
    input(h, 'derBess', '0.25');
    input(h, 'derQCap', '0.80');
    input(h, 'derGain', '10');
    h.get('derEnable').click();
    const r = h.sandbox.__GRIDFLOW__.derResult;
    assert.equal(r.der.pSolar, 0.3);
    assert.equal(r.der.pBess, 0.25);
    assert.equal(r.der.qCap, 0.8);
    assert.match(h.get('derReadout').textContent, /cap 0.80 pu/);
    h.dispose();
  });

  test('DER recovers the sagging radial feeder voltage floor', () => {
    const h = bench();
    change(h, 'presetSelect', 'radial');
    input(h, 'loadFactor', '1.3');
    change(h, 'derBus', '5');
    h.get('derEnable').click();
    const before = Number(h.get('derVBefore').textContent.replace(' pu', ''));
    const after = Number(h.get('derVAfter').textContent.replace(' pu', ''));
    assert.ok(before < 0.8, 'fixture: radial 1.3x must sag, got ' + before);
    assert.ok(after > before + 0.05, `no recovery: ${before} -> ${after}`);
    const cleared = h.get('derVCleared').textContent;
    assert.ok(Number(cleared) >= 1, 'expected violations cleared, got ' + cleared);
    h.dispose();
  });

  test('DER inside the N-1 scan tags the status line', () => {
    const h = bench();
    h.get('derEnable').click();
    h.get('contBtn').click();
    assert.match(h.get('contStatus').textContent, /DER active/);
    assert.equal(rows(h).length, 7);
    h.dispose();
  });

  test('disabling DER returns the panel to the honest empty state', () => {
    const h = bench();
    h.get('derEnable').click();
    assert.match(h.get('derVBefore').textContent, /pu/);
    h.get('derEnable').click();
    assert.equal(h.get('derVBefore').textContent, '--');
    assert.match(h.get('derReadout').textContent, /Enable DER/);
    assert.equal(h.sandbox.__GRIDFLOW__.derResult, null);
    h.dispose();
  });

  test('a PV bus host is rejected by the selector contents', () => {
    const h = bench();
    change(h, 'presetSelect', 'ieee3');
    const opts = h.get('derBus').querySelectorAll('option').map(o => o.value);
    // ieee3: bus 0 slack, bus 1 pq, bus 2 pv - only index 1 may host.
    assert.deepEqual(opts, ['1']);
    h.dispose();
  });
});

describe('audit exports', () => {
  test('the audit JSON downloads with verifiable checksums', async () => {
    const h = bench();
    h.get('auditJsonBtn').click();
    assert.equal(h.document.downloads.length, 1);
    assert.equal(h.document.downloads[0].filename, 'gridflow-ac-audit.json');
    const obj = JSON.parse(await h.blobs.get(h.document.downloads[0].href).text());
    assert.equal(obj.kind, 'n1-security-audit');
    assert.match(obj.checksums.sha256, /^[0-9a-f]{64}$/);
    assert.match(obj.checksums.fnv1a64, /^[0-9a-f]{16}$/);
    assert.equal(obj.operatingPoint.converged, true);
    assert.match(h.get('auditNote').textContent, /fnv1a64 [0-9a-f]{16}/);
    assert.match(h.get('exportNote').textContent, /gridflow-ac-audit.json/);
    h.dispose();
  });

  test('the audit embeds the last N-1 scan when one exists', async () => {
    const h = bench();
    h.get('contBtn').click();
    h.get('auditJsonBtn').click();
    const obj = JSON.parse(await h.blobs.get(h.document.downloads[0].href).text());
    assert.equal(obj.security.results.length, 7);
    assert.equal(obj.security.screened, 7);
    assert.equal(obj.security.band.low, 0.95);
    h.dispose();
  });

  test('the N-1 audit CSV needs a scan first', async () => {
    const h = bench();
    h.get('auditCsvBtn').click();
    assert.equal(h.document.downloads.length, 0, 'no scan, no export');
    h.get('contBtn').click();
    h.get('auditCsvBtn').click();
    assert.equal(h.document.downloads.length, 1);
    assert.equal(h.document.downloads[0].filename, 'gridflow-ac-n1-audit.csv');
    const csv = await h.blobs.get(h.document.downloads[0].href).text();
    assert.equal(csv.trim().split('\n').length, 8);
    assert.match(h.get('auditNote').textContent, /N-1 audit CSV/);
    h.dispose();
  });

  test('a DER-assisted audit records the DER block', async () => {
    const h = bench();
    h.get('derEnable').click();
    h.get('auditJsonBtn').click();
    const obj = JSON.parse(await h.blobs.get(h.document.downloads[0].href).text());
    assert.ok(obj.der, 'audit must carry the DER block');
    assert.ok(obj.der.qEffective === true || obj.der.qEffective === false);
    h.dispose();
  });

  test('a failed solve audits honestly through the UI', async () => {
    const h = bench();
    change(h, 'presetSelect', 'collapse');
    h.get('auditJsonBtn').click();
    const obj = JSON.parse(await h.blobs.get(h.document.downloads[0].href).text());
    assert.equal(obj.operatingPoint.converged, false);
    assert.equal(obj.operatingPoint.totalGeneration, null);
    assert.equal(obj.buses.length, 0);
    h.dispose();
  });
});

describe('in-page self-test battery', () => {
  test('running self-tests fills the list with six PASS marks', () => {
    const h = bench();
    assert.equal(h.get('selfTestList').hidden, true);
    h.get('selfTestBtn').click();
    const list = h.get('selfTestList');
    assert.equal(list.hidden, false);
    const items = list.querySelectorAll('li');
    assert.equal(items.length, 6);
    for (const li of items) {
      const mark = li.querySelector('.selftest-mark');
      assert.equal(mark.textContent, 'PASS');
      assert.ok(mark.classList.contains('pass'));
      assert.match(li.textContent, /: /);
    }
    assert.match(h.get('auditNote').textContent, /6\/6 self-tests passed/);
    h.dispose();
  });

  test('the battery covers balance, determinism, droop and honesty', () => {
    const h = bench();
    h.get('selfTestBtn').click();
    const text = h.get('selfTestList').textContent;
    assert.match(text, /Kirchhoff|balance/i);
    assert.match(text, /determin/i);
    assert.match(text, /Volt-VAR|droop/i);
    h.dispose();
  });
});

describe('responsive and harness invariants on new UI', () => {
  test('the new panels keep zero console errors on mobile width', () => {
    const h = bench({ width: 390 });
    h.get('contBtn').click();
    rows(h)[0].click();
    h.get('derEnable').click();
    h.get('selfTestBtn').click();
    h.get('auditJsonBtn').click();
    assert.deepEqual(h.errors, []);
    h.dispose();
  });

  test('DER state survives a preset change without stale buses', () => {
    const h = bench();
    h.get('derEnable').click();
    change(h, 'presetSelect', 'radial');
    // radial PQ buses re-list; the selector must stay in range.
    const opts = h.get('derBus').querySelectorAll('option').map(o => Number(o.value));
    assert.ok(opts.length === 5, 'radial has five PQ buses');
    const sel = Number(h.get('derBus').value);
    assert.ok(opts.includes(sel), 'selection must remain a valid PQ index');
    assert.deepEqual(h.errors, []);
    h.dispose();
  });
});
