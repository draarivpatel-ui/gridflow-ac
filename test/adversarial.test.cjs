'use strict';
/* Regression tests for defects found by the adversarial review pass.
   Each test names the finding it covers. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../src/gridflow.cjs');

/* Finding 1: buildYbus and branchFlows treated an absent branch status as
   out-of-service, the opposite of normalizeNetwork's default. Direct API
   consumers got an all-zero Ybus and zero flows on preset networks. */
test('buildYbus treats an absent status field as in-service', () => {
  const raw = G.getPreset('ieee5');
  assert.ok(raw.branches.every(b => b.status === undefined), 'preset carries no status field');
  const y = G.buildYbus(raw);
  let gSum = 0;
  for (const row of y.G) for (const v of row) gSum += Math.abs(v);
  assert.ok(gSum > 1, `all-zero Ybus on an in-service network: ${gSum}`);
  const norm = G.normalizeNetwork(raw);
  const yn = G.buildYbus(norm);
  for (let i = 0; i < yn.G.length; i++) {
    for (let j = 0; j < yn.G.length; j++) {
      assert.equal(y.G[i][j], yn.G[i][j]);
      assert.equal(y.B[i][j], yn.B[i][j]);
    }
  }
});

test('branchFlows computes real flows when status is absent', () => {
  const raw = G.getPreset('ieee5');
  const net = G.normalizeNetwork(raw);
  const sol = G.solveAC(raw);
  assert.ok(sol.converged);
  const flows = G.branchFlows(raw, sol.vm, sol.va);
  const flowsN = G.branchFlows(net, sol.vm, sol.va);
  for (let i = 0; i < flows.length; i++) {
    assert.equal(flows[i].status, 1, `branch ${i} reported out of service`);
    assert.equal(flows[i].pFrom, flowsN[i].pFrom);
  }
});

test('explicit outage markers still take a branch out of service', () => {
  for (const marker of [0, false, '0']) {
    const raw = G.getPreset('ieee5');
    raw.branches[0].status = marker;
    const y = G.buildYbus(raw);
    assert.notEqual(y.G[0][0], 0, 'self admittance must remain from other branches');
    const yFull = G.buildYbus(G.getPreset('ieee5'));
    assert.ok(Math.abs(y.G[0][0]) < Math.abs(yFull.G[0][0]), `status ${marker} did not remove the branch`);
  }
});

/* Finding 2: a Q-limited PV switch serialized as type pq with qMin/qMax,
   which the module's own validator rejects on re-import. */
test('experiment JSON re-imports and re-solves after a PV-to-PQ switch', () => {
  const raw = G.getPreset('ieee5');
  raw.buses.forEach(b => { if (b.type === 'pv') { b.qMin = -0.05; b.qMax = 0.05; } });
  const sol = G.solveAC(raw);
  assert.ok(sol.qLimited.length > 0, 'test setup should force at least one switch');
  const text = G.exportExperimentJSON(sol, { preset: 'test' });
  const obj = JSON.parse(text);
  const rerun = G.solveAC(obj.network);
  assert.ok(rerun.converged, 're-imported snapshot must solve');
  assert.ok(rerun.qLimited.length > 0, 'the PV spec and its limits survive the round trip');
});

/* Finding 3: csvField must neutralize spreadsheet formula injection while
   leaving plain negative numbers alone. */
test('csvField guards formula-leading characters', () => {
  for (const bad of ['=cmd|"/C calc"!A0', '+1+1', '-2+3', '@SUM(1)', '  =1+1']) {
    const out = G.csvField(bad);
    // The field content must begin with the ' guard, whether or not CSV
    // quoting wraps it for an embedded comma or quote.
    assert.ok(out.startsWith("'") || out.startsWith("\"'"), `unguarded formula field: ${bad} -> ${out}`);
  }
});

test('csvField leaves numbers, ordinary text and quoted content intact', () => {
  assert.equal(G.csvField('-0.12345'), '-0.12345');
  assert.equal(G.csvField(42), '42');
  assert.equal(G.csvField('B4'), 'B4');
  assert.equal(G.csvField('a,b'), '"a,b"');
  assert.equal(G.csvField('say "hi"'), '"say ""hi"""');
  assert.equal(G.csvField(''), '');
});

/* Finding 4: degenerate-but-accepted inputs leak Infinity/NaN tokens into
   the CSV exports. Cells for non-finite values must be empty. */
test('degenerate solves never leak Infinity or NaN tokens into CSV exports', () => {
  const net = {
    baseMVA: 100,
    buses: [
      { id: 'S', type: 'slack', vm: 1e154, va: 0, pd: 0, qd: 0 },
      { id: 'L', type: 'pq', vm: 1, va: 0, pd: 0.5, qd: 0.2 }
    ],
    branches: [{ id: 'L1', from: 0, to: 1, r: 0.01, x: 0.1, b: 0, rateMVA: 1 }]
  };
  const sol = G.solveAC(net, { enforceQLimits: false });
  const texts = [G.exportBusCSV(sol), G.exportBranchCSV(sol), G.exportConvergenceCSV(sol)];
  for (const t of texts) {
    assert.ok(!/Infinity|NaN/.test(t), 'CSV contains a non-finite token:\n' + t);
  }
});

test('converged exports still write ordinary fixed-precision numbers', () => {
  const sol = G.solveAC(G.getPreset('ieee5'));
  assert.ok(sol.converged);
  const lines = G.exportBusCSV(sol).trim().split('\n');
  assert.match(lines[1], /slack,[01]\.\d{8},/);
});

/* Finding 5: dynamic readouts must announce themselves to screen readers. */
test('convergence and N-1 status readouts are live regions', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  for (const id of ['convergenceReadout', 'contStatus']) {
    const m = html.match(new RegExp('id="' + id + '"[^>]*>'));
    assert.ok(m, id + ' missing');
    assert.match(m[0], /aria-live="polite"/, id + ' lacks aria-live');
  }
});
