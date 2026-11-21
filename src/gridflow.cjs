/*
 * GridFlow AC engine.
 *
 * Zero-dependency, deterministic AC and DC power-flow solver for small
 * transmission networks. Works in Node (module.exports) and in the browser
 * (window.GridFlow) so the interactive workbench and the Node test suite
 * execute the exact same algorithms.
 *
 * Units: per-unit on a common MVA base. Bus voltage magnitudes are pu,
 * angles are radians, power injections are pu. Positive P injection means
 * generation minus load; positive Q injection means capacitive support
 * minus reactive demand.
 */
'use strict';
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GridFlow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EPS = 1e-12;
  var MAX_ITER = 60;
  var TOL = 1e-10;

  /* ---------------------------------------------------------------------- */
  /* Utilities                                                              */
  /* ---------------------------------------------------------------------- */

  function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /** Solve A x = b by Gaussian elimination with partial pivoting. */
  function solveLinear(A, b) {
    var n = b.length;
    if (A.length !== n) throw new RangeError('Matrix dimension mismatch');
    var M = [];
    for (var i = 0; i < n; i++) {
      if (!A[i] || A[i].length !== n) throw new RangeError('Matrix must be square');
      M.push(Array.from(A[i], function (v) { return Number(v); }));
    }
    var rhs = Array.from(b, Number);
    for (var k = 0; k < n; k++) {
      var pivot = k;
      for (var r = k + 1; r < n; r++) if (Math.abs(M[r][k]) > Math.abs(M[pivot][k])) pivot = r;
      if (Math.abs(M[pivot][k]) < EPS) throw new Error('Singular Jacobian at row ' + k);
      if (pivot !== k) { var tmp = M[k]; M[k] = M[pivot]; M[pivot] = tmp; var tb = rhs[k]; rhs[k] = rhs[pivot]; rhs[pivot] = tb; }
      for (var rr = k + 1; rr < n; rr++) {
        var f = M[rr][k] / M[k][k];
        if (f === 0) continue;
        M[rr][k] = 0;
        for (var c = k + 1; c < n; c++) M[rr][c] -= f * M[k][c];
        rhs[rr] -= f * rhs[k];
      }
    }
    var x = new Float64Array(n);
    for (var ii = n - 1; ii >= 0; ii--) {
      var s = rhs[ii];
      for (var jj = ii + 1; jj < n; jj++) s -= M[ii][jj] * x[jj];
      x[ii] = s / M[ii][ii];
    }
    return x;
  }

  /* ---------------------------------------------------------------------- */
  /* Network model                                                          */
  /* ---------------------------------------------------------------------- */

  var BUS_TYPES = ['slack', 'pv', 'pq'];

  /**
   * Validate and normalize a network description.
   * buses: [{id, type, pd, qd, pg, qg, vm, va, baseKV}]
   * branches: [{id, from, to, r, x, b, rateMVA}]
   * Indices refer to positions in the buses array.
   */
  function normalizeNetwork(raw) {
    if (!raw || !Array.isArray(raw.buses) || !Array.isArray(raw.branches)) {
      throw new RangeError('network requires buses and branches arrays');
    }
    var n = raw.buses.length;
    if (n < 2 || n > 64) throw new RangeError('bus count must be in [2, 64]');
    var buses = raw.buses.map(function (b, i) {
      var type = String(b.type || 'pq').toLowerCase();
      if (BUS_TYPES.indexOf(type) < 0) throw new RangeError('unknown bus type: ' + type);
      // Number(x || 0) would silently turn NaN into 0, hiding invalid input.
      // Coerce with an explicit nullish check, then validate finiteness below.
      var num = function (value, fallback) { return Number(value == null ? fallback : value); };
      var qMin = b.qMin == null ? -Infinity : Number(b.qMin);
      var qMax = b.qMax == null ? Infinity : Number(b.qMax);
      var bus = {
        id: b.id == null ? 'B' + (i + 1) : String(b.id),
        type: type,
        pd: num(b.pd, 0), qd: num(b.qd, 0),
        pg: num(b.pg, 0), qg: num(b.qg, 0),
        vm: num(b.vm, 1),
        va: num(b.va, 0),
        baseKV: num(b.baseKV, 230),
        vMin: num(b.vMin, 0.9),
        vMax: num(b.vMax, 1.1),
        qMin: qMin, qMax: qMax
      };
      for (var key of ['pd', 'qd', 'pg', 'qg', 'vm', 'va', 'baseKV', 'vMin', 'vMax']) {
        if (!isFiniteNumber(bus[key])) throw new RangeError('nonfinite bus ' + key + ' at ' + bus.id);
      }
      // Reactive limits may be infinite but never NaN, and only bind PV buses.
      if (Number.isNaN(qMin) || Number.isNaN(qMax)) throw new RangeError('nonfinite bus reactive limit at ' + bus.id);
      if (qMin > qMax) throw new RangeError('bus ' + bus.id + ' has qMin > qMax');
      if (type !== 'pv' && (qMin !== -Infinity || qMax !== Infinity)) {
        throw new RangeError('bus ' + bus.id + ' is ' + type + ': reactive limits only apply to pv buses');
      }
      if (bus.vm <= 0) throw new RangeError('bus voltage magnitude must be positive: ' + bus.id);
      return bus;
    });
    var slackCount = buses.filter(function (b) { return b.type === 'slack'; }).length;
    if (slackCount !== 1) throw new RangeError('exactly one slack bus is required, got ' + slackCount);

    var branches = raw.branches.map(function (br, i) {
      var b = {
        id: br.id == null ? 'L' + (i + 1) : String(br.id),
        from: Number(br.from), to: Number(br.to),
        r: Number(br.r == null ? 0 : br.r), x: Number(br.x == null ? 0.1 : br.x),
        b: Number(br.b == null ? 0 : br.b),
        rateMVA: Number(br.rateMVA == null ? 200 : br.rateMVA),
        // Accept any explicit falsy outage marker (false, 0, "0").
        status: (br.status === false || br.status === 0 || br.status === '0') ? 0 : 1
      };
      if (!Number.isInteger(b.from) || !Number.isInteger(b.to) || b.from < 0 || b.to < 0 || b.from >= n || b.to >= n || b.from === b.to) {
        throw new RangeError('invalid branch endpoints: ' + b.id);
      }
      for (var key of ['r', 'x', 'b', 'rateMVA']) {
        if (!isFiniteNumber(b[key])) throw new RangeError('nonfinite branch ' + key + ' at ' + b.id);
      }
      if (b.r * b.r + b.x * b.x < EPS) throw new RangeError('branch impedance is zero: ' + b.id);
      if (b.rateMVA <= 0) throw new RangeError('branch rating must be positive: ' + b.id);
      return b;
    });
    var baseMVA = isFiniteNumber(raw.baseMVA) && raw.baseMVA > 0 ? Number(raw.baseMVA) : 100;
    return { buses: buses, branches: branches, baseMVA: baseMVA };
  }

  /**
   * Build the complex bus admittance matrix in real G/B form.
   * Series admittance y = 1/(r + jx); half line charging susceptance b/2
   * is added at each end. Transformer tap ratios are not modeled.
   */
  /* Outage predicate shared by every branch walker. Only an explicit
     out-of-service marker removes a branch; an absent status field means
     in-service, matching normalizeNetwork's default. */
  function isOutOfService(br) {
    return br.status === false || br.status === 0 || br.status === '0';
  }

  function buildYbus(network) {
    var n = network.buses.length;
    var G = Array.from({ length: n }, function () { return new Float64Array(n); });
    var B = Array.from({ length: n }, function () { return new Float64Array(n); });
    for (var k = 0; k < network.branches.length; k++) {
      var br = network.branches[k];
      if (isOutOfService(br)) continue;
      var i = br.from, j = br.to;
      var den = br.r * br.r + br.x * br.x;
      var g = br.r / den, beta = -br.x / den, halfB = br.b / 2;
      G[i][i] += g; G[j][j] += g;
      G[i][j] -= g; G[j][i] -= g;
      B[i][i] += beta + halfB; B[j][j] += beta + halfB;
      B[i][j] -= beta; B[j][i] -= beta;
    }
    return { G: G, B: B };
  }

  /* ---------------------------------------------------------------------- */
  /* AC power flow                                                          */
  /* ---------------------------------------------------------------------- */

  /** Scheduled net injection at each bus: generation minus load (pu). */
  function scheduledInjection(bus) {
    return { p: bus.pg - bus.pd, q: bus.qg - bus.qd };
  }

  /** Computed P and Q injections from the current voltage state. */
  function calculateInjections(network, Y, vm, va) {
    var n = network.buses.length;
    var P = new Float64Array(n), Q = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var p = 0, q = 0;
      for (var j = 0; j < n; j++) {
        var d = va[i] - va[j];
        var c = Math.cos(d), s = Math.sin(d);
        var vij = vm[i] * vm[j];
        p += vij * (Y.G[i][j] * c + Y.B[i][j] * s);
        q += vij * (Y.G[i][j] * s - Y.B[i][j] * c);
      }
      P[i] = p; Q[i] = q;
    }
    return { P: P, Q: Q };
  }

  /** Build the four analytic Jacobian blocks at the current state. */
  function buildJacobian(network, Y, vm, va, calc, angleIdx, magIdx) {
    var np = angleIdx.length, nq = magIdx.length;
    var H = zeros(np, np), N = zeros(np, nq), M = zeros(nq, np), L = zeros(nq, nq);
    for (var ra = 0; ra < np; ra++) {
      var ii = angleIdx[ra];
      for (var ca = 0; ca < np; ca++) {
        var jj = angleIdx[ca];
        var d = va[ii] - va[jj], c = Math.cos(d), s = Math.sin(d), vij = vm[ii] * vm[jj];
        H[ra][ca] = ii === jj
          ? -calc.Q[ii] - Y.B[ii][ii] * vm[ii] * vm[ii]
          : vij * (Y.G[ii][jj] * s - Y.B[ii][jj] * c);
      }
      for (var cm = 0; cm < nq; cm++) {
        var jm = magIdx[cm];
        var dm = va[ii] - va[jm], cm2 = Math.cos(dm), sm = Math.sin(dm);
        N[ra][cm] = ii === jm
          ? calc.P[ii] + Y.G[ii][ii] * vm[ii] * vm[ii]
          : vm[ii] * vm[jm] * (Y.G[ii][jm] * cm2 + Y.B[ii][jm] * sm);
      }
    }
    for (var rb = 0; rb < nq; rb++) {
      var qq = magIdx[rb];
      for (var cb = 0; cb < np; cb++) {
        var jt = angleIdx[cb];
        var dt = va[qq] - va[jt], ct = Math.cos(dt), st = Math.sin(dt);
        M[rb][cb] = qq === jt
          ? calc.P[qq] - Y.G[qq][qq] * vm[qq] * vm[qq]
          : -vm[qq] * vm[jt] * (Y.G[qq][jt] * ct + Y.B[qq][jt] * st);
      }
      for (var cl = 0; cl < nq; cl++) {
        var jl = magIdx[cl];
        var dl = va[qq] - va[jl], cl2 = Math.cos(dl), sl = Math.sin(dl);
        L[rb][cl] = qq === jl
          ? calc.Q[qq] - Y.B[qq][qq] * vm[qq] * vm[qq]
          : vm[qq] * vm[jl] * (Y.G[qq][jl] * sl - Y.B[qq][jl] * cl2);
      }
    }
    var dim = np + nq, J = zeros(dim, dim);
    for (var r1 = 0; r1 < np; r1++) {
      for (var c1 = 0; c1 < np; c1++) J[r1][c1] = H[r1][c1];
      for (var c2 = 0; c2 < nq; c2++) J[r1][np + c2] = N[r1][c2];
    }
    for (var r2 = 0; r2 < nq; r2++) {
      for (var c3 = 0; c3 < np; c3++) J[np + r2][c3] = M[r2][c3];
      for (var c4 = 0; c4 < nq; c4++) J[np + r2][np + c4] = L[r2][c4];
    }
    return J;
  }

  /** Maximum absolute power-injection mismatch for a candidate state. */
  function mismatchFor(network, Y, vm, va, angleIdx, magIdx) {
    var calc = calculateInjections(network, Y, vm, va);
    var worst = 0;
    for (var a = 0; a < angleIdx.length; a++) {
      var bi = angleIdx[a];
      worst = Math.max(worst, Math.abs(scheduledInjection(network.buses[bi]).p - calc.P[bi]));
    }
    for (var b = 0; b < magIdx.length; b++) {
      var bj = magIdx[b];
      worst = Math.max(worst, Math.abs(scheduledInjection(network.buses[bj]).q - calc.Q[bj]));
    }
    return { worst: worst, calc: calc };
  }

  /**
   * Damped Newton-Raphson core for one fixed network state.
   * A backtracking line search on the maximum mismatch prevents the wild
   * angle excursions that a full undamped step can cause near the
   * voltage-collapse nose of heavily loaded radial networks.
   */
  function newtonCore(network, Y, initialVm, initialVa, opts) {
    var buses = network.buses, n = buses.length;
    var vm = new Float64Array(initialVm), va = new Float64Array(initialVa);
    var angleIdx = [], magIdx = [];
    for (var i = 0; i < n; i++) {
      if (buses[i].type !== 'slack') angleIdx.push(i);
      if (buses[i].type === 'pq') magIdx.push(i);
    }
    var np = angleIdx.length, nq = magIdx.length, dim = np + nq;
    var maxIter = opts.maxIter, tol = opts.tol;
    var history = [], converged = false, iterations = 0, mismatch = Infinity;

    for (var iter = 0; iter < maxIter; iter++) {
      iterations = iter + 1;
      var state = mismatchFor(network, Y, vm, va, angleIdx, magIdx);
      var calc = state.calc;
      var misP = new Float64Array(np), misQ = new Float64Array(nq), maxMis = 0;
      for (var a = 0; a < np; a++) {
        var bi = angleIdx[a];
        misP[a] = scheduledInjection(buses[bi]).p - calc.P[bi];
        maxMis = Math.max(maxMis, Math.abs(misP[a]));
      }
      for (var b = 0; b < nq; b++) {
        var bj = magIdx[b];
        misQ[b] = scheduledInjection(buses[bj]).q - calc.Q[bj];
        maxMis = Math.max(maxMis, Math.abs(misQ[b]));
      }
      mismatch = maxMis;
      history.push({ iteration: iterations, maxMismatch: maxMis,
        maxP: np ? Math.max.apply(null, Array.from(misP, Math.abs)) : 0,
        maxQ: nq ? Math.max.apply(null, Array.from(misQ, Math.abs)) : 0 });
      if (maxMis < tol || dim === 0) { converged = true; break; }

      var J = buildJacobian(network, Y, vm, va, calc, angleIdx, magIdx);
      var rhs = new Float64Array(dim);
      for (var r = 0; r < np; r++) rhs[r] = misP[r];
      for (var q = 0; q < nq; q++) rhs[np + q] = misQ[q];
      var dx;
      try { dx = solveLinear(J, rhs); }
      catch (e) { return { converged: false, reason: e.message, iterations: iterations, mismatch: mismatch, history: history, vm: vm, va: va }; }

      // Backtracking line search. Accept the largest step that reduces the
      // mismatch; never take a step that increases it.
      var step = 1, accepted = false;
      for (var trial = 0; trial < 12; trial++) {
        var cVm = new Float64Array(vm), cVa = new Float64Array(va);
        for (var u = 0; u < np; u++) cVa[angleIdx[u]] += step * dx[u];
        for (var v = 0; v < nq; v++) {
          // N and L are the V-scaled blocks (V_j * d/dV_j), so the unknown
          // solved for is the relative correction dV_j / V_j. The update must
          // therefore be multiplicative, not additive.
          var jm = magIdx[v];
          cVm[jm] = clamp(vm[jm] * (1 + step * dx[np + v]), 0.2, 2.0);
        }
        var trialState = mismatchFor(network, Y, cVm, cVa, angleIdx, magIdx);
        if (trialState.worst < maxMis * (1 - 1e-4 * step)) {
          vm = cVm; va = cVa; accepted = true; break;
        }
        step *= 0.5;
      }
      if (!accepted) {
        return { converged: false, reason: 'no mismatch-reducing Newton step (voltage collapse limit)',
          iterations: iterations, mismatch: mismatch, history: history, vm: vm, va: va };
      }
    }
    return { converged: converged, reason: converged ? 'converged' : 'iteration limit reached',
      iterations: iterations, mismatch: mismatch, history: history, vm: vm, va: va };
  }

  /**
   * Damped Newton-Raphson AC power flow.
   * Unknowns: voltage angle at every non-slack bus, voltage magnitude at
   * every PQ bus. PV buses hold their scheduled |V| and real injection.
   * A backtracking line search on the maximum mismatch prevents divergence
   * near the voltage-collapse nose; a failed solve is reported honestly.
   */
  function solveAC(rawNetwork, options) {
    var opts = options || {};
    var maxIter = Number.isInteger(opts.maxIter) ? clamp(opts.maxIter, 1, 200) : MAX_ITER;
    var tol = isFiniteNumber(opts.tolerance) && opts.tolerance > 0 ? opts.tolerance : TOL;
    var network = normalizeNetwork(rawNetwork);
    var n = network.buses.length, buses = network.buses;
    var Y = buildYbus(network);

    var startVm = new Float64Array(n), startVa = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      if (opts.flatStart === false) { startVm[i] = buses[i].vm; startVa[i] = buses[i].va; }
      else { startVm[i] = buses[i].type === 'pq' ? 1 : buses[i].vm; startVa[i] = 0; }
    }

    var core = newtonCore(network, Y, startVm, startVa, { maxIter: maxIter, tol: tol });
    var history = core.history.slice();
    var totalIterations = core.iterations;
    var qLimited = [];
    var switched = {};

    // Reactive-power limit enforcement. After each converged solve, every PV
    // bus whose required Q output violates its qMin/qMax is switched to a PQ
    // bus with qg clamped to the violated limit and the flow is re-solved,
    // hot-started from the last state. A switched bus cannot violate again, so
    // the loop terminates within the number of PV buses.
    if (core.converged && opts.enforceQLimits !== false) {
      for (var pass = 0; pass <= n; pass++) {
        var inj = calculateInjections(network, Y, core.vm, core.va);
        var violations = [];
        for (var bi = 0; bi < n; bi++) {
          var bb = buses[bi];
          if (bb.type !== 'pv' || switched[bi]) continue;
          var need = inj.Q[bi] + bb.qd;
          if (need > bb.qMax + 1e-9 || need < bb.qMin - 1e-9) {
            violations.push({ i: bi, need: need });
          }
        }
        if (!violations.length) break;
        for (var vi = 0; vi < violations.length; vi++) {
          var v = violations[vi], bus = buses[v.i];
          var bound = v.need > bus.qMax ? 'qMax' : 'qMin';
          var applied = bound === 'qMax' ? bus.qMax : bus.qMin;
          bus.type = 'pq';
          bus.qg = applied;
          switched[v.i] = true;
          qLimited.push({ bus: v.i, id: bus.id, qRequired: v.need, qSet: applied, bound: bound });
        }
        var prevVm = core.vm, prevVa = core.va;
        core = newtonCore(network, Y, prevVm, prevVa, { maxIter: maxIter, tol: tol });
        totalIterations += core.iterations;
        for (var h = 0; h < core.history.length; h++) {
          history.push({ iteration: totalIterations - core.iterations + core.history[h].iteration,
            maxMismatch: core.history[h].maxMismatch, maxP: core.history[h].maxP, maxQ: core.history[h].maxQ });
        }
        if (!core.converged) {
          core.reason = 'non-converged after PV-to-PQ reactive-limit switch';
          break;
        }
      }
    }

    var vm = core.vm, va = core.va, converged = core.converged;
    var mismatch = core.mismatch;
    var final = calculateInjections(network, Y, vm, va);
    var slack = buses.findIndex(function (b) { return b.type === 'slack'; });
    var slackGen = { p: final.P[slack] + buses[slack].pd, q: final.Q[slack] + buses[slack].qd };
    var qGen = new Float64Array(n);
    for (var gi = 0; gi < n; gi++) qGen[gi] = final.Q[gi] + buses[gi].qd;

    return {
      converged: converged, reason: core.reason,
      iterations: totalIterations, mismatch: mismatch, history: history,
      network: network, Y: Y, vm: vm, va: va,
      P: final.P, Q: final.Q, slack: slack,
      slackGeneration: slackGen, qGeneration: qGen,
      qLimited: qLimited
    };
  }

  function zeros(rows, cols) {
    var out = [];
    for (var i = 0; i < rows; i++) out.push(new Float64Array(cols));
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Branch flows, losses and diagnostics                                    */
  /* ---------------------------------------------------------------------- */

  /** Complex power flow at both ends of every branch, plus real losses. */
  function branchFlows(network, vm, va) {
    var Y = buildYbus(network);
    return network.branches.map(function (br) {
      if (isOutOfService(br)) {
        return { id: br.id, from: br.from, to: br.to, status: 0,
          pFrom: 0, qFrom: 0, pTo: 0, qTo: 0, lossP: 0, lossQ: 0, loading: 0 };
      }
      var i = br.from, j = br.to;
      var den = br.r * br.r + br.x * br.x;
      var g = br.r / den, beta = -br.x / den, halfB = br.b / 2;
      var d = va[i] - va[j], c = Math.cos(d), s = Math.sin(d);
      var pFrom = vm[i] * vm[i] * (g + 0) - vm[i] * vm[j] * (g * c + beta * s);
      var qFrom = -vm[i] * vm[i] * (beta + halfB) - vm[i] * vm[j] * (g * s - beta * c);
      var d2 = -d, c2 = Math.cos(d2), s2 = Math.sin(d2);
      var pTo = vm[j] * vm[j] * g - vm[j] * vm[i] * (g * c2 + beta * s2);
      var qTo = -vm[j] * vm[j] * (beta + halfB) - vm[j] * vm[i] * (g * s2 - beta * c2);
      var sFrom = Math.hypot(pFrom, qFrom), sTo = Math.hypot(pTo, qTo);
      return {
        id: br.id, from: br.from, to: br.to, status: 1,
        pFrom: pFrom, qFrom: qFrom, pTo: pTo, qTo: qTo,
        lossP: pFrom + pTo, lossQ: qFrom + qTo,
        loading: Math.max(sFrom, sTo) * network.baseMVA / br.rateMVA,
        sFrom: sFrom, sTo: sTo
      };
    });
  }

  /** Newton-Raphson DC power flow: B' * theta = P (lossless, flat voltage). */
  function solveDC(rawNetwork) {
    var network = normalizeNetwork(rawNetwork);
    var n = network.buses.length;
    var slack = network.buses.findIndex(function (b) { return b.type === 'slack'; });
    var B = zeros(n, n), skipped = [];
    for (var k = 0; k < network.branches.length; k++) {
      var br = network.branches[k];
      if (!br.status) continue;
      // The DC model needs a nonzero series reactance; a pure-resistance
      // branch cannot be represented, so it is reported rather than dropped.
      if (Math.abs(br.x) < EPS) { skipped.push(br.id); continue; }
      var b = 1 / br.x;
      B[br.from][br.from] += b; B[br.to][br.to] += b;
      B[br.from][br.to] -= b; B[br.to][br.from] -= b;
    }
    var idx = [], P = [];
    for (var i = 0; i < n; i++) {
      if (i === slack) continue;
      idx.push(i);
      var s = scheduledInjection(network.buses[i]);
      P.push(s.p);
    }
    var Br = zeros(idx.length, idx.length);
    for (var r = 0; r < idx.length; r++) for (var c = 0; c < idx.length; c++) Br[r][c] = B[idx[r]][idx[c]];
    var theta;
    try { theta = solveLinear(Br, P); }
    catch (e) { return { converged: false, reason: e.message, network: network }; }
    var va = new Float64Array(n);
    for (var a = 0; a < idx.length; a++) va[idx[a]] = theta[a];
    var flows = network.branches.map(function (br) {
      if (!br.status || Math.abs(br.x) < EPS) return { id: br.id, p: 0, loading: 0 };
      var p = (va[br.from] - va[br.to]) / br.x;
      return { id: br.id, p: p, loading: Math.abs(p) * network.baseMVA / br.rateMVA };
    });
    var totalP = flows.reduce(function (s, f) { return s + f.p; }, 0);
    return { converged: true, network: network, va: va, flows: flows,
      totalInjection: P.reduce(function (a, b) { return a + b; }, 0),
      totalFlow: totalP, losses: 0, skippedBranches: skipped };
  }

  /** Aggregate diagnostics from a solved AC state. */
  function diagnostics(solution) {
    if (!solution || !solution.converged) return null;
    var network = solution.network, n = network.buses.length;
    var flows = branchFlows(network, solution.vm, solution.va);
    var totalLoss = 0, maxLoading = 0, overloaded = [], vViolations = [];
    for (var f of flows) {
      totalLoss += f.lossP;
      maxLoading = Math.max(maxLoading, f.loading);
      if (f.loading > 1) overloaded.push(f.id);
    }
    for (var i = 0; i < n; i++) {
      if (solution.vm[i] < network.buses[i].vMin || solution.vm[i] > network.buses[i].vMax) {
        vViolations.push(network.buses[i].id);
      }
    }
    var totalGen = 0, totalLoad = 0;
    for (var j = 0; j < n; j++) {
      totalLoad += network.buses[j].pd;
      totalGen += network.buses[j].type === 'slack' ? solution.slackGeneration.p : network.buses[j].pg;
    }
    return {
      busCount: n, branchCount: network.branches.length,
      iterations: solution.iterations, mismatch: solution.mismatch,
      totalGeneration: totalGen, totalLoad: totalLoad, totalLoss: totalLoss,
      balanceError: totalGen - totalLoad - totalLoss,
      maxLoading: maxLoading, overloaded: overloaded,
      voltageViolations: vViolations,
      minVoltage: Math.min.apply(null, Array.from(solution.vm)),
      maxVoltage: Math.max.apply(null, Array.from(solution.vm)),
      flows: flows
    };
  }

  /** Screen each single-branch outage (N-1) with a full AC re-solve. */
  function contingencyAnalysis(rawNetwork, options) {
    var network = normalizeNetwork(rawNetwork);
    var results = [];
    for (var k = 0; k < network.branches.length; k++) {
      if (!network.branches[k].status) continue;
      var copy = {
        buses: network.buses.map(function (b) { return Object.assign({}, b); }),
        branches: network.branches.map(function (b) { return Object.assign({}, b); }),
        baseMVA: network.baseMVA
      };
      copy.branches[k].status = 0;
      var sol = solveAC(copy, options);
      var d = sol.converged ? diagnostics(sol) : null;
      results.push({
        outage: network.branches[k].id,
        converged: sol.converged,
        reason: sol.reason,
        maxLoading: d ? d.maxLoading : null,
        overloaded: d ? d.overloaded.length : null,
        voltageViolations: d ? d.voltageViolations.length : null,
        minVoltage: d ? d.minVoltage : null
      });
    }
    return results;
  }

  /* ---------------------------------------------------------------------- */
  /* Synthetic benchmark networks                                           */
  /* ---------------------------------------------------------------------- */

  var PRESETS = {
    'ieee3': {
      label: 'Synthetic benchmark: 3-bus loop',
      note: 'One slack, one PV generator and one load bus on a triangular loop. Synthetic teaching network, not a published test case.',
      baseMVA: 100,
      buses: [
        { id: 'B1', type: 'slack', pd: 0, qd: 0, pg: 0, qg: 0, vm: 1.04, va: 0, baseKV: 230 },
        { id: 'B2', type: 'pq', pd: 1.6, qd: 0.6, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 230 },
        { id: 'B3', type: 'pv', pd: 0.4, qd: 0.1, pg: 1.2, qg: 0, vm: 1.02, va: 0, baseKV: 230 }
      ],
      branches: [
        { id: 'L12', from: 0, to: 1, r: 0.01, x: 0.10, b: 0.02, rateMVA: 250 },
        { id: 'L23', from: 1, to: 2, r: 0.02, x: 0.18, b: 0.01, rateMVA: 180 },
        { id: 'L13', from: 0, to: 2, r: 0.015, x: 0.14, b: 0.02, rateMVA: 220 }
      ]
    },
    'ieee5': {
      label: 'Synthetic benchmark: 5-bus meshed',
      note: 'Five-bus meshed benchmark with two generators and three load buses. Synthetic teaching network, not a published test case.',
      baseMVA: 100,
      buses: [
        { id: 'B1', type: 'slack', pd: 0, qd: 0, pg: 0, qg: 0, vm: 1.05, va: 0, baseKV: 230 },
        { id: 'B2', type: 'pq', pd: 0.9, qd: 0.35, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 230 },
        { id: 'B3', type: 'pq', pd: 1.3, qd: 0.5, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 230 },
        { id: 'B4', type: 'pv', pd: 0.5, qd: 0.2, pg: 1.4, qg: 0, vm: 1.03, va: 0, baseKV: 230 },
        { id: 'B5', type: 'pq', pd: 0.7, qd: 0.25, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 230 }
      ],
      branches: [
        { id: 'L12', from: 0, to: 1, r: 0.008, x: 0.08, b: 0.02, rateMVA: 300 },
        { id: 'L23', from: 1, to: 2, r: 0.012, x: 0.12, b: 0.01, rateMVA: 220 },
        { id: 'L34', from: 2, to: 3, r: 0.01, x: 0.10, b: 0.01, rateMVA: 220 },
        { id: 'L45', from: 3, to: 4, r: 0.015, x: 0.15, b: 0.01, rateMVA: 200 },
        { id: 'L51', from: 4, to: 0, r: 0.02, x: 0.18, b: 0.02, rateMVA: 250 },
        { id: 'L13', from: 0, to: 2, r: 0.018, x: 0.16, b: 0.01, rateMVA: 200 },
        { id: 'L24', from: 1, to: 3, r: 0.014, x: 0.13, b: 0.01, rateMVA: 180 }
      ]
    },
    'radial': {
      label: 'Synthetic benchmark: 6-bus radial feeder',
      note: 'A radial distribution-style feeder with no loop flow. Synthetic teaching network, not a published test case.',
      baseMVA: 100,
      buses: [
        { id: 'B1', type: 'slack', pd: 0, qd: 0, pg: 0, qg: 0, vm: 1.05, va: 0, baseKV: 132 },
        { id: 'B2', type: 'pq', pd: 0.22, qd: 0.08, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 132 },
        { id: 'B3', type: 'pq', pd: 0.30, qd: 0.11, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 132 },
        { id: 'B4', type: 'pq', pd: 0.26, qd: 0.09, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 132 },
        { id: 'B5', type: 'pq', pd: 0.18, qd: 0.06, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 132 },
        { id: 'B6', type: 'pq', pd: 0.14, qd: 0.05, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 132 }
      ],
      branches: [
        { id: 'L12', from: 0, to: 1, r: 0.02, x: 0.06, b: 0, rateMVA: 160 },
        { id: 'L23', from: 1, to: 2, r: 0.03, x: 0.09, b: 0, rateMVA: 130 },
        { id: 'L34', from: 2, to: 3, r: 0.025, x: 0.08, b: 0, rateMVA: 110 },
        { id: 'L45', from: 3, to: 4, r: 0.035, x: 0.10, b: 0, rateMVA: 90 },
        { id: 'L56', from: 4, to: 5, r: 0.04, x: 0.12, b: 0, rateMVA: 70 }
      ]
    },
    'collapse': {
      label: 'Synthetic benchmark: voltage-collapse limit',
      note: 'The radial feeder at 1.6 times nominal load. The damped Newton solver correctly reports non-convergence at the collapse nose. Synthetic teaching network, not a published test case.',
      baseMVA: 100,
      buses: [
        { id: 'B1', type: 'slack', pd: 0, qd: 0, pg: 0, qg: 0, vm: 1.05, va: 0, baseKV: 132 },
        { id: 'B2', type: 'pq', pd: 0.352, qd: 0.128, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 132 },
        { id: 'B3', type: 'pq', pd: 0.48, qd: 0.176, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 132 },
        { id: 'B4', type: 'pq', pd: 0.416, qd: 0.144, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 132 },
        { id: 'B5', type: 'pq', pd: 0.288, qd: 0.096, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 132 },
        { id: 'B6', type: 'pq', pd: 0.224, qd: 0.08, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 132 }
      ],
      branches: [
        { id: 'L12', from: 0, to: 1, r: 0.02, x: 0.06, b: 0, rateMVA: 160 },
        { id: 'L23', from: 1, to: 2, r: 0.03, x: 0.09, b: 0, rateMVA: 130 },
        { id: 'L34', from: 2, to: 3, r: 0.025, x: 0.08, b: 0, rateMVA: 110 },
        { id: 'L45', from: 3, to: 4, r: 0.035, x: 0.10, b: 0, rateMVA: 90 },
        { id: 'L56', from: 4, to: 5, r: 0.04, x: 0.12, b: 0, rateMVA: 70 }
      ]
    },
    'stress': {
      label: 'Synthetic benchmark: heavily loaded 4-bus',
      note: 'Higher demand and a tight line rating to show overload and voltage diagnostics. Synthetic teaching network, not a published test case.',
      baseMVA: 100,
      buses: [
        { id: 'B1', type: 'slack', pd: 0, qd: 0, pg: 0, qg: 0, vm: 1.05, va: 0, baseKV: 230 },
        { id: 'B2', type: 'pq', pd: 1.35, qd: 0.55, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 230 },
        { id: 'B3', type: 'pq', pd: 1.15, qd: 0.45, pg: 0, qg: 0, vm: 1, va: 0, baseKV: 230 },
        { id: 'B4', type: 'pv', pd: 0.45, qd: 0.15, pg: 1.0, qg: 0, vm: 1.02, va: 0, baseKV: 230 }
      ],
      branches: [
        { id: 'L12', from: 0, to: 1, r: 0.02, x: 0.16, b: 0.01, rateMVA: 160 },
        { id: 'L23', from: 1, to: 2, r: 0.03, x: 0.22, b: 0.01, rateMVA: 120 },
        { id: 'L34', from: 2, to: 3, r: 0.025, x: 0.18, b: 0.01, rateMVA: 140 },
        { id: 'L14', from: 0, to: 3, r: 0.015, x: 0.12, b: 0.01, rateMVA: 180 }
      ]
    }
  };

  function getPreset(name) {
    var p = PRESETS[name];
    if (!p) throw new RangeError('unknown preset: ' + name);
    return JSON.parse(JSON.stringify(p));
  }
  function presetNames() { return Object.keys(PRESETS); }

  /** Scale every load bus by a factor, keeping generators unchanged. */
  function scaleLoad(network, factor) {
    var copy = {
      buses: network.buses.map(function (b) { return Object.assign({}, b); }),
      branches: network.branches.map(function (b) { return Object.assign({}, b); }),
      baseMVA: network.baseMVA
    };
    var f = clamp(Number(factor), 0, 4);
    for (var i = 0; i < copy.buses.length; i++) {
      copy.buses[i].pd *= f; copy.buses[i].qd *= f;
    }
    return copy;
  }

  /* ---------------------------------------------------------------------- */
  /* Exporters                                                              */
  /* ---------------------------------------------------------------------- */

  function csvField(v) {
    var s = String(v);
    /* Spreadsheet formula injection guard: a cell whose first non-blank
       character is =, + or @, or a leading - that does not form a plain
       number, is evaluated as a formula by Excel and Sheets. Prefixing a
       single quote makes the same applications show it as text. */
    var t = s.trimStart();
    if (t && (t[0] === '=' || t[0] === '+' || t[0] === '@' ||
        (t[0] === '-' && !isFiniteNumber(Number(t))))) {
      s = "'" + s;
    }
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* Format a number with a fixed precision, or an empty cell when the
     value is non-finite. A degenerate solve can carry Infinity or NaN in
     its last-iterate fields; writing the literal tokens would make the
     exported file look meaningful where it is not. */
  function numFixed(v, digits) {
    return isFiniteNumber(v) ? v.toFixed(digits) : '';
  }
  function numExp(v) {
    return isFiniteNumber(v) ? v.toExponential(10) : '';
  }

  /** Bus results CSV with solved magnitudes, angles and injections. */
  function exportBusCSV(solution) {
    var rows = [['bus', 'type', 'vm_pu', 'va_deg', 'pd_pu', 'qd_pu', 'pg_pu', 'qg_pu', 'p_inj_pu', 'q_inj_pu']];
    var s = solution, net = s.network;
    for (var i = 0; i < net.buses.length; i++) {
      var b = net.buses[i];
      var pg = b.type === 'slack' ? s.slackGeneration.p : b.pg;
      var qg = s.qGeneration[i];
      rows.push([b.id, b.type, numFixed(s.vm[i], 8), numFixed(s.va[i] * 180 / Math.PI, 6),
        numFixed(b.pd, 6), numFixed(b.qd, 6), numFixed(pg, 6), numFixed(qg, 6),
        numFixed(s.P[i], 8), numFixed(s.Q[i], 8)]);
    }
    return rows.map(function (r) { return r.map(csvField).join(','); }).join('\n') + '\n';
  }

  /** Branch flow CSV with from/to complex power, losses and loading. */
  function exportBranchCSV(solution) {
    var flows = branchFlows(solution.network, solution.vm, solution.va);
    var rows = [['branch', 'from', 'to', 'status', 'p_from_pu', 'q_from_pu', 'p_to_pu', 'q_to_pu', 'loss_p_pu', 'loss_q_pu', 'loading_fraction']];
    for (var f of flows) {
      rows.push([f.id, f.from, f.to, f.status, numFixed(f.pFrom, 8), numFixed(f.qFrom, 8),
        numFixed(f.pTo, 8), numFixed(f.qTo, 8), numFixed(f.lossP, 8), numFixed(f.lossQ, 8), numFixed(f.loading, 6)]);
    }
    return rows.map(function (r) { return r.map(csvField).join(','); }).join('\n') + '\n';
  }

  /** Convergence history CSV with the actual Newton-Raphson residuals. */
  function exportConvergenceCSV(solution) {
    var rows = [['iteration', 'max_mismatch_pu', 'max_p_mismatch_pu', 'max_q_mismatch_pu']];
    for (var h of solution.history) {
      rows.push([h.iteration, numExp(h.maxMismatch), numExp(h.maxP), numExp(h.maxQ)]);
    }
    return rows.map(function (r) { return r.map(csvField).join(','); }).join('\n') + '\n';
  }

  /** Full portable experiment snapshot. */
  function exportExperimentJSON(solution, meta) {
    var d = diagnostics(solution);
    return JSON.stringify({
      schemaVersion: 2,
      generator: 'gridflow-ac',
      note: 'Synthetic benchmark network solved with Newton-Raphson AC power flow. No measured grid data.',
      preset: meta && meta.preset ? meta.preset : 'custom',
      loadFactor: meta && isFiniteNumber(meta.loadFactor) ? meta.loadFactor : 1,
      baseMVA: solution.network.baseMVA,
      network: {
        /* A PV bus that switched to PQ under Q-limits still carries qMin
           and qMax on the solved network. Serializing it as 'pq' makes the
           snapshot fail validation on re-import, so restore the original
           'pv' declaration; the bus vm field still holds its scheduled
           setpoint because the solver never rewrites it. */
        buses: solution.network.buses.map(function (b, i) {
          var switched = (solution.qLimited || []).some(function (q) { return q.bus === i; });
          return switched ? Object.assign({}, b, { type: 'pv' }) : b;
        }),
        branches: solution.network.branches
      },
      solution: {
        converged: solution.converged, reason: solution.reason,
        iterations: solution.iterations,
        // A failed solve can leave a nonfinite residual; JSON has no Infinity,
        // so encode null instead of silently writing the literal "null".
        mismatch: isFiniteNumber(solution.mismatch) ? solution.mismatch : null,
        history: solution.history,
        vm: Array.from(solution.vm), va: Array.from(solution.va),
        P: Array.from(solution.P), Q: Array.from(solution.Q),
        slackGeneration: solution.slackGeneration,
        qLimited: solution.qLimited || []
      },
      diagnostics: d ? {
        totalGeneration: d.totalGeneration, totalLoad: d.totalLoad, totalLoss: d.totalLoss,
        balanceError: d.balanceError, maxLoading: d.maxLoading,
        overloaded: d.overloaded, voltageViolations: d.voltageViolations,
        minVoltage: d.minVoltage, maxVoltage: d.maxVoltage
      } : null,
      flows: d ? d.flows : []
    }, null, 2);
  }

  var api = {
    BUS_TYPES: BUS_TYPES, PRESETS: PRESETS,
    presetNames: presetNames, getPreset: getPreset, scaleLoad: scaleLoad,
    normalizeNetwork: normalizeNetwork, buildYbus: buildYbus,
    scheduledInjection: scheduledInjection, calculateInjections: calculateInjections,
    solveAC: solveAC, solveDC: solveDC, branchFlows: branchFlows,
    diagnostics: diagnostics, contingencyAnalysis: contingencyAnalysis,
    solveLinear: solveLinear, isFiniteNumber: isFiniteNumber, clamp: clamp,
    exportBusCSV: exportBusCSV, exportBranchCSV: exportBranchCSV,
    exportConvergenceCSV: exportConvergenceCSV, exportExperimentJSON: exportExperimentJSON,
    csvField: csvField,
    // Underscored internals are exposed for the numerical test suite only;
    // they are not part of the workbench's documented API surface.
    _internals: {
      buildJacobian: buildJacobian, newtonCore: newtonCore,
      mismatchFor: mismatchFor, branchFlows: branchFlows
    }
  };
  return api;
});
