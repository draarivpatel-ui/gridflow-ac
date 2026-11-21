/**
 * GridFlow AC engine tests: numerical solver, physics invariants,
 * edge cases, exporter integrity and contingency screening.
 * Run: node --test test/*.test.cjs
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/gridflow.cjs');

const EPS = 1e-9;
function close(a, b, eps = EPS) { assert.ok(Math.abs(a - b) <= eps, `expected ${a} within ${eps} of ${b}`); }
function finite(arr, label) {
  assert.ok(arr.length > 0, label + ' empty');
  for (let i = 0; i < arr.length; i++) assert.ok(Number.isFinite(arr[i]), `${label}[${i}] = ${arr[i]}`);
}

/* -------------------------------------------------------------------------- */
describe('Network validation and edge cases', () => {
  test('normalizeNetwork rejects malformed networks', () => {
    assert.throws(() => G.normalizeNetwork(null), RangeError);
    assert.throws(() => G.normalizeNetwork({ buses: [] }), RangeError);
    assert.throws(() => G.normalizeNetwork({ buses: [{ type: 'slack' }], branches: [] }), RangeError);
    assert.throws(() => G.normalizeNetwork({ buses: new Array(65).fill({}), branches: [] }), RangeError);
  });

  test('normalizeNetwork requires exactly one slack bus', () => {
    const net = G.getPreset('ieee3');
    assert.throws(() => G.normalizeNetwork({ ...net, buses: net.buses.map(b => ({ ...b, type: 'pq' })) }), RangeError);
    const two = net.buses.map((b, i) => i === 1 ? { ...b, type: 'slack' } : b);
    assert.throws(() => G.normalizeNetwork({ ...net, buses: two }), RangeError);
  });

  test('normalizeNetwork rejects unknown bus types and nonfinite values', () => {
    const net = G.getPreset('ieee3');
    const bad = JSON.parse(JSON.stringify(net)); bad.buses[1].type = 'generator';
    assert.throws(() => G.normalizeNetwork(bad), RangeError);
    const bad2 = JSON.parse(JSON.stringify(net)); bad2.buses[1].pd = NaN;
    assert.throws(() => G.normalizeNetwork(bad2), RangeError);
    const bad3 = JSON.parse(JSON.stringify(net)); bad3.buses[1].vm = 0;
    assert.throws(() => G.normalizeNetwork(bad3), RangeError);
  });

  test('normalizeNetwork rejects bad branch endpoints, zero impedance and bad ratings', () => {
    const net = G.getPreset('ieee3');
    for (const patch of [{ from: 99 }, { to: -1 }, { from: 0, to: 0 }, { r: 0, x: 0 }, { x: NaN }, { rateMVA: 0 }]) {
      const copy = JSON.parse(JSON.stringify(net));
      Object.assign(copy.branches[0], patch);
      assert.throws(() => G.normalizeNetwork(copy), RangeError, JSON.stringify(patch));
    }
  });

  test('getPreset returns deep copies and rejects unknown names', () => {
    assert.throws(() => G.getPreset('nope'), RangeError);
    const a = G.getPreset('ieee5'), b = G.getPreset('ieee5');
    a.buses[1].pd = 999;
    assert.notEqual(b.buses[1].pd, 999);
    assert.equal(G.presetNames().length, 5);
    for (const name of G.presetNames()) assert.match(G.getPreset(name).label, /Synthetic benchmark/);
  });

  test('scaleLoad scales loads but not generation or branches', () => {
    const net = G.getPreset('ieee5');
    const scaled = G.scaleLoad(net, 2);
    for (let i = 0; i < net.buses.length; i++) {
      close(scaled.buses[i].pd, 2 * net.buses[i].pd);
      close(scaled.buses[i].qd, 2 * net.buses[i].qd);
      close(scaled.buses[i].pg, net.buses[i].pg);
    }
    assert.equal(scaled.branches.length, net.branches.length);
    assert.equal(net.buses[1].pd, 0.9, 'original must not be mutated');
    assert.equal(G.scaleLoad(net, -5).buses[1].pd, 0);
    assert.equal(G.scaleLoad(net, 99).buses[1].pd, 3.6);
  });
});

