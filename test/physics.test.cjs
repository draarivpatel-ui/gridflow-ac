/**
 * GridFlow AC physics invariants, checked parametrically across every
 * synthetic preset, plus exporter and edge-case coverage the other
 * suites do not reach.
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/gridflow.cjs');

const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${a} within ${eps} of ${b}`);
const HEALTHY = ['ieee3', 'ieee5', 'radial', 'stress'];
const ALL = G.presetNames();

for (const name of ALL) {
  describe('preset: ' + name, () => {
    const net = G.getPreset(name);
    const s = G.solveAC(net);

    test('solve reports finite voltages in a sane range', () => {
      assert.ok(s.vm.length === net.buses.length);
      for (const v of s.vm) {
        assert.ok(Number.isFinite(v));
        assert.ok(v > 0 && v < 2, `voltage ${v} out of range`);
      }
      for (const a of s.va) {
        assert.ok(Number.isFinite(a));
        assert.ok(Math.abs(a) < 2, `angle ${a} out of range`);
      }
    });

    test('history residuals are finite, positive and time-ordered', () => {
      assert.ok(s.history.length >= 1);
      let last = Infinity;
      for (const h of s.history) {
        assert.ok(Number.isFinite(h.maxMismatch));
        assert.ok(h.maxMismatch >= 0);
        assert.ok(h.iteration >= 1);
        if (s.converged) {
          assert.ok(h.maxMismatch <= last * (1 + 1e-6), 'residual grew on a converged solve');
          last = h.maxMismatch;
        }
      }
    });

    test('branch flows satisfy local complex power balance', () => {
      const flows = G.branchFlows(s.network, s.vm, s.va);
      assert.equal(flows.length, net.branches.length);
      for (const f of flows) {
        assert.ok(Number.isFinite(f.pFrom) && Number.isFinite(f.pTo));
        assert.ok(Number.isFinite(f.qFrom) && Number.isFinite(f.qTo));
        close(f.lossP, f.pFrom + f.pTo, 1e-9, f.id + ' real loss');
        close(f.lossQ, f.qFrom + f.qTo, 1e-9, f.id + ' reactive loss');
        assert.ok(f.lossP >= -1e-9, f.id + ' negative real loss ' + f.lossP);
        if (!f.status) { assert.equal(f.pFrom, 0); assert.equal(f.pTo, 0); }
      }
    });

    test('branch loading is symmetric between the two line ends', () => {
      const flows = G.branchFlows(s.network, s.vm, s.va);
      for (const f of flows) {
        if (!f.status) { assert.equal(f.loading, 0); continue; }
        assert.ok(Number.isFinite(f.loading) && f.loading >= 0);
        const apparent = Math.hypot(f.pFrom, f.qFrom) * net.baseMVA;
        const br = s.network.branches.find(b => b.id === f.id);
        close(f.loading, Math.max(apparent, Math.hypot(f.pTo, f.qTo) * net.baseMVA) / br.rateMVA, 1e-9, f.id);
      }
    });

    test('lossless network property: zero-resistance clones produce zero real loss', () => {
      const clone = G.getPreset(name);
      for (const b of clone.branches) { b.r = 0; b.b = 0; if (b.x < 0.01) b.x = 0.05; }
      const ls = G.solveAC(clone);
      if (!ls.converged) return; // a lossless clone may not always solve
      const flows = G.branchFlows(ls.network, ls.vm, ls.va);
      for (const f of flows) close(f.lossP, 0, 1e-8, f.id + ' loss on a lossless line');
      const d = G.diagnostics(ls);
      assert.ok(Math.abs(d.totalLoss) < 1e-7);
      assert.ok(Math.abs(d.totalGeneration - d.totalLoad) < 1e-7);
    });

    test('slack bus absorbs the balance that loads and gens do not supply', () => {
      if (!s.converged) return;
      let scheduled = 0;
      for (const b of s.network.buses) scheduled += b.pg - b.pd;
      const d = G.diagnostics(s);
      close(s.slackGeneration.p, d.totalLoad + d.totalLoss - (d.totalGeneration - s.slackGeneration.p), 1e-8);
      assert.ok(Number.isFinite(scheduled));
    });

    test('PV bus voltage setpoints are exactly held when converged and unswitched', () => {
      if (!s.converged) return;
      for (let i = 0; i < s.network.buses.length; i++) {
        const b = s.network.buses[i];
        if (b.type === 'pv') close(s.vm[i], b.vm, 1e-10, b.id + ' setpoint');
      }
    });

    test('exporters accept this solution without throwing', () => {
      for (const fn of [G.exportBusCSV, G.exportBranchCSV, G.exportConvergenceCSV]) {
        const out = fn(s);
        assert.ok(out.endsWith('\n'));
        assert.doesNotMatch(out, /NaN|Infinity|undefined/);
      }
      const json = JSON.parse(G.exportExperimentJSON(s, { preset: name }));
      assert.equal(json.solution.converged, s.converged);
      assert.equal(json.solution.vm.length, net.buses.length);
    });
  });
}

describe('repeated and structural invariants', () => {
  test('angle references: only the slack holds angle zero in a loaded network', () => {
    const s = G.solveAC(G.getPreset('stress'));
    assert.equal(s.converged, true);
    for (let i = 0; i < s.va.length; i++) {
      if (i === s.slack) close(s.va[i], 0);
      else assert.ok(s.va[i] !== 0, `bus ${i} unexpectedly zero angle`);
    }
  });

  test('doubling a purely resistive line impedance doubles its real loss at fixed flow', () => {
    // Two-bus slack to PQ: force flow by making the load fixed; compare losses.
    const mk = r => ({
      buses: [{ type: 'slack', vm: 1.0 }, { type: 'pq', pd: 0.5, qd: 0.2 }],
      branches: [{ from: 0, to: 1, r: r, x: 0.3, b: 0 }], baseMVA: 100
    });
    const a = G.solveAC(mk(0.02)), b = G.solveAC(mk(0.04));
    assert.equal(a.converged && b.converged, true);
    const la = G.branchFlows(a.network, a.vm, a.va)[0].lossP;
    const lb = G.branchFlows(b.network, b.vm, b.va)[0].lossP;
    assert.ok(lb > la, 'more resistance must mean more loss');
    assert.ok(lb / la > 1.5 && lb / la < 2.5, `loss ratio ${lb / la} should roughly double`);
  });

  test('raising slack voltage raises PQ bus voltages monotonically', () => {
    const mk = vs => ({
      buses: [{ type: 'slack', vm: vs }, { type: 'pq', pd: 0.8, qd: 0.4 }, { type: 'pq', pd: 0.6, qd: 0.3 }],
      branches: [{ from: 0, to: 1, r: 0.02, x: 0.12 }, { from: 1, to: 2, r: 0.02, x: 0.12 }], baseMVA: 100
    });
    const lo = G.solveAC(mk(0.98)), hi = G.solveAC(mk(1.05));
    assert.equal(lo.converged && hi.converged, true);
    for (let i = 1; i < 3; i++) assert.ok(hi.vm[i] > lo.vm[i], `bus ${i}: ${hi.vm[i]} vs ${lo.vm[i]}`);
  });

  test('mesh symmetry: identical radial paths split load flow evenly', () => {
    const s = G.solveAC({
      buses: [{ type: 'slack', vm: 1.0 }, { type: 'pq' }, { type: 'pq' }, { type: 'pq', pd: 1.0, qd: 0.4 }],
      branches: [
        { from: 0, to: 1, r: 0.01, x: 0.1 }, { from: 0, to: 2, r: 0.01, x: 0.1 },
        { from: 1, to: 3, r: 0.01, x: 0.1 }, { from: 2, to: 3, r: 0.01, x: 0.1 }
      ], baseMVA: 100
    });
    assert.equal(s.converged, true);
    close(s.vm[1], s.vm[2], 1e-12, 'symmetric buses must share voltage');
    close(s.va[1], s.va[2], 1e-12);
    const flows = G.branchFlows(s.network, s.vm, s.va);
    close(Math.abs(flows[0].pFrom), Math.abs(flows[1].pFrom), 1e-12);
  });

  test('out-of-service branch draws exactly zero flow in AC results', () => {
    const net = G.getPreset('ieee5');
    net.branches[2].status = 0;
    const s = G.solveAC(net);
    assert.equal(s.converged, true);
    const f = G.branchFlows(s.network, s.vm, s.va)[2];
    assert.equal(f.status, 0);
    for (const k of ['pFrom', 'qFrom', 'pTo', 'qTo', 'lossP', 'lossQ', 'loading']) assert.equal(f[k], 0);
  });

  test('taking out the only tie line to a load bus fails honestly', () => {
    const s = G.solveAC({
      buses: [{ type: 'slack', vm: 1 }, { type: 'pq', pd: 0.5, qd: 0.2 }, { type: 'pq', pd: 0.3, qd: 0.1 }],
      branches: [{ from: 0, to: 1, r: 0.02, x: 0.1 }, { from: 0, to: 2, r: 0.02, x: 0.1, status: 0 }],
      baseMVA: 100
    });
    assert.equal(s.converged, false, 'islanded load cannot be served');
    assert.match(s.reason, /Singular|collapse|mismatch/i);
  });

  test('solveAC does not mutate its raw input network', () => {
    const raw = G.getPreset('ieee5');
    const snapshot = JSON.stringify(raw);
    G.solveAC(raw);
    assert.equal(JSON.stringify(raw), snapshot, 'solver mutated caller data');
    const limited = G.getPreset('ieee5');
    limited.buses[3].qMax = 0.01;
    const before = limited.buses[3].type;
    G.solveAC(limited);
    assert.equal(limited.buses[3].type, before, 'Q-limit switch leaked into caller data');
  });

  test('contingency on a network with a failed base solve still screens outages', () => {
    const results = G.contingencyAnalysis(G.getPreset('collapse'));
    assert.ok(results.length >= 1);
    for (const r of results) {
      assert.equal(typeof r.converged, 'boolean');
      if (!r.converged) assert.equal(r.maxLoading, null, 'failed outage must not fabricate loading');
    }
  });

  test('N-1 on a two-bus single-line network reports one outage that fails', () => {
    const results = G.contingencyAnalysis({
      buses: [{ type: 'slack' }, { type: 'pq', pd: 0.4, qd: 0.1 }],
      branches: [{ from: 0, to: 1, r: 0.02, x: 0.1 }], baseMVA: 100
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].converged, false);
  });

  test('CSV field quoting survives adversarial identifiers', () => {
    const s = G.solveAC({
      buses: [{ id: 'S,"1"', type: 'slack', vm: 1 }, { id: 'L\n2', type: 'pq', pd: 0.2, qd: 0.1 }],
      branches: [{ id: 'T,"x"', from: 0, to: 1, r: 0.02, x: 0.1 }], baseMVA: 100
    });
    assert.equal(s.converged, true);
    const csv = G.exportBusCSV(s);
    assert.match(csv, /"S,""1"""/);
    assert.match(csv, /"L\n2"/);
    const br = G.exportBranchCSV(s);
    assert.match(br, /"T,""x"""/);
  });

  test('JSON export round-trips through a full stringify-parse cycle', () => {
    const s = G.solveAC(G.getPreset('ieee5'));
    const obj = JSON.parse(G.exportExperimentJSON(s, { preset: 'ieee5' }));
    assert.deepEqual(obj.network.buses.map(b => b.id), s.network.buses.map(b => b.id));
    assert.equal(obj.solution.iterations, s.iterations);
    assert.equal(obj.solution.mismatch, s.mismatch);
  });
});
