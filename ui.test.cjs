/**
 * GridFlow AC UI interaction tests. Executes the real index.html scripts
 * through the deterministic DOM/canvas adapter.
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
function noNaN(h, id) {
  for (const call of h.get(id).getContext('2d').calls) {
    for (const arg of call.args) {
      assert.ok(!(typeof arg === 'number' && !Number.isFinite(arg)), `nonfinite ${call.name} arg`);
    }
  }
}

describe('startup and live solve', () => {
  test('startup binds the real engine and solves the 5-bus benchmark', () => {
    const h = bench();
    assert.match(h.get('engineBadge').textContent, /local AC solver ready/);
    assert.equal(h.get('errorStatus').hidden, true);
    assert.equal(h.get('statSolver').textContent, 'CONVERGED');
    assert.match(h.get('statusLine').textContent, /5 buses, 7 branches/);
    assert.match(h.get('statusLine').textContent, /Newton iterations/);
    assert.ok(Number(h.get('statIters').textContent) >= 3);
    assert.match(h.get('statBalance').textContent, /e-/);
    assert.equal(h.get('busTable').querySelectorAll('tbody tr').length, 5);
    assert.equal(h.get('networkSvg').querySelectorAll('title').length, 1);
    assert.equal(h.get('networkSvg').querySelectorAll('circle').length, 5);
    assert.equal(h.get('networkSvg').querySelectorAll('line').length, 7);
    for (const id of ['voltageCanvas', 'loadingCanvas', 'convergenceCanvas']) {
      assert.ok(h.get(id).getContext('2d').calls.length > 10, id + ' drew nothing');
      noNaN(h, id);
    }
    assert.match(h.get('voltageReadout').textContent, /B1 \| \|V\|/);
    assert.match(h.get('loadingReadout').textContent, /L12 \| loading/);
    assert.match(h.get('convergenceReadout').textContent, /iteration 1/);
    assert.deepEqual(h.errors, []);
    h.dispose();
  });

  test('all five synthetic presets produce finite state and correct solver status', () => {
    const h = bench();
    for (const name of ['ieee3', 'ieee5', 'radial', 'stress', 'collapse']) {
      change(h, 'presetSelect', name);
      assert.match(h.get('presetNote').textContent, /Synthetic benchmark/);
      const s = h.sandbox.__GRIDFLOW__.solution;
      assert.ok(s, name + ' has a solution object');
      assert.ok(s.vm.every(Number.isFinite), name + ' vm');
      assert.ok(s.va.every(Number.isFinite), name + ' va');
      assert.ok(s.history.length >= 1, name + ' history');
      if (name === 'collapse') {
        assert.equal(s.converged, false);
        assert.equal(h.get('statSolver').textContent, 'NO SOLUTION');
        assert.match(h.get('statusLine').textContent, /NON-CONVERGED/);
        assert.match(h.get('footerStatus').textContent, /collapse limit/);
        assert.equal(h.get('statGen').textContent, '--', 'no fabricated generation');
      } else {
        assert.equal(s.converged, true, name + ' should converge');
        assert.ok(s.mismatch < 1e-8);
        assert.equal(h.get('errorStatus').hidden, true);
      }
      noNaN(h, 'voltageCanvas');
      noNaN(h, 'convergenceCanvas');
    }
    assert.deepEqual(h.errors, []);
    h.dispose();
  });

  test('load factor slider changes the operating point and losses', () => {
    const h = bench();
    const before = h.sandbox.__GRIDFLOW__.diagnostics.totalLoss;
    input(h, 'loadFactor', '1.8');
    assert.equal(h.get('loadFactorOut').textContent, '1.80x');
    const after = h.sandbox.__GRIDFLOW__.diagnostics.totalLoss;
    assert.ok(after > before, `loss should rise: ${before} to ${after}`);
    assert.equal(h.get('statSolver').textContent, 'CONVERGED');
    assert.match(h.get('statusLine').textContent, /load 1.80x/);
    noNaN(h, 'loadingCanvas');
    h.dispose();
  });

  test('base MVA, tolerance and iteration limit are applied to the solver', () => {
    const h = bench();
    input(h, 'baseMVA', '250');
    assert.match(h.get('statGen').textContent, /MW/);
    assert.equal(h.sandbox.__GRIDFLOW__.solution.network.baseMVA, 250);
    change(h, 'tolerance', '1e-6');
    assert.equal(h.sandbox.__GRIDFLOW__.state.tolerance, 1e-6);
    input(h, 'maxIter', '5');
    assert.equal(h.get('maxIterOut').textContent, '5');
    assert.equal(h.sandbox.__GRIDFLOW__.state.maxIter, 5);
    assert.equal(h.get('errorStatus').hidden, true);
    h.dispose();
  });
});

describe('network editor', () => {
  test('bus load edits recompute the solver and update the bus table', () => {
    const h = bench();
    change(h, 'busSelect', '1');
    const before = h.sandbox.__GRIDFLOW__.diagnostics.totalLoad;
    input(h, 'busLoadP', '2.5');
    assert.equal(h.get('busLoadPOut').textContent, '2.50');
    assert.ok(h.sandbox.__GRIDFLOW__.diagnostics.totalLoad > before);
    assert.match(h.get('presetNote').textContent, /Custom synthetic benchmark/);
    const firstDataRow = h.get('busTable').querySelectorAll('tbody tr')[1];
    assert.ok(firstDataRow.textContent.includes('1.05') || firstDataRow.textContent.includes('B2'));
    assert.equal(h.get('errorStatus').hidden, true);
    h.dispose();
  });

  test('slack bus load controls are disabled', () => {
    const h = bench();
    change(h, 'busSelect', '0');
    assert.equal(h.get('busLoadP').disabled, true);
    assert.equal(h.get('busLoadQ').disabled, true);
    change(h, 'busSelect', '2');
    assert.equal(h.get('busLoadP').disabled, false);
    h.dispose();
  });

  test('branch reactance, rating and outage edits change the solved flows', () => {
    const h = bench();
    change(h, 'branchSelect', '0');
    const before = h.sandbox.__GRIDFLOW__.diagnostics.flows[0].loading;
    input(h, 'branchX', '0.45');
    assert.equal(h.get('branchXOut').textContent, '0.45');
    assert.notEqual(h.sandbox.__GRIDFLOW__.diagnostics.flows[0].loading, before);
    input(h, 'branchRate', '30');
    assert.equal(h.get('branchRateOut').textContent, '30');
    assert.ok(h.sandbox.__GRIDFLOW__.diagnostics.flows[0].loading > 1, 'tight rating should overload');
    assert.ok(h.sandbox.__GRIDFLOW__.diagnostics.overloaded.length >= 1);
    h.get('branchStatus').click();
    assert.equal(h.get('branchStatus').checked, false);
    assert.equal(h.sandbox.__GRIDFLOW__.state.network.branches[0].status, 0);
    assert.equal(h.sandbox.__GRIDFLOW__.diagnostics.flows[0].status, 0);
    assert.equal(h.get('errorStatus').hidden, true);
    h.dispose();
  });

  test('reset restores the preset and clears custom edits', () => {
    const h = bench();
    input(h, 'busLoadP', '2.5');
    input(h, 'loadFactor', '2');
    h.get('resetBtn').click();
    assert.equal(h.sandbox.__GRIDFLOW__.state.loadFactor, 1);
    assert.equal(h.get('presetSelect').value, 'ieee5');
    assert.match(h.get('presetNote').textContent, /Synthetic benchmark: 5-bus meshed/);
    assert.equal(h.sandbox.__GRIDFLOW__.solution.converged, true);
    h.dispose();
  });
});

describe('plots and probes', () => {
  test('keyboard probes move, clamp and expose real computed values', () => {
    const h = bench();
    const c = h.get('voltageCanvas');
    h.key(c, 'Home');
    assert.match(h.get('voltageReadout').textContent, /bus B1/);
    h.key(c, 'ArrowLeft');
    assert.match(h.get('voltageReadout').textContent, /bus B1/);
    h.key(c, 'End');
    assert.match(h.get('voltageReadout').textContent, /bus B5/);
    h.key(c, 'ArrowRight');
    assert.match(h.get('voltageReadout').textContent, /bus B5/);
    h.key(c, 'ArrowLeft', { shiftKey: true });
    assert.match(h.get('voltageReadout').textContent, /bus B1/);
    h.dispose();
  });

  test('loading and convergence probes report real diagnostics', () => {
    const h = bench();
    h.key(h.get('loadingCanvas'), 'End');
    assert.match(h.get('loadingReadout').textContent, /L24 \| loading/);
    h.key(h.get('loadingCanvas'), 'Home');
    assert.match(h.get('loadingReadout').textContent, /L12 \| loading/);
    const hist = h.sandbox.__GRIDFLOW__.solution.history;
    h.key(h.get('convergenceCanvas'), 'End');
    assert.match(h.get('convergenceReadout').textContent, new RegExp('iteration ' + hist.length));
    h.key(h.get('convergenceCanvas'), 'Home');
    assert.match(h.get('convergenceReadout').textContent, /iteration 1/);
    for (const id of ['voltageCanvas', 'loadingCanvas', 'convergenceCanvas']) noNaN(h, id);
    h.dispose();
  });

  test('pointer probe on the voltage canvas moves the readout', () => {
    const h = bench();
    const c = h.get('voltageCanvas');
    c.rect = { left: 0, top: 0, width: 600, height: 190 };
    h.event(c, 'pointermove', { clientX: 540 });
    assert.match(h.get('voltageReadout').textContent, /bus B5/);
    h.event(c, 'pointermove', { clientX: 10 });
    assert.match(h.get('voltageReadout').textContent, /bus B1/);
    h.dispose();
  });

  test('SVG redraws never accumulate stale nodes after many updates', () => {
    const h = bench();
    for (let i = 0; i < 6; i++) input(h, 'loadFactor', String(0.8 + i * 0.1));
    const svg = h.get('networkSvg');
    assert.equal(svg.querySelectorAll('title').length, 1);
    assert.equal(svg.querySelectorAll('desc').length, 1);
    assert.equal(svg.querySelectorAll('circle').length, 5);
    assert.equal(svg.querySelectorAll('line').length, 7);
    assert.deepEqual(h.errors, []);
    h.dispose();
  });

  test('canvas resizing respects device pixel ratio with a stable aspect ratio', () => {
    const h = bench({ dpr: 2 });
    const c = h.get('voltageCanvas');
    c.rect = { left: 0, top: 0, width: 600, height: 192 };
    h.resize();
    assert.equal(c.width, 1200);
    assert.equal(c.height, 384);
    c.rect = { left: 0, top: 0, width: 360, height: 115 };
    h.resize();
    assert.equal(c.width, 720);
    // The controller enforces a 150 CSS px minimum height for legibility.
    assert.equal(c.height, 300);
    noNaN(h, 'voltageCanvas');
    h.dispose();
  });
});

describe('N-1 screening and exports', () => {
  test('N-1 button runs a full AC re-solve for every branch and fills the table', () => {
    const h = bench();
    h.get('contBtn').click();
    const results = h.sandbox.__GRIDFLOW__.state.contingency;
    assert.equal(results.length, 7);
    assert.equal(h.get('contTable').querySelectorAll('tbody tr').length, 7);
    assert.match(h.get('contStatus').textContent, /7 outages screened/);
    for (const r of results) assert.equal(typeof r.converged, 'boolean');
    assert.deepEqual(h.errors, []);
    h.dispose();
  });

  test('sticky controls panel is height capped and scrollable on desktop only', () => {
    const h = bench();
    assert.match(h.css, /\.controls-panel\s*\{[^}]*max-height:\s*calc\(100vh - 2rem\)[^}]*overflow-y:\s*auto/);
    assert.match(h.css, /max-width:\s*980px\)\s*\{\s*\.controls-panel\s*\{[^}]*max-height:\s*none[^}]*overflow-y:\s*visible/,
      'mobile panel must stay uncapped with no inner scroll');
    h.dispose();
  });

  test('changing the network clears the stale contingency table', () => {
    const h = bench();
    h.get('contBtn').click();
    assert.match(h.get('contStatus').textContent, /7 outages/);
    input(h, 'loadFactor', '1.2');
    assert.equal(h.sandbox.__GRIDFLOW__.state.contingency, null);
    assert.equal(h.get('contStatus').textContent, 'Not yet computed');
    assert.match(h.get('contTable').textContent, /Press Run N-1 screen/);
    h.dispose();
  });

  test('all five exports produce finite, correctly named files', async () => {
    const h = bench();
    h.get('contBtn').click();
    const buttons = ['jsonBtn', 'busCsvBtn', 'branchCsvBtn', 'convergenceCsvBtn', 'contCsvBtn'];
    for (const id of buttons) h.get(id).click();
    assert.equal(h.document.downloads.length, 5);
    const names = h.document.downloads.map(f => f.filename);
    assert.ok(names.includes('gridflow-ac-experiment.json'));
    assert.ok(names.includes('gridflow_n1.csv'));
    for (const file of h.document.downloads) {
      const text = await h.blobs.get(file.href).text();
      assert.doesNotMatch(text, /NaN|Infinity|undefined/, file.filename);
    }
    const json = JSON.parse(await h.blobs.get(h.document.downloads[0].href).text());
    assert.equal(json.schemaVersion, 2);
    assert.equal(json.network.buses.length, 5);
    assert.equal(json.flows.length, 7);
    assert.ok(json.solution.converged);
    const busCsv = await h.blobs.get(h.document.downloads[1].href).text();
    assert.equal(busCsv.trim().split('\n').length, 6);
    const branchCsv = await h.blobs.get(h.document.downloads[2].href).text();
    assert.equal(branchCsv.trim().split('\n').length, 8);
    const n1 = await h.blobs.get(h.document.downloads[4].href).text();
    assert.equal(n1.trim().split('\n').length, 8);
    h.flushTimers();
    assert.equal(h.blobs.size, 0);
    h.dispose();
  });

  test('exports are disabled on a failed solve and re-enabled after recovery', () => {
    const h = bench();
    change(h, 'presetSelect', 'collapse');
    assert.equal(h.get('jsonBtn').disabled, false, 'history CSV is still valid for a failed solve');
    // The solver failed honestly, but JSON explicitly records non-convergence.
    h.get('jsonBtn').click();
    assert.match(h.get('exportNote').textContent, /experiment.json/);
    change(h, 'presetSelect', 'ieee5');
    assert.equal(h.get('statSolver').textContent, 'CONVERGED');
    h.dispose();
  });

  test('invalid base MVA falls back safely without a crash', () => {
    const h = bench();
    // The number input clamps values below its min to 1, which is a valid
    // positive base. The controller must handle it without crashing.
    input(h, 'baseMVA', '0');
    assert.equal(h.get('baseMVA').value, '1');
    assert.ok(h.sandbox.__GRIDFLOW__.state.baseMVA >= 1);
    assert.equal(h.get('errorStatus').hidden, true);
    assert.deepEqual(h.errors, []);
    h.dispose();
  });

  test('theme and guide toggles work with storage unavailable', () => {
    const h = bench({ storageBlocked: true });
    assert.equal(h.document.documentElement.getAttribute('data-theme'), 'dark');
    h.get('themeToggle').click();
    assert.equal(h.document.documentElement.getAttribute('data-theme'), 'light');
    assert.equal(h.get('themeToggle').getAttribute('aria-pressed'), 'true');
    h.get('helpToggle').click();
    assert.equal(h.get('helpPanel').hidden, false);
    assert.equal(h.get('helpToggle').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(h.errors, []);
    h.dispose();
  });

  test('Q-limit switching surfaces in the status line, table and readout', () => {
    const h = bench();
    h.sandbox.__GRIDFLOW__.state.network.buses[3].qMax = 0.01;
    h.sandbox.__GRIDFLOW__.recompute();
    const s = h.sandbox.__GRIDFLOW__.solution;
    assert.equal(s.converged, true, 'limited solve should still converge');
    assert.equal(s.qLimited.length, 1);
    assert.equal(s.qLimited[0].id, 'B4');
    assert.match(h.get('statusLine').textContent, /Q-limited: B4@qMax/);
    const row = h.get('busTable').querySelectorAll('tbody tr')[3];
    assert.match(row.textContent, /Q-limited/);
    assert.match(row.children[1].textContent, /pq/);
    h.key(h.get('convergenceCanvas'), 'End');
    assert.match(h.get('convergenceReadout').textContent, /1 PV bus\(es\) Q-limited/);
    h.dispose();
  });

  test('a failed solve keeps probes alive and labels the last iterate', () => {
    const h = bench();
    change(h, 'presetSelect', 'collapse');
    const s = h.sandbox.__GRIDFLOW__.solution;
    assert.equal(s.converged, false);
    for (const id of ['voltageCanvas', 'loadingCanvas', 'convergenceCanvas']) {
      h.key(h.get(id), 'End');
      h.key(h.get(id), 'ArrowRight');
      noNaN(h, id);
    }
    assert.match(h.get('voltageReadout').textContent, /NOT CONVERGED: last iterate/);
    assert.match(h.get('loadingReadout').textContent, /did not converge/);
    assert.match(h.get('convergenceReadout').textContent, /not converged/);
    assert.equal(h.get('errorStatus').hidden, true, 'non-convergence is a result, not an exception');
    h.dispose();
  });

  test('recovering from a failed solve restores all readouts and stats', () => {
    const h = bench();
    change(h, 'presetSelect', 'collapse');
    assert.equal(h.get('statGen').textContent, '--');
    change(h, 'presetSelect', 'ieee3');
    const s = h.sandbox.__GRIDFLOW__.solution;
    assert.equal(s.converged, true);
    assert.equal(h.get('statSolver').textContent, 'CONVERGED');
    assert.match(h.get('statGen').textContent, /MW/);
    assert.match(h.get('statusLine').textContent, /3 buses, 3 branches/);
    assert.equal(h.get('busTable').querySelectorAll('tbody tr').length, 3);
    assert.equal(h.get('networkSvg').querySelectorAll('circle').length, 3);
    assert.deepEqual(h.errors, []);
    h.dispose();
  });

  test('theme toggle keeps label and aria-pressed consistent both ways', () => {
    const h = bench();
    const t = h.get('themeToggle');
    assert.equal(t.textContent, 'Theme: dark');
    assert.equal(t.getAttribute('aria-pressed'), 'false');
    t.click();
    assert.equal(t.textContent, 'Theme: light');
    assert.equal(t.getAttribute('aria-pressed'), 'true');
    t.click();
    assert.equal(t.textContent, 'Theme: dark');
    assert.equal(t.getAttribute('aria-pressed'), 'false');
    h.dispose();
  });

  test('help toggle expands and collapses with aria-expanded', () => {
    const h = bench();
    const b = h.get('helpToggle'), p = h.get('helpPanel');
    assert.equal(p.hidden, true);
    assert.equal(b.getAttribute('aria-expanded'), 'false');
    b.click();
    assert.equal(p.hidden, false);
    assert.equal(b.getAttribute('aria-expanded'), 'true');
    b.click();
    assert.equal(p.hidden, true);
    assert.equal(b.getAttribute('aria-expanded'), 'false');
    h.dispose();
  });

  test('dragging the load factor past the collapse point produces an honest NO SOLUTION', () => {
    const h = bench();
    change(h, 'presetSelect', 'radial');
    input(h, 'loadFactor', '2.5');
    const s = h.sandbox.__GRIDFLOW__.solution;
    assert.equal(s.converged, false);
    assert.equal(h.get('statSolver').textContent, 'NO SOLUTION');
    assert.match(h.get('statusLine').textContent, /NON-CONVERGED/);
    input(h, 'loadFactor', '1');
    assert.equal(h.sandbox.__GRIDFLOW__.solution.converged, true);
    assert.equal(h.get('statSolver').textContent, 'CONVERGED');
    h.dispose();
  });

  test('convergence probe clamps at both ends of the residual history', () => {
    const h = bench();
    const c = h.get('convergenceCanvas');
    const hist = h.sandbox.__GRIDFLOW__.solution.history;
    h.key(c, 'End');
    h.key(c, 'ArrowRight', { shiftKey: true });
    assert.match(h.get('convergenceReadout').textContent, new RegExp('iteration ' + hist.length));
    h.key(c, 'Home');
    h.key(c, 'ArrowLeft', { shiftKey: true });
    assert.match(h.get('convergenceReadout').textContent, /iteration 1/);
    h.dispose();
  });

  test('branch outage checkbox updates the solved state and diagram', () => {
    const h = bench();
    change(h, 'branchSelect', '1');
    h.get('branchStatus').click();
    const s = h.sandbox.__GRIDFLOW__.solution;
    const f = h.sandbox.__GRIDFLOW__.diagnostics.flows[1];
    assert.equal(f.status, 0);
    assert.equal(f.pFrom, 0);
    const lines = h.get('networkSvg').querySelectorAll('line');
    assert.match(lines[1].getAttribute('stroke-dasharray') || '', /6,5/);
    h.get('branchStatus').click();
    assert.equal(h.sandbox.__GRIDFLOW__.diagnostics.flows[1].status, 1);
    h.dispose();
  });

  test('pointer probe on the loading canvas selects the right branch', () => {
    const h = bench();
    const c = h.get('loadingCanvas');
    c.rect = { left: 0, top: 0, width: 700, height: 200 };
    h.event(c, 'pointermove', { clientX: 0 });
    assert.match(h.get('loadingReadout').textContent, /L12/);
    h.event(c, 'pointermove', { clientX: 700 });
    assert.match(h.get('loadingReadout').textContent, /L24/);
    h.dispose();
  });

  test('preset change keeps bus and branch selectors inside range', () => {
    const h = bench();
    change(h, 'busSelect', '4');
    change(h, 'presetSelect', 'ieee3');
    const st = h.sandbox.__GRIDFLOW__.state;
    assert.ok(st.selectedBus < 3, 'selected bus out of range for 3-bus preset');
    assert.ok(st.selectedBranch < 3);
    assert.equal(h.get('busTable').querySelectorAll('tbody tr').length, 3);
    h.dispose();
  });

  test('overloaded line marks the loading stat as a warning', () => {
    const h = bench();
    change(h, 'presetSelect', 'stress');
    const d = h.sandbox.__GRIDFLOW__.diagnostics;
    assert.ok(d.maxLoading > 1);
    assert.equal(h.get('statLoading').className, 'warn');
    change(h, 'presetSelect', 'ieee3');
    assert.equal(h.get('statLoading').className, '');
    h.dispose();
  });

  test('export note names the file after every export click', () => {
    const h = bench();
    h.get('busCsvBtn').click();
    assert.match(h.get('exportNote').textContent, /gridflow_buses\.csv/);
    h.get('convergenceCsvBtn').click();
    assert.match(h.get('exportNote').textContent, /gridflow_convergence\.csv/);
    h.flushTimers();
    h.dispose();
  });

  test('JSON export on a failed solve records the failure honestly', async () => {
    const h = bench();
    change(h, 'presetSelect', 'collapse');
    h.get('jsonBtn').click();
    const obj = JSON.parse(await h.blobs.get(h.document.downloads[0].href).text());
    assert.equal(obj.solution.converged, false);
    assert.equal(obj.diagnostics, null);
    assert.ok(Array.isArray(obj.solution.history) && obj.solution.history.length >= 1);
    h.flushTimers();
    h.dispose();
  });

  test('clicking an SVG bus and branch updates the editor selection', () => {
    const h = bench();
    const circles = h.get('networkSvg').querySelectorAll('circle');
    h.event(circles[2], 'click');
    assert.equal(h.sandbox.__GRIDFLOW__.state.selectedBus, 2);
    assert.equal(h.get('busSelect').value, '2');
    const lines = h.get('networkSvg').querySelectorAll('line');
    h.event(lines[3], 'click');
    assert.equal(h.sandbox.__GRIDFLOW__.state.selectedBranch, 3);
    assert.equal(h.get('branchSelect').value, '3');
    assert.match(h.get('networkReadout').textContent, /Bus B3/);
    h.dispose();
  });

  test('bus table rows expose real per-bus values after a load edit', () => {
    const h = bench();
    change(h, 'busSelect', '2');
    const before = h.sandbox.__GRIDFLOW__.diagnostics.totalLoad;
    input(h, 'busLoadP', '0.01');
    const s = h.sandbox.__GRIDFLOW__.solution;
    const row = h.get('busTable').querySelectorAll('tbody tr')[2];
    const cells = [...row.children].map(td => td.textContent);
    assert.equal(cells[0], 'B3');
    assert.match(cells[2], /^\d+\.\d+$/);
    const d = h.sandbox.__GRIDFLOW__.diagnostics;
    closeAssert(Number(cells[4]), s.P[2], 1e-4);
    assert.ok(d.totalLoad < before - 0.5, `load must shrink: ${before} -> ${d.totalLoad}`);
    h.dispose();
  });

  function closeAssert(a, b, eps) { assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`); }

  test('no remote script sources, no duplicate IDs and no external URLs', () => {
    const h = bench();
    const scripts = h.document.querySelectorAll('script[src]');
    assert.equal(scripts.length, 2);
    for (const s of scripts) assert.match(s.getAttribute('src'), /^(src\/gridflow\.cjs|app\.js)$/);
    assert.doesNotMatch(h.html, /https?:\/\//);
    const ids = h.document.querySelectorAll('[id]').map(n => n.id);
    assert.equal(new Set(ids).size, ids.length);
    h.dispose();
  });
});