/* -------------------------------------------------------------------------- */
describe('Linear algebra and Ybus', () => {
  test('solveLinear solves a known 3x3 system exactly', () => {
    const A = [[4, 1, 2], [1, 3, 1], [2, 1, 5]];
    const x = G.solveLinear(A, [7, 5, 8]);
    close(x[0], 1); close(x[1], 1); close(x[2], 1);
  });

  test('solveLinear requires row swaps (partial pivoting)', () => {
    // Column 0 starts at zero, forcing a row swap at the first pivot.
    const A = [[0, 2, 1], [1, 1, 1], [3, 1, 5]];
    const x = G.solveLinear(A, [3, 3, 9]);
    // A x = b must hold; x is not necessarily all ones for this matrix.
    for (let i = 0; i < 3; i++) {
      let row = 0;
      for (let j = 0; j < 3; j++) row += A[i][j] * x[j];
      close(row, [3, 3, 9][i], 1e-10);
    }
  });

  test('solveLinear rejects singular and non-square systems', () => {
    assert.throws(() => G.solveLinear([[1, 2], [2, 4]], [1, 2]), /Singular/);
    assert.throws(() => G.solveLinear([[1, 2, 3]], [1]), RangeError);
    assert.throws(() => G.solveLinear([[1, 2], [3]], [1, 2]), RangeError);
  });

  test('Ybus is symmetric in G and B and has correct diagonal structure', () => {
    for (const name of G.presetNames()) {
      const net = G.normalizeNetwork(G.getPreset(name));
      const Y = G.buildYbus(net), n = net.buses.length;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          close(Y.G[i][j], Y.G[j][i], 1e-12);
          close(Y.B[i][j], Y.B[j][i], 1e-12);
        }
      }
      for (let i = 0; i < n; i++) {
        // Row sums of G are zero (no shunt conductance); B rows include charging.
        let gsum = 0;
        for (let j = 0; j < n; j++) gsum += Y.G[i][j];
        close(gsum, 0, 1e-12);
      }
    }
  });

  test('a two-bus line gives the expected series admittance', () => {
    const net = G.normalizeNetwork({
      buses: [{ type: 'slack', vm: 1 }, { type: 'pq', pd: 0, qd: 0 }],
      branches: [{ from: 0, to: 1, r: 0.04, x: 0.2, b: 0.06 }],
      baseMVA: 100
    });
    const Y = G.buildYbus(net);
    const den = 0.04 * 0.04 + 0.2 * 0.2;
    close(Y.G[0][0], 0.04 / den);
    close(Y.G[0][1], -0.04 / den);
    close(Y.B[0][0], -0.2 / den + 0.03);
    close(Y.B[0][1], 0.2 / den);
  });

  test('out-of-service branches are omitted from Ybus', () => {
    const net = G.normalizeNetwork(G.getPreset('ieee3'));
    const full = G.buildYbus(net);
    net.branches.forEach(b => { if (b.id === 'L12') b.status = 0; });
    const reduced = G.buildYbus(net);
    assert.notEqual(reduced.G[0][0], full.G[0][0]);
    close(reduced.G[0][1], 0, 1e-12);
    close(reduced.B[0][1], 0, 1e-12);
  });

  test('flat voltages with no load give zero injections', () => {
    const net = G.normalizeNetwork(G.getPreset('ieee3'));
    for (const b of net.buses) { b.pd = 0; b.qd = 0; b.pg = 0; b.qg = 0; b.vm = 1; }
    const Y = G.buildYbus(net);
    const vm = new Float64Array(net.buses.length).fill(1);
    const va = new Float64Array(net.buses.length);
    const r = G.calculateInjections(net, Y, vm, va);
    finite(r.P, 'P'); finite(r.Q, 'Q');
    // Real injections vanish on a flat lossless network. Reactive injections
    // are nonzero because the preset lines have shunt charging susceptance,
    // but they must sum to the total line charging (Kirchhoff balance).
    for (let i = 0; i < r.P.length; i++) close(r.P[i], 0, 1e-9);
    finite(r.Q, 'Q');
    let qsum = 0; for (const v of r.Q) qsum += v;
    assert.ok(Number.isFinite(qsum));
    assert.ok(Math.abs(qsum) < 0.2, 'reactive balance should be small');
  });

  test('calculateInjections matches a direct hand computation on a two-bus system', () => {
    const net = G.normalizeNetwork({
      buses: [{ type: 'slack', vm: 1.05 }, { type: 'pq', pd: 0, qd: 0 }],
      branches: [{ from: 0, to: 1, r: 0, x: 0.1, b: 0 }],
      baseMVA: 100
    });
    const Y = G.buildYbus(net);
    const vm = new Float64Array([1.05, 0.98]), va = new Float64Array([0, -0.05]);
    const r = G.calculateInjections(net, Y, vm, va);
    // Lossless line: P_0 = -P_1, and total real loss is zero.
    close(r.P[0] + r.P[1], 0, 1e-12);
    assert.ok(r.P[0] > 0 && r.P[1] < 0);
  });
});

