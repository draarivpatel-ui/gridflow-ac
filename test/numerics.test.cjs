/**
 * GridFlow AC numerical rigor tests: finite-difference verification of the
 * analytic Jacobian, the dV/V Newton update semantics, reactive-power limit
 * switching and solver edge cases the main suite does not cover.
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/gridflow.cjs');

const { buildJacobian, newtonCore, mismatchFor } = G._internals;
const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${a} within ${eps} of ${b}`);

function idxOf(network) {
  const angleIdx = [], magIdx = [];
  network.buses.forEach((b, i) => {
    if (b.type !== 'slack') angleIdx.push(i);
    if (b.type === 'pq') magIdx.push(i);
  });
  return { angleIdx, magIdx };
}

// Central finite-difference check of every analytic Jacobian entry. The N and
// L blocks are V-scaled (V_j * d/dV_j), so the finite difference in V is
// multiplied by V_j before comparison.
function fdErrors(network, vm, va, eps = 1e-6) {
  const Y = G.buildYbus(network);
  const { angleIdx, magIdx } = idxOf(network);
  const np = angleIdx.length, nq = magIdx.length;
  const calc = G.calculateInjections(network, Y, vm, va);
  const J = buildJacobian(network, Y, vm, va, calc, angleIdx, magIdx);
  const rows = [];
  const dVa = Float64Array.from(va), dVa2 = Float64Array.from(va);
  const dVm = Float64Array.from(vm), dVm2 = Float64Array.from(vm);
  for (let c = 0; c < np; c++) {
    const j = angleIdx[c];
    dVa[j] = va[j] + eps; dVa2[j] = va[j] - eps;
    const cp = G.calculateInjections(network, Y, vm, dVa);
    const cm = G.calculateInjections(network, Y, vm, dVa2);
    for (let r = 0; r < np; r++) rows.push({ block: 'H', r, c, analytic: J[r][c], fd: (cp.P[angleIdx[r]] - cm.P[angleIdx[r]]) / (2 * eps) });
    for (let r = 0; r < nq; r++) rows.push({ block: 'M', r, c, analytic: J[np + r][c], fd: (cp.Q[magIdx[r]] - cm.Q[magIdx[r]]) / (2 * eps) });
    dVa[j] = va[j]; dVa2[j] = va[j];
  }
  for (let c = 0; c < nq; c++) {
    const j = magIdx[c];
    dVm[j] = vm[j] + eps; dVm2[j] = vm[j] - eps;
    const cp = G.calculateInjections(network, Y, dVm, va);
    const cm = G.calculateInjections(network, Y, dVm2, va);
    for (let r = 0; r < np; r++) rows.push({ block: 'N', r, c, analytic: J[r][np + c], fd: vm[j] * (cp.P[angleIdx[r]] - cm.P[angleIdx[r]]) / (2 * eps) });
    for (let r = 0; r < nq; r++) rows.push({ block: 'L', r, c, analytic: J[np + r][np + c], fd: vm[j] * (cp.Q[magIdx[r]] - cm.Q[magIdx[r]]) / (2 * eps) });
    dVm[j] = vm[j]; dVm2[j] = vm[j];
  }
  return rows;
}

describe('Jacobian finite-difference verification', () => {
  const cases = [
    ['ieee5 flat start', () => { const n = G.normalizeNetwork(G.getPreset('ieee5')); return { n, vm: new Float64Array(5).fill(1), va: new Float64Array(5) }; }],
    ['ieee5 converged state', () => { const s = G.solveAC(G.getPreset('ieee5')); return { n: s.network, vm: s.vm, va: s.va }; }],
    ['ieee5 depressed voltages', () => { const n = G.normalizeNetwork(G.getPreset('ieee5')); return { n, vm: new Float64Array([1.05, 0.82, 0.74, 1.03, 0.66]), va: new Float64Array([0, -0.12, -0.2, -0.05, -0.31]) }; }],
    ['ieee3 mid-solve state', () => { const n = G.normalizeNetwork(G.getPreset('ieee3')); return { n, vm: new Float64Array([1.04, 0.95, 1.02]), va: new Float64Array([0, -0.07, 0.02]) }; }],
    ['radial tail state', () => { const n = G.normalizeNetwork(G.getPreset('radial')); return { n, vm: new Float64Array([1.05, 1.0, 0.93, 0.87, 0.81, 0.77]), va: new Float64Array([0, -0.03, -0.07, -0.11, -0.16, -0.21]) }; }],
    ['slack not at index 0', () => {
      const n = G.normalizeNetwork({
        buses: [{ id: 'L1', type: 'pq', pd: 0.6, qd: 0.2 }, { id: 'G1', type: 'pv', pg: 1.0, vm: 1.02, qd: 0.1 }, { id: 'S', type: 'slack', vm: 1.05 }],
        branches: [{ from: 0, to: 1, r: 0.02, x: 0.1, b: 0.01 }, { from: 1, to: 2, r: 0.01, x: 0.08, b: 0.01 }, { from: 0, to: 2, r: 0.03, x: 0.15, b: 0.02 }],
        baseMVA: 100
      });
      return { n, vm: new Float64Array([0.97, 1.02, 1.05]), va: new Float64Array([-0.08, -0.02, 0]) };
    }]
  ];
  for (const [name, make] of cases) {
    test(`analytic Jacobian matches finite differences: ${name}`, () => {
      const { n, vm, va } = make();
      const rows = fdErrors(n, vm, va);
      assert.ok(rows.length > 0);
      let worst = { err: 0 };
      for (const row of rows) {
        const err = Math.abs(row.analytic - row.fd);
        const scale = Math.max(1, Math.abs(row.analytic));
        row.rel = err / scale;
        if (row.rel > worst.err) worst = { err: row.rel, row };
      }
      assert.ok(worst.err < 5e-5, `${name} worst Jacobian error ${worst.err} at ${JSON.stringify(worst.row)}`);
    });
  }

  test('the V-scaled unknown is dV/V: a multiplicative update beats an additive one', () => {
    // Regression for the additive dV update bug. At a depressed-voltage state
    // the Newton correction dx is relative (dV/V); applying it additively
    // takes a step that is 1/V times too large.
    const net = G.normalizeNetwork(G.getPreset('radial'));
    const Y = G.buildYbus(net);
    const vm = new Float64Array([1.05, 1.0, 0.97, 0.94, 0.91, 0.88]);
    const va = new Float64Array([0, -0.02, -0.05, -0.08, -0.11, -0.14]);
    const { angleIdx, magIdx } = idxOf(net);
    const np = angleIdx.length, nq = magIdx.length;
    const calc = G.calculateInjections(net, Y, vm, va);
    const mis = new Float64Array(np + nq);
    for (let a = 0; a < np; a++) mis[a] = G.scheduledInjection(net.buses[angleIdx[a]]).p - calc.P[angleIdx[a]];
    for (let b = 0; b < nq; b++) mis[np + b] = G.scheduledInjection(net.buses[magIdx[b]]).q - calc.Q[magIdx[b]];
    const J = buildJacobian(net, Y, vm, va, calc, angleIdx, magIdx);
    const dx = G.solveLinear(J, mis);
    const base = mismatchFor(net, Y, vm, va, angleIdx, magIdx).worst;
    const add = Float64Array.from(vm), mul = Float64Array.from(vm);
    const aVa = Float64Array.from(va), mVa = Float64Array.from(va);
    for (let u = 0; u < np; u++) { aVa[angleIdx[u]] += dx[u]; mVa[angleIdx[u]] += dx[u]; }
    for (let v = 0; v < nq; v++) {
      const j = magIdx[v];
      add[j] = vm[j] + dx[np + v];
      mul[j] = vm[j] * (1 + dx[np + v]);
    }
    const misAdd = mismatchFor(net, Y, add, aVa, angleIdx, magIdx).worst;
    const misMul = mismatchFor(net, Y, mul, mVa, angleIdx, magIdx).worst;
    assert.ok(misMul < base, 'multiplicative step must reduce mismatch');
    assert.ok(misMul <= misAdd, `multiplicative ${misMul} should beat additive ${misAdd}`);
  });

  test('Newton converges quadratically: last two residuals shrink superlinearly', () => {
    const s = G.solveAC(G.getPreset('ieee5'));
    const h = s.history;
    assert.ok(h.length >= 3);
    const r1 = h[h.length - 2].maxMismatch, r2 = h[h.length - 1].maxMismatch;
    assert.ok(r2 < r1 * r1 * 1e3 || r2 < 1e-12, `quadratic tail ${r1} -> ${r2}`);
  });

  test('newtonCore hot start converges faster than a flat start', () => {
    const net = G.normalizeNetwork(G.getPreset('ieee5'));
    const Y = G.buildYbus(net);
    const cold = newtonCore(net, Y, new Float64Array(5).fill(1), new Float64Array(5), { maxIter: 60, tol: 1e-10 });
    assert.equal(cold.converged, true);
    const hot = newtonCore(net, Y, cold.vm, cold.va, { maxIter: 60, tol: 1e-10 });
    assert.equal(hot.converged, true);
    assert.ok(hot.iterations <= cold.iterations);
    assert.ok(hot.iterations <= 3, `hot start took ${hot.iterations} iterations`);
  });

  test('mismatchFor measures max absolute injection error', () => {
    const net = G.normalizeNetwork(G.getPreset('ieee3'));
    const Y = G.buildYbus(net);
    const { angleIdx, magIdx } = idxOf(net);
    const zero = mismatchFor(net, Y, new Float64Array(3).fill(1), new Float64Array(3), angleIdx, magIdx);
    assert.ok(zero.worst > 0);
    const s = G.solveAC(G.getPreset('ieee3'));
    const done = mismatchFor(s.network, s.Y, s.vm, s.va, idxOf(s.network).angleIdx, idxOf(s.network).magIdx);
    assert.ok(done.worst < 1e-9);
  });
});

describe('Reactive-power Q-limit switching', () => {
  function limited(preset, limits) {
    const net = G.getPreset(preset);
    for (const [i, l] of Object.entries(limits)) Object.assign(net.buses[Number(i)], l);
    return net;
  }

  test('unbounded PV buses never switch and produce identical results', () => {
    const a = G.solveAC(G.getPreset('ieee5'));
    const b = G.solveAC(G.getPreset('ieee5'), { enforceQLimits: true });
    assert.equal(a.converged && b.converged, true);
    assert.equal(b.qLimited.length, 0);
    for (let i = 0; i < a.vm.length; i++) { close(a.vm[i], b.vm[i]); close(a.va[i], b.va[i]); }
    assert.equal(a.iterations, b.iterations);
  });

  test('a PV bus exceeding qMax switches to PQ at the limit', () => {
    const base = G.solveAC(G.getPreset('ieee5'));
    const need = base.qGeneration[3];
    const net = limited('ieee5', { 3: { qMax: need - 0.05 } });
    const s = G.solveAC(net);
    assert.equal(s.converged, true, s.reason);
    assert.equal(s.qLimited.length, 1);
    assert.equal(s.qLimited[0].bus, 3);
    assert.equal(s.qLimited[0].bound, 'qMax');
    close(s.qLimited[0].qSet, need - 0.05, 1e-12);
    assert.equal(s.network.buses[3].type, 'pq', 'bus switched to pq');
    close(s.network.buses[3].qg, need - 0.05, 1e-12);
    close(s.qGeneration[3], need - 0.05, 1e-6, 'generation clamped to limit');
    assert.notEqual(s.vm[3], 1.03, 'voltage must float off the setpoint');
  });

  test('a PV bus below qMin switches to PQ at the lower limit', () => {
    const base = G.solveAC(G.getPreset('ieee5'));
    const need = base.qGeneration[3];
    const net = limited('ieee5', { 3: { qMin: need + 0.2 } });
    const s = G.solveAC(net);
    assert.equal(s.converged, true, s.reason);
    assert.equal(s.qLimited.length, 1);
    assert.equal(s.qLimited[0].bound, 'qMin');
    close(s.qGeneration[3], need + 0.2, 1e-6);
  });

  test('enforceQLimits false leaves a violating PV bus untouched', () => {
    const base = G.solveAC(G.getPreset('ieee5'));
    const need = base.qGeneration[3];
    const net = limited('ieee5', { 3: { qMax: need - 0.05 } });
    const s = G.solveAC(net, { enforceQLimits: false });
    assert.equal(s.converged, true);
    assert.equal(s.qLimited.length, 0);
    assert.equal(s.network.buses[3].type, 'pv');
    close(s.vm[3], 1.03, 1e-12);
  });

  test('limits just inside the required output do not trigger a switch', () => {
    const base = G.solveAC(G.getPreset('ieee5'));
    const need = base.qGeneration[3];
    const net = limited('ieee5', { 3: { qMin: need - 0.2, qMax: need + 0.2 } });
    const s = G.solveAC(net);
    assert.equal(s.converged, true);
    assert.equal(s.qLimited.length, 0);
    assert.equal(s.network.buses[3].type, 'pv');
  });

  test('both PV buses in a custom network can switch in the same run', () => {
    const s0 = G.solveAC({
      buses: [
        { id: 'S', type: 'slack', vm: 1.05 },
        { id: 'G1', type: 'pv', pg: 0.8, vm: 1.02, qd: 0.1 },
        { id: 'G2', type: 'pv', pg: 0.6, vm: 1.01, qd: 0.1 },
        { id: 'L', type: 'pq', pd: 1.2, qd: 0.9 }
      ],
      branches: [
        { from: 0, to: 3, r: 0.01, x: 0.08, b: 0.02, rateMVA: 300 },
        { from: 1, to: 3, r: 0.02, x: 0.12, b: 0.02, rateMVA: 200 },
        { from: 2, to: 3, r: 0.02, x: 0.15, b: 0.02, rateMVA: 200 }
      ], baseMVA: 100
    });
    assert.equal(s0.converged, true);
    const s = G.solveAC({
      buses: [
        { id: 'S', type: 'slack', vm: 1.05 },
        { id: 'G1', type: 'pv', pg: 0.8, vm: 1.02, qd: 0.1, qMax: 0.05 },
        { id: 'G2', type: 'pv', pg: 0.6, vm: 1.01, qd: 0.1, qMax: 0.05 },
        { id: 'L', type: 'pq', pd: 1.2, qd: 0.9 }
      ],
      branches: [
        { from: 0, to: 3, r: 0.01, x: 0.08, b: 0.02, rateMVA: 300 },
        { from: 1, to: 3, r: 0.02, x: 0.12, b: 0.02, rateMVA: 200 },
        { from: 2, to: 3, r: 0.02, x: 0.15, b: 0.02, rateMVA: 200 }
      ], baseMVA: 100
    });
    assert.equal(s.converged, true, s.reason);
    assert.equal(s.qLimited.length, 2);
    for (const q of s.qLimited) { assert.equal(q.qSet, 0.05); assert.equal(q.bound, 'qMax'); }
    assert.ok(s.iterations > s0.iterations, 're-solve passes count toward total iterations');
    assert.ok(s.history.length > s0.history.length, 'history accumulates across Q-limit passes');
  });

  test('the switched bus voltage departs from its setpoint in the physical direction', () => {
    // A generator unable to supply the needed Q sees its terminal voltage sag.
    const net = limited('ieee5', { 3: { qMax: -0.5 } });
    const s = G.solveAC(net);
    assert.equal(s.converged, true, s.reason);
    assert.equal(s.qLimited.length, 1);
    assert.ok(s.vm[3] < 1.03, `clamped generator should not hold 1.03 pu, got ${s.vm[3]}`);
  });

  test('Q-limit validation rejects bad limit definitions', () => {
    const mk = patch => {
      const net = G.getPreset('ieee3');
      Object.assign(net.buses[2], patch);
      return net;
    };
    assert.throws(() => G.normalizeNetwork(mk({ qMin: 0.5, qMax: 0.1 })), /qMin > qMax/);
    assert.throws(() => G.normalizeNetwork(mk({ qMin: 'abc' })), RangeError);
    assert.throws(() => G.normalizeNetwork(mk({ qMax: NaN })), RangeError);
    const pqNet = G.getPreset('ieee3');
    pqNet.buses[1].qMax = 0.5;
    assert.throws(() => G.normalizeNetwork(pqNet), /only apply to pv/);
    const slackNet = G.getPreset('ieee3');
    slackNet.buses[0].qMin = -0.5;
    assert.throws(() => G.normalizeNetwork(slackNet), /only apply to pv/);
  });

  test('finite limits survive scaleLoad and JSON round trips', () => {
    const net = limited('ieee5', { 3: { qMax: 0.2 } });
    const scaled = G.scaleLoad(net, 1.1);
    assert.equal(scaled.buses[3].qMax, 0.2);
    const s = G.solveAC(scaled);
    const obj = JSON.parse(G.exportExperimentJSON(s, { preset: 'ieee5' }));
    assert.equal(obj.solution.qLimited.length, 1);
    assert.equal(obj.solution.qLimited[0].id, 'B4');
    assert.equal(obj.solution.qLimited[0].qSet, 0.2);
    assert.doesNotMatch(G.exportExperimentJSON(s, { preset: 'ieee5' }), /Infinity|NaN/);
    const csv = G.exportBusCSV(s);
    const row = csv.trim().split('\n')[4].split(',');
    assert.equal(row[1], 'pq', 'switched bus exported as pq');
    close(Number(row[7]), 0.2, 1e-5, 'exported qg is the limit');
  });
});

describe('Solver edge cases beyond the main suite', () => {
  test('maxIter bound is clamped and respected', () => {
    const net = G.getPreset('ieee3');
    const s = G.solveAC(net, { maxIter: 0 });
    assert.ok(s.iterations >= 1, 'maxIter clamps to at least 1');
    const s2 = G.solveAC(net, { maxIter: 2 });
    assert.ok(s2.iterations <= 2);
    assert.equal(s2.converged, false);
  });

  test('non-positive tolerance falls back to the default', () => {
    const s = G.solveAC(G.getPreset('ieee3'), { tolerance: -1 });
    assert.equal(s.converged, true);
    assert.ok(s.mismatch < 1e-9);
  });

  test('flatStart false honors scheduled angles', () => {
    const s = G.solveAC(G.getPreset('ieee5'), { flatStart: false });
    assert.equal(s.converged, true);
    assert.ok(s.mismatch < 1e-9);
  });

  test('a zero-load network sits at scheduled voltages with only charging injections', () => {
    const net = G.getPreset('ieee3');
    for (const b of net.buses) { b.pd = 0; b.qd = 0; b.pg = 0; b.qg = 0; }
    const s = G.solveAC(net);
    assert.equal(s.converged, true);
    const d = G.diagnostics(s);
    assert.equal(d.totalLoad, 0);
    assert.ok(d.totalLoss < 1e-3, 'no load means only tiny charging losses');
    assert.ok(Math.abs(d.balanceError) < 1e-8);
  });

  test('solveDC reports branches it cannot represent', () => {
    const r = G.solveDC({
      buses: [{ type: 'slack' }, { type: 'pq', pd: 0.3 }, { type: 'pq', pd: 0.3 }],
      branches: [{ id: 'RX', from: 0, to: 1, r: 0.05, x: 0 }, { from: 0, to: 2, r: 0.01, x: 0.1 }, { from: 1, to: 2, r: 0.01, x: 0.1 }],
      baseMVA: 100
    });
    assert.equal(r.converged, true);
    assert.deepEqual(r.skippedBranches, ['RX']);
    assert.equal(r.flows[0].p, 0, 'skipped branch carries no DC flow');
    const normal = G.solveDC(G.getPreset('ieee5'));
    assert.deepEqual(normal.skippedBranches, []);
  });

  test('solveAC is deterministic across calls', () => {
    const a = G.solveAC(G.getPreset('ieee5'));
    const b = G.solveAC(G.getPreset('ieee5'));
    assert.deepEqual(Array.from(a.vm), Array.from(b.vm));
    assert.deepEqual(Array.from(a.va), Array.from(b.va));
    assert.equal(a.iterations, b.iterations);
    assert.equal(a.history.length, b.history.length);
  });

  test('presets never mutate the stored PRESETS object', () => {
    const a = G.getPreset('ieee5');
    a.buses[0].pd = 42; a.branches[0].x = 9;
    const b = G.getPreset('ieee5');
    assert.equal(b.buses[0].pd, 0);
    assert.equal(b.branches[0].x, 0.08);
    const s = G.solveAC(G.getPreset('ieee5'), { enforceQLimits: false });
    assert.equal(G.PRESETS.ieee5.buses[3].type, 'pv', 'solving must not mutate the preset library');
  });

  test('solution exposes finite injections and qGeneration on every preset', () => {
    for (const name of ['ieee3', 'ieee5', 'radial', 'stress']) {
      const s = G.solveAC(G.getPreset(name));
      assert.equal(s.converged, true, name);
      assert.equal(s.qGeneration.length, s.network.buses.length);
      for (const v of s.qGeneration) assert.ok(Number.isFinite(v));
      assert.equal(s.slackGeneration.q, s.Q[s.slack] + s.network.buses[s.slack].qd);
    }
  });

  test('a slack-only network (all loads zeroed) still converges', () => {
    const net = G.normalizeNetwork({
      buses: [{ type: 'slack', vm: 1.0 }, { type: 'pq' }],
      branches: [{ from: 0, to: 1, r: 0.01, x: 0.1, b: 0.02 }],
      baseMVA: 100
    });
    const s = G.solveAC({ buses: net.buses, branches: net.branches, baseMVA: 100 });
    assert.equal(s.converged, true);
    assert.ok(s.iterations <= 3);
  });
});