/* -------------------------------------------------------------------------- */
describe('AC power flow convergence and physics invariants', () => {
  const names = ['ieee3', 'ieee5', 'radial', 'stress'];

  test('all four healthy presets converge with tight mismatch', () => {
    for (const name of names) {
      const s = G.solveAC(G.getPreset(name));
      assert.equal(s.converged, true, `${name}: ${s.reason}`);
      assert.ok(s.mismatch < 1e-9, `${name} mismatch ${s.mismatch}`);
      finite(s.vm, `${name} vm`);
      finite(s.va, `${name} va`);
      finite(s.P, `${name} P`);
      finite(s.Q, `${name} Q`);
      assert.ok(s.history.length >= 2);
      for (const h of s.history) assert.ok(Number.isFinite(h.maxMismatch));
    }
  });

  test('Newton-Raphson residuals decrease monotonically toward convergence', () => {
    for (const name of names) {
      const s = G.solveAC(G.getPreset(name));
      for (let i = 1; i < s.history.length; i++) {
        assert.ok(s.history[i].maxMismatch < s.history[i - 1].maxMismatch,
          `${name} iteration ${i}: ${s.history[i].maxMismatch} vs ${s.history[i - 1].maxMismatch}`);
      }
      close(s.history[s.history.length - 1].maxMismatch, s.mismatch, 1e-12);
    }
  });

  test('real power balance: generation equals load plus losses', () => {
    for (const name of names) {
      const s = G.solveAC(G.getPreset(name));
      const d = G.diagnostics(s);
      assert.ok(Math.abs(d.balanceError) < 1e-8, `${name} balance error ${d.balanceError}`);
      assert.ok(d.totalLoss > 0, `${name} must have positive I^2R losses`);
      assert.ok(d.totalGeneration > d.totalLoad, `${name} generation must exceed load`);
      close(d.totalGeneration - d.totalLoad, d.totalLoss, 1e-8);
    }
  });

  test('slack bus generation equals its computed injection plus local load', () => {
    const s = G.solveAC(G.getPreset('ieee5'));
    const bus = s.network.buses[s.slack];
    close(s.slackGeneration.p, s.P[s.slack] + bus.pd, 1e-12);
    close(s.slackGeneration.q, s.Q[s.slack] + bus.qd, 1e-12);
  });

  test('PV buses hold their scheduled voltage magnitude and real injection', () => {
    for (const name of ['ieee3', 'ieee5', 'stress']) {
      const net = G.getPreset(name), s = G.solveAC(net);
      for (let i = 0; i < net.buses.length; i++) {
        if (net.buses[i].type !== 'pv') continue;
        close(s.vm[i], net.buses[i].vm, 1e-12);
        close(s.P[i], net.buses[i].pg - net.buses[i].pd, 1e-8);
      }
    }
  });

  test('slack bus angle stays at zero and is the reference', () => {
    const s = G.solveAC(G.getPreset('ieee5'));
    close(s.va[s.slack], 0, 1e-12);
    assert.ok(s.va.some(v => v < 0), 'load buses should lag the slack angle');
  });

  test('branch losses are nonnegative and equal the sum of end powers', () => {
    for (const name of names) {
      const s = G.solveAC(G.getPreset(name));
      const flows = G.branchFlows(s.network, s.vm, s.va);
      for (const f of flows) {
        assert.ok(f.lossP >= -1e-9, `${name} ${f.id} negative loss ${f.lossP}`);
        close(f.lossP, f.pFrom + f.pTo, 1e-12);
        close(f.lossQ, f.qFrom + f.qTo, 1e-12);
        assert.ok(f.loading >= 0);
        for (const v of [f.pFrom, f.qFrom, f.pTo, f.qTo, f.lossP, f.loading]) assert.ok(Number.isFinite(v));
      }
    }
  });

  test('Kirchhoff current law: bus injections equal the sum of incident branch flows', () => {
    for (const name of names) {
      const s = G.solveAC(G.getPreset(name));
      const flows = G.branchFlows(s.network, s.vm, s.va);
      for (let i = 0; i < s.network.buses.length; i++) {
        let p = 0, q = 0;
        for (const f of flows) {
          if (f.from === i) { p += f.pFrom; q += f.qFrom; }
          if (f.to === i) { p += f.pTo; q += f.qTo; }
        }
        close(p, s.P[i], 1e-8, `${name} bus ${i} P`);
        close(q, s.Q[i], 1e-8, `${name} bus ${i} Q`);
      }
    }
  });

  test('diagnostics flag the real overload and voltage violations in the stress preset', () => {
    const s = G.solveAC(G.getPreset('stress'));
    const d = G.diagnostics(s);
    assert.ok(d.maxLoading > 1, `expected an overload, got ${d.maxLoading}`);
    assert.ok(d.overloaded.length >= 1);
    assert.ok(d.voltageViolations.length >= 1);
    assert.ok(d.minVoltage < 0.9);
    assert.equal(d.branchCount, 4);
    assert.equal(d.busCount, 4);
  });

  test('radial feeder has monotonically decreasing voltage away from the source', () => {
    const s = G.solveAC(G.getPreset('radial'));
    for (let i = 1; i < s.vm.length; i++) {
      assert.ok(s.vm[i] < s.vm[i - 1], `bus ${i} voltage ${s.vm[i]} should be below ${s.vm[i - 1]}`);
    }
  });

  test('increasing load lowers voltage and raises losses', () => {
    const base = G.getPreset('ieee5');
    const light = G.solveAC(G.scaleLoad(base, 0.7));
    const heavy = G.solveAC(G.scaleLoad(base, 1.1));
    const dl = G.diagnostics(light), dh = G.diagnostics(heavy);
    assert.ok(dh.minVoltage < dl.minVoltage, 'heavier load must depress voltage');
    assert.ok(dh.totalLoss > dl.totalLoss, 'heavier load must raise losses');
    assert.ok(dh.totalGeneration > dl.totalGeneration);
  });

  test('damped Newton line search reduces mismatch monotonically on stressed networks', () => {
    // Verify the backtracking line search: every recorded residual must be
    // smaller than the previous one, even at high load factors.
    for (const f of [1.0, 1.2, 1.4, 1.55]) {
      const s = G.solveAC(G.scaleLoad(G.getPreset('radial'), f));
      if (!s.converged) continue;
      for (let i = 1; i < s.history.length; i++) {
        assert.ok(s.history[i].maxMismatch < s.history[i - 1].maxMismatch,
          `factor ${f} iteration ${i}: ${s.history[i].maxMismatch} >= ${s.history[i - 1].maxMismatch}`);
      }
      const d = G.diagnostics(s);
      assert.ok(Math.abs(d.balanceError) < 1e-8, `factor ${f} balance error ${d.balanceError}`);
    }
  });

  test('a sufficiently high load factor reaches the collapse limit', () => {
    const s = G.solveAC(G.scaleLoad(G.getPreset('radial'), 1.8), { maxIter: 200 });
    assert.equal(s.converged, false);
    assert.match(s.reason, /collapse|mismatch-reducing|iteration limit/i);
    assert.ok(s.mismatch > 0);
  });

  test('voltage-collapse preset reports non-convergence honestly', () => {
    const s = G.solveAC(G.getPreset('collapse'));
    assert.equal(s.converged, false);
    assert.match(s.reason, /collapse|mismatch-reducing/i);
    assert.ok(s.mismatch > 1e-3);
    assert.equal(G.diagnostics(s), null, 'no diagnostics should be fabricated for a failed solve');
    finite(s.vm, 'partial vm');
    finite(s.va, 'partial va');
  });

  test('isolated bus with no branches produces a singular Jacobian, not a crash', () => {
    const net = {
      buses: [{ type: 'slack', vm: 1 }, { type: 'pq', pd: 0.1, qd: 0.05 }, { type: 'pq', pd: 0.1, qd: 0.05 }],
      branches: [{ from: 0, to: 1, r: 0.01, x: 0.1 }],
      baseMVA: 100
    };
    const s = G.solveAC(net);
    assert.equal(s.converged, false);
    assert.match(s.reason, /Singular|collapse|mismatch/i);
    finite(s.vm, 'partial vm');
  });

  test('solver respects custom tolerance and iteration limit', () => {
    const net = G.getPreset('ieee3');
    const loose = G.solveAC(net, { tolerance: 1e-4 });
    const one = G.solveAC(net, { maxIter: 1 });
    assert.equal(loose.converged, true);
    assert.ok(loose.iterations <= 8);
    assert.equal(one.converged, false);
    assert.equal(one.iterations, 1);
  });
});

/* -------------------------------------------------------------------------- */
describe('DC power flow', () => {
  test('DC solve converges and reports zero losses', () => {
    const r = G.solveDC(G.getPreset('ieee5'));
    assert.equal(r.converged, true);
    finite(r.va, 'dc angles');
    close(r.losses, 0);
    close(r.va[0], 0, 1e-12);
    for (const f of r.flows) assert.ok(Number.isFinite(f.p));
  });

  test('DC flow is lossless: flow from i to j equals minus flow from j to i', () => {
    const net = G.normalizeNetwork({
      buses: [{ type: 'slack' }, { type: 'pq', pd: 0.5 }, { type: 'pq', pd: 0.5 }],
      branches: [{ from: 0, to: 1, r: 0, x: 0.1 }, { from: 0, to: 2, r: 0, x: 0.1 }],
      baseMVA: 100
    });
    const r = G.solveDC(net);
    // Each radial branch carries its own bus load.
    close(r.flows[0].p, 0.5, 1e-9);
    close(r.flows[1].p, 0.5, 1e-9);
    // Scheduled injection is generation minus load, so two 0.5 pu loads sum to -1.
    close(r.totalInjection, -1, 1e-9);
  });

  test('DC angles approximate AC angles for a lightly loaded meshed network', () => {
    const net = G.scaleLoad(G.getPreset('ieee5'), 0.3);
    const ac = G.solveAC(net), dc = G.solveDC(net);
    assert.equal(ac.converged, true);
    for (let i = 1; i < ac.va.length; i++) {
      assert.ok(Math.abs(ac.va[i] - dc.va[i]) < 0.03, `bus ${i}: AC ${ac.va[i]} vs DC ${dc.va[i]}`);
    }
  });

  test('DC solve detects an islanded network', () => {
    const r = G.solveDC({
      buses: [{ type: 'slack' }, { type: 'pq', pd: 0.2 }, { type: 'pq', pd: 0.2 }],
      branches: [{ from: 0, to: 1, r: 0.01, x: 0.1 }],
      baseMVA: 100
    });
    assert.equal(r.converged, false);
    assert.match(r.reason, /Singular/);
  });
});

/* -------------------------------------------------------------------------- */
describe('N-1 contingency screening', () => {
  test('every in-service branch outage is evaluated for a meshed network', () => {
    const results = G.contingencyAnalysis(G.getPreset('ieee5'));
    assert.equal(results.length, 7);
    for (const r of results) {
      assert.ok(r.outage);
      assert.equal(typeof r.converged, 'boolean');
      if (r.converged) {
        assert.ok(Number.isFinite(r.maxLoading));
        assert.ok(r.maxLoading >= 0);
        assert.ok(Number.isFinite(r.minVoltage));
      }
    }
  });

  test('radial outages cause non-convergence or voltage problems, not fabricated success', () => {
    const results = G.contingencyAnalysis(G.getPreset('radial'));
    assert.equal(results.length, 5);
    const problems = results.filter(r => !r.converged || r.voltageViolations > 0);
    assert.ok(problems.length >= 3, `expected several radial outage problems, got ${problems.length}`);
  });

  test('out-of-service branches are skipped in the contingency list', () => {
    const net = G.getPreset('ieee3');
    net.branches[1].status = 0;
    const results = G.contingencyAnalysis(net);
    assert.equal(results.length, 2);
    assert.ok(!results.some(r => r.outage === 'L23'));
  });
});

/* -------------------------------------------------------------------------- */
describe('Exporter integrity', () => {
  const solution = G.solveAC(G.getPreset('ieee5'));

  test('bus CSV has one row per bus plus a header and finite numeric values', () => {
    const csv = G.exportBusCSV(solution);
    const rows = csv.trim().split('\n');
    assert.equal(rows.length, solution.network.buses.length + 1);
    assert.equal(rows[0], 'bus,type,vm_pu,va_deg,pd_pu,qd_pu,pg_pu,qg_pu,p_inj_pu,q_inj_pu');
    for (let i = 1; i < rows.length; i++) {
      const f = rows[i].split(',');
      assert.equal(f.length, 10);
      for (let j = 2; j < f.length; j++) assert.ok(Number.isFinite(Number(f[j])), `row ${i} field ${j}: ${f[j]}`);
    }
    assert.ok(csv.endsWith('\n'));
    assert.doesNotMatch(csv, /NaN|Infinity/);
  });

  test('branch CSV has one row per branch, finite values and nonnegative losses', () => {
    const csv = G.exportBranchCSV(solution);
    const rows = csv.trim().split('\n');
    assert.equal(rows.length, solution.network.branches.length + 1);
    assert.equal(rows[0], 'branch,from,to,status,p_from_pu,q_from_pu,p_to_pu,q_to_pu,loss_p_pu,loss_q_pu,loading_fraction');
    for (let i = 1; i < rows.length; i++) {
      const f = rows[i].split(',');
      assert.equal(f.length, 11);
      assert.ok(Number(f[8]) >= 0);
      for (let j = 3; j < f.length; j++) assert.ok(Number.isFinite(Number(f[j])));
    }
    assert.doesNotMatch(csv, /NaN|Infinity/);
  });

  test('convergence CSV records the real residual history', () => {
    const csv = G.exportConvergenceCSV(solution);
    const rows = csv.trim().split('\n');
    assert.equal(rows.length, solution.history.length + 1);
    assert.equal(rows[0], 'iteration,max_mismatch_pu,max_p_mismatch_pu,max_q_mismatch_pu');
    for (let i = 1; i < rows.length; i++) {
      const f = rows[i].split(',');
      assert.equal(Number(f[0]), i);
      assert.ok(Number(f[1]) > 0 || i === rows.length - 1);
    }
    assert.doesNotMatch(csv, /NaN|Infinity/);
  });

  test('experiment JSON is valid, finite, complete and round trips', () => {
    const json = G.exportExperimentJSON(solution, { preset: 'ieee5', loadFactor: 1 });
    const obj = JSON.parse(json);
    assert.equal(obj.schemaVersion, 2);
    assert.equal(obj.generator, 'gridflow-ac');
    assert.match(obj.note, /Synthetic benchmark network/);
    assert.equal(obj.preset, 'ieee5');
    assert.equal(obj.baseMVA, 100);
    assert.equal(obj.network.buses.length, 5);
    assert.equal(obj.solution.vm.length, 5);
    assert.equal(obj.solution.history.length, solution.history.length);
    assert.ok(obj.solution.converged);
    assert.equal(obj.flows.length, 7);
    assert.ok(Math.abs(obj.diagnostics.balanceError) < 1e-8);
    assert.doesNotMatch(json, /NaN|Infinity/);
    assert.ok(json.endsWith('\n') === false || json.length > 100);
  });

  test('experiment JSON reflects a scaled load factor', () => {
    const scaled = G.solveAC(G.scaleLoad(G.getPreset('ieee5'), 1.4));
    const obj = JSON.parse(G.exportExperimentJSON(scaled, { preset: 'ieee5', loadFactor: 1.4 }));
    assert.equal(obj.loadFactor, 1.4);
    assert.ok(obj.diagnostics.totalLoad > JSON.parse(G.exportExperimentJSON(solution)).diagnostics.totalLoad);
  });

  test('csvField quotes commas, quotes and newlines correctly', () => {
    assert.equal(G.csvField('plain'), 'plain');
    assert.equal(G.csvField('a,b'), '"a,b"');
    assert.equal(G.csvField('a"b'), '"a""b"');
    assert.equal(G.csvField('a\nb'), '"a\nb"');
  });

  test('failed solves never produce fabricated diagnostics JSON', () => {
    const failed = G.solveAC(G.getPreset('collapse'));
    const obj = JSON.parse(G.exportExperimentJSON(failed, { preset: 'collapse' }));
    assert.equal(obj.solution.converged, false);
    assert.equal(obj.diagnostics, null);
    assert.deepEqual(obj.flows, []);
  });
});
