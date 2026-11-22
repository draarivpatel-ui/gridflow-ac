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

  /* ---------------------------------------------------------------------- */
  /* N-1 security scanner                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Full N-1 security assessment. Every in-service branch is tripped in
   * turn and the network re-solved with the damped Newton-Raphson solver.
   * Each contingency is scored for bus voltage violations against a fixed
   * secure band (default 0.95 to 1.05 pu), thermal overloads against the
   * branch MVA rating, and honest non-convergence (voltage collapse or
   * islanding). Results carry a deterministic severity and a rank so the
   * worst single points of failure sort to the top.
   *
   * options: {vLow, vHigh, tolerance, maxIter, enforceQLimits, der}
   * When options.der is set, each contingency is re-solved through
   * solveWithDER so the scanner measures the post-DER secure state.
   */
  function securityScan(rawNetwork, options) {
    var opts = options || {};
    var vLow = isFiniteNumber(opts.vLow) ? opts.vLow : 0.95;
    var vHigh = isFiniteNumber(opts.vHigh) ? opts.vHigh : 1.05;
    if (!(vLow < vHigh)) throw new RangeError('security band requires vLow < vHigh');
    var solverOpts = { tolerance: opts.tolerance, maxIter: opts.maxIter, enforceQLimits: opts.enforceQLimits };
    var network = normalizeNetwork(rawNetwork);
    var results = [];
    for (var k = 0; k < network.branches.length; k++) {
      if (isOutOfService(network.branches[k])) continue;
      var copy = {
        buses: network.buses.map(function (b) { return Object.assign({}, b); }),
        branches: network.branches.map(function (b) { return Object.assign({}, b); }),
        baseMVA: network.baseMVA
      };
      copy.branches[k].status = 0;
      var sol = opts.der ? solveWithDER(copy, opts.der, solverOpts).solution : solveAC(copy, solverOpts);
      var d = sol.converged ? diagnostics(sol) : null;
      var violated = [], overloadedBranches = [], maxLoading = 0, minV = null, maxV = null;
      if (d) {
        maxLoading = d.maxLoading;
        minV = d.minVoltage; maxV = d.maxVoltage;
        for (var i = 0; i < sol.network.buses.length; i++) {
          if (sol.vm[i] < vLow || sol.vm[i] > vHigh) violated.push(sol.network.buses[i].id);
        }
        for (var f = 0; f < d.flows.length; f++) {
          if (d.flows[f].status && d.flows[f].loading > 1) overloadedBranches.push(d.flows[f].id);
        }
      }
      /* Deterministic severity: collapse dominates, then each overload and
         each violated bus adds, scaled by how far the worst excursion sits
         outside the secure band. Ties fall back to the branch id below. */
      var severity = sol.converged
        ? overloadedBranches.length * 40 + Math.max(0, maxLoading - 1) * 200
          + violated.length * 30
          + Math.max(0, vLow - minV) * 400 + Math.max(0, maxV - vHigh) * 400
        : 1000;
      results.push({
        outage: network.branches[k].id, branchIndex: k,
        converged: sol.converged, reason: sol.reason,
        severity: severity, rank: 0,
        maxLoading: d ? maxLoading : null,
        overloaded: d ? overloadedBranches.length : null,
        overloadedBranches: overloadedBranches,
        voltageViolations: d ? violated.length : null,
        violatedBuses: violated,
        minVoltage: minV, maxVoltage: maxV,
        iterations: sol.iterations
      });
    }
    /* Deterministic total order: severity descending, outage id ascending.
       The rank is assigned on the sorted copy and written back onto the
       branch-order result rows. */
    var ranked = results.slice().sort(function (a, b) {
      if (b.severity !== a.severity) return b.severity - a.severity;
      return a.outage < b.outage ? -1 : a.outage > b.outage ? 1 : 0;
    });
    for (var r = 0; r < ranked.length; r++) ranked[r].rank = r + 1;
    var secure = results.every(function (x) {
      return x.converged && x.voltageViolations === 0 && x.overloaded === 0;
    });
    return {
      band: { low: vLow, high: vHigh },
      screened: results.length,
      nonConverged: results.filter(function (x) { return !x.converged; }).length,
      withOverloads: results.filter(function (x) { return x.overloaded > 0; }).length,
      withVoltageViolations: results.filter(function (x) { return x.voltageViolations > 0; }).length,
      secure: secure,
      critical: ranked.length ? ranked[0].outage : null,
      results: results, ranked: ranked
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Solar PV + BESS Volt-VAR support                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Validate and normalize a distributed energy resource spec.
   * der: {bus, pSolar, pBess, qCap, vRef, deadband, qGain}
   *   bus: index of the host bus. P support is added to any non-slack bus;
   *   inverter Volt-VAR Q support only acts on PQ buses, where the scheduled
   *   reactive injection is a real degree of freedom.
   *   pSolar / pBess: real injection added at the bus in pu (pBess > 0 is
   *   battery discharge, pBess < 0 is charging).
   *   qCap: inverter apparent reactive headroom in pu (symmetric limit).
   *   vRef, deadband, qGain: Volt-VAR droop curve parameters. Within
   *   vRef +/- deadband the inverter holds Q at zero; outside, Q grows
   *   linearly with the deviation at qGain pu per pu and saturates at qCap.
   */
  function normalizeDER(raw) {
    if (!raw || typeof raw !== 'object') throw new RangeError('der spec required');
    var num = function (v, fb) { return Number(v == null ? fb : v); };
    var der = {
      bus: Number(raw.bus),
      pSolar: num(raw.pSolar, 0), pBess: num(raw.pBess, 0),
      qCap: num(raw.qCap, 0.5),
      vRef: num(raw.vRef, 1.0),
      deadband: num(raw.deadband, 0.005),
      qGain: num(raw.qGain, 6)
    };
    if (!Number.isInteger(der.bus) || der.bus < 0) throw new RangeError('der bus must be a nonnegative index');
    for (var key of ['pSolar', 'pBess', 'qCap', 'vRef', 'deadband', 'qGain']) {
      if (!isFiniteNumber(der[key])) throw new RangeError('nonfinite der ' + key);
    }
    if (der.qCap < 0) throw new RangeError('der qCap must be nonnegative');
    if (der.deadband < 0) throw new RangeError('der deadband must be nonnegative');
    if (der.qGain < 0) throw new RangeError('der qGain must be nonnegative');
    if (der.vRef <= 0) throw new RangeError('der vRef must be positive');
    return der;
  }

  /** IEEE-1547-style Volt-VAR droop: zero inside the deadband, linear outside. */
  function droopQ(v, der) {
    var dv = v - der.vRef;
    if (Math.abs(dv) <= der.deadband + 1e-12) return 0;
    var q = -der.qGain * (dv - (dv > 0 ? der.deadband : -der.deadband));
    return Math.abs(q) < 1e-12 ? 0 : clamp(q, -der.qCap, der.qCap);
  }

  /**
   * Solve the AC flow with a Solar PV + battery resource on one bus.
   * Real injection is added directly to the host bus schedule. Reactive
   * support is implicit: the droop law depends on the solved voltage, which
   * in turn depends on the injected Q. The equilibrium satisfies
   * h(q) = droopQ(v(q)) - q = 0. Because the droop is non-increasing in v
   * and v is non-decreasing in the capacitive Q applied, h is strictly
   * decreasing in q, so a deterministic bisection on [-qCap, +qCap] finds
   * the unique fixed point where a naive Q-chasing iteration would
   * oscillate around the steep droop slope.
   */
  function solveWithDER(rawNetwork, derRaw, options) {
    var network = normalizeNetwork(rawNetwork);
    var der = normalizeDER(derRaw);
    var n = network.buses.length;
    if (der.bus >= n) throw new RangeError('der bus index ' + der.bus + ' out of range');
    var bus = network.buses[der.bus];
    if (bus.type === 'slack') throw new RangeError('der cannot sit on the slack bus');
    var basePg = bus.pg, baseQg = bus.qg;
    bus.pg = basePg + der.pSolar + der.pBess;
    var qCapable = bus.type === 'pq';
    var responses = [];
    var solveAt = function (q) {
      if (qCapable) bus.qg = baseQg + q;
      var s = solveAC(network, options);
      responses.push({ iteration: responses.length + 1, voltage: s.vm[der.bus], qApplied: q, converged: s.converged });
      return s;
    };
    var sol = solveAt(0), appliedQ = 0, settled = false;
    if (sol.converged && qCapable) {
      var h = function (qq, s) { return droopQ(s.vm[der.bus], der) - qq; };
      var h0 = h(0, sol);
      if (Math.abs(h0) < 1e-7) settled = true;
      else {
        var lo = -der.qCap, hi = der.qCap;
        for (var it = 0; it < 32; it++) {
          var mid = (lo + hi) / 2;
          var sMid = solveAt(mid);
          sol = sMid; appliedQ = mid;
          if (!sMid.converged) break;
          var hm = h(mid, sMid);
          if (Math.abs(hm) < 1e-7 || (hi - lo) < 1e-9) { settled = true; break; }
          if (hm > 0) lo = mid; else hi = mid;
        }
      }
    } else if (sol.converged) settled = true;
    bus.qg = baseQg; bus.pg = basePg;
    if (!qCapable) appliedQ = 0;
    return {
      solution: sol, der: der, busId: bus.id,
      qSupport: appliedQ, qEffective: qCapable,
      settled: settled, responses: responses, iterations: responses.length
    };
  }

  /**
   * Compare a base-case solve with a DER-assisted solve.
   * metrics: voltage floor recovery, band violations and overloads removed,
   * loss change, plus labeled energy estimates: peakShavedMWh = injected
   * power sustained for meta.durationH hours (default 4), co2eDisplacedT =
   * peakShavedMWh * meta.emissionTPerMWh (default 0.4 t per MWh). These are
   * scenario estimates, not metered quantities.
   */
  function derImpact(baseSolution, derResult, meta) {
    var m = meta || {};
    var durationH = isFiniteNumber(m.durationH) && m.durationH >= 0 ? m.durationH : 4;
    var ef = isFiniteNumber(m.emissionTPerMWh) && m.emissionTPerMWh >= 0 ? m.emissionTPerMWh : 0.4;
    var vLow = isFiniteNumber(m.vLow) ? m.vLow : 0.95;
    var vHigh = isFiniteNumber(m.vHigh) ? m.vHigh : 1.05;
    var countViol = function (sol) {
      if (!sol || !sol.converged) return null;
      var c = 0;
      for (var i = 0; i < sol.vm.length; i++) if (sol.vm[i] < vLow || sol.vm[i] > vHigh) c++;
      return c;
    };
    var sol = derResult ? derResult.solution : null;
    var bd = baseSolution && baseSolution.converged ? diagnostics(baseSolution) : null;
    var ad = sol && sol.converged ? diagnostics(sol) : null;
    var minBefore = bd ? bd.minVoltage : (baseSolution ? Math.min.apply(null, Array.from(baseSolution.vm)) : null);
    var minAfter = ad ? ad.minVoltage : (sol ? Math.min.apply(null, Array.from(sol.vm)) : null);
    var injected = derResult ? Math.max(0, derResult.der.pSolar + derResult.der.pBess) : 0;
    var peakMW = injected;
    return {
      converged: !!(sol && sol.converged),
      minVoltageBefore: minBefore, minVoltageAfter: minAfter,
      voltageRecovery: minBefore != null && minAfter != null ? minAfter - minBefore : null,
      violationsBefore: countViol(baseSolution), violationsAfter: countViol(sol),
      overloadsBefore: bd ? bd.overloaded.length : null,
      overloadsAfter: ad ? ad.overloaded.length : null,
      lossChange: bd && ad ? ad.totalLoss - bd.totalLoss : null,
      qSupport: derResult ? derResult.qSupport : 0,
      injectedPowerMW: peakMW * ((derResult && derResult.solution ? derResult.solution.network.baseMVA : 100)),
      peakShavedMWh: peakMW * ((derResult && derResult.solution ? derResult.solution.network.baseMVA : 100)) * durationH,
      co2eDisplacedT: peakMW * ((derResult && derResult.solution ? derResult.solution.network.baseMVA : 100)) * durationH * ef,
      durationH: durationH, emissionTPerMWh: ef
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Deterministic checksums                                                 */
  /* ---------------------------------------------------------------------- */

  /** UTF-8 encode a JS string into a byte array (BMP + surrogate pairs). */
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else if (c >= 0xd800 && c <= 0xdbff) {
        var c2 = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          i++;
        } else out.push(0xef, 0xbf, 0xbd);
      } else if (c >= 0xdc00 && c <= 0xdfff) out.push(0xef, 0xbf, 0xbd);
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  /** FNV-1a 64-bit hash of a string, as 16 lowercase hex characters. */
  function fnv1a64(str) {
    var bytes = utf8Bytes(str);
    var h = 0xcbf29ce484222325n;
    var prime = 0x100000001b3n, mask = 0xffffffffffffffffn;
    for (var i = 0; i < bytes.length; i++) {
      h ^= BigInt(bytes[i]);
      h = (h * prime) & mask;
    }
    var s = h.toString(16);
    return '0000000000000000'.slice(s.length) + s;
  }

  /**
   * SHA-256 of a string as 64 lowercase hex characters. Pure arithmetic
   * implementation so the audit digest is identical in Node and in the
   * browser, with no async dependency and no external library.
   */
  function sha256(str) {
    var K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var bytes = utf8Bytes(str);
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    for (var q = 3; q >= 0; q--) bytes.push((hi >>> (q * 8)) & 0xff);
    for (var q2 = 3; q2 >= 0; q2--) bytes.push((lo >>> (q2 * 8)) & 0xff);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Int32Array(64);
    var rotr = function (x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; };
    for (var off = 0; off < bytes.length; off += 64) {
      for (var t = 0; t < 16; t++) {
        w[t] = ((bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) |
          (bytes[off + t * 4 + 2] << 8) | bytes[off + t * 4 + 3]) | 0;
      }
      for (var t2 = 16; t2 < 64; t2++) {
        var s0 = (rotr(w[t2 - 15], 7) ^ rotr(w[t2 - 15], 18) ^ (w[t2 - 15] >>> 3)) >>> 0;
        var s1 = (rotr(w[t2 - 2], 17) ^ rotr(w[t2 - 2], 19) ^ (w[t2 - 2] >>> 10)) >>> 0;
        w[t2] = (w[t2 - 16] + s0 + w[t2 - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], hh = H[7];
      for (var t3 = 0; t3 < 64; t3++) {
        var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var t1 = (hh + S1 + ch + K[t3] + w[t3]) | 0;
        var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var t2v = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2v) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + hh) | 0;
    }
    var out = '';
    for (var z = 0; z < 8; z++) {
      var hs = (H[z] >>> 0).toString(16);
      out += '00000000'.slice(hs.length) + hs;
    }
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Audit export and self tests                                             */
  /* ---------------------------------------------------------------------- */

  /** Ranked N-1 CSV from a securityScan result (or its results array). */
  function exportContingencyCSV(scan) {
    var results = Array.isArray(scan) ? scan : (scan && scan.ranked) || [];
    var rows = [['outage', 'rank', 'severity', 'converged', 'reason', 'max_loading_fraction',
      'overloaded_branches', 'voltage_violation_buses', 'min_voltage_pu', 'max_voltage_pu', 'iterations']];
    for (var r of results) {
      rows.push([r.outage, r.rank || '', numFixed(r.severity, 3), String(r.converged),
        r.reason || '', numFixed(r.maxLoading, 6),
        (r.overloadedBranches || []).join('|'), (r.violatedBuses || []).join('|'),
        numFixed(r.minVoltage, 6), numFixed(r.maxVoltage, 6), r.iterations == null ? '' : r.iterations]);
    }
    return rows.map(function (row) { return row.map(csvField).join(','); }).join('\n') + '\n';
  }

  /**
   * Build the deterministic audit report. The checksum covers the report
   * body only, so the same network state always produces the same digests;
   * no timestamps or random ids are included.
   */
  function buildAudit(input) {
    var sol = input.solution || null;
    var scan = input.scan || null;
    var der = input.derResult || null;
    var d = sol && sol.converged ? diagnostics(sol) : null;
    var body = {
      schemaVersion: 1,
      generator: 'gridflow-ac',
      kind: 'n1-security-audit',
      note: 'Synthetic benchmark network. Deterministic report: identical input state yields identical checksums.',
      preset: input.preset || 'custom',
      loadFactor: isFiniteNumber(input.loadFactor) ? input.loadFactor : 1,
      baseMVA: sol ? sol.network.baseMVA : (input.baseMVA || 100),
      operatingPoint: {
        converged: sol ? sol.converged : false,
        reason: sol ? sol.reason : 'no solution',
        iterations: sol ? sol.iterations : 0,
        mismatch: sol && isFiniteNumber(sol.mismatch) ? sol.mismatch : null,
        totalGeneration: d ? d.totalGeneration : null,
        totalLoad: d ? d.totalLoad : null,
        totalLoss: d ? d.totalLoss : null,
        balanceError: d ? d.balanceError : null,
        minVoltage: d ? d.minVoltage : null,
        maxVoltage: d ? d.maxVoltage : null,
        maxLoading: d ? d.maxLoading : null,
        overloaded: d ? d.overloaded : [],
        voltageViolations: d ? d.voltageViolations : []
      },
      buses: d ? sol.network.buses.map(function (b, i) {
        return { id: b.id, type: b.type, vm: sol.vm[i], va: sol.va[i],
          pd: b.pd, qd: b.qd, pg: b.type === 'slack' ? sol.slackGeneration.p : b.pg, qg: sol.qGeneration[i] };
      }) : [],
      branches: d ? d.flows.map(function (f) {
        return { id: f.id, from: f.from, to: f.to, status: f.status, pFrom: f.pFrom, qFrom: f.qFrom,
          pTo: f.pTo, qTo: f.qTo, lossP: f.lossP, loading: f.loading };
      }) : [],
      security: scan ? {
        band: scan.band, screened: scan.screened, nonConverged: scan.nonConverged,
        withOverloads: scan.withOverloads, withVoltageViolations: scan.withVoltageViolations,
        secure: scan.secure, critical: scan.critical,
        results: scan.ranked.map(function (r) {
          return { outage: r.outage, rank: r.rank, severity: r.severity, converged: r.converged,
            reason: r.reason, maxLoading: r.maxLoading, overloadedBranches: r.overloadedBranches,
            violatedBuses: r.violatedBuses, minVoltage: r.minVoltage, maxVoltage: r.maxVoltage };
        })
      } : null,
      der: der ? {
        bus: der.der.bus, busId: der.busId, pSolar: der.der.pSolar, pBess: der.der.pBess,
        qCap: der.der.qCap, vRef: der.der.vRef, deadband: der.der.deadband, qGain: der.der.qGain,
        qSupport: der.qSupport, qEffective: der.qEffective, settled: der.settled
      } : null
    };
    var payload = JSON.stringify(body);
    body.checksums = {
      algorithm: 'fnv1a-64,sha256',
      payload: 'compact-json',
      fnv1a64: fnv1a64(payload),
      sha256: sha256(payload)
    };
    return body;
  }

  /** Serialize the audit report to JSON. */
  function exportAuditJSON(input) {
    return JSON.stringify(buildAudit(input), null, 2) + '\n';
  }

  /**
   * In-page verification battery. Each check exercises a real solver path
   * and reports a pass flag with a numeric detail. Deterministic: identical
   * engine build yields identical results on every run.
   */
  function selfTestSuite() {
    var out = [];
    // 1. Kirchhoff power balance on the meshed benchmark.
    var s = solveAC(getPreset('ieee5'));
    var d = s.converged ? diagnostics(s) : null;
    out.push({
      id: 'balance', name: 'Kirchhoff power balance',
      pass: !!(d && Math.abs(d.balanceError) < 1e-6),
      detail: d ? 'sum(Pgen) - sum(Pload) - Ploss = ' + d.balanceError.toExponential(2) + ' pu' : 'solve failed'
    });
    // 2. N-1 ranking determinism: two identical scans, identical ordering.
    var scanA = securityScan(getPreset('ieee5')), scanB = securityScan(getPreset('ieee5'));
    var sig = function (sc) { return sc.ranked.map(function (r) { return r.outage + '#' + r.rank; }).join(','); };
    out.push({
      id: 'n1-determinism', name: 'N-1 ranking determinism',
      pass: sig(scanA) === sig(scanB),
      detail: 'order ' + sig(scanA)
    });
    // 3. Volt-VAR droop stabilization on a sagging radial feeder.
    var sagNet = scaleLoad(getPreset('radial'), 1.3);
    var sag = solveAC(sagNet);
    var sagD = sag.converged ? diagnostics(sag) : null;
    var weak = 0, weakV = Infinity;
    if (sag.converged) {
      for (var wi = 0; wi < sag.network.buses.length; wi++) {
        if (sag.network.buses[wi].type === 'pq' && sag.vm[wi] < weakV) { weakV = sag.vm[wi]; weak = wi; }
      }
    }
    var fixed = sag.converged ? solveWithDER(sagNet, { bus: weak, pSolar: 0.1, pBess: 0.15, qCap: 0.6, qGain: 8, deadband: 0.005 }) : null;
    var fixedV = fixed && fixed.solution.converged ? Math.min.apply(null, Array.from(fixed.solution.vm)) : weakV;
    out.push({
      id: 'volt-var', name: 'Volt-VAR droop stabilization',
      pass: !!(fixed && fixed.solution.converged && fixedV > weakV + 1e-4),
      detail: 'min |V| ' + weakV.toFixed(4) + ' -> ' + fixedV.toFixed(4) + ' pu at ' + (sag.converged ? sag.network.buses[weak].id : '?')
    });
    // 4. Checksum vectors must match the published SHA-256 digests.
    var vec = sha256('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' &&
      sha256('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    out.push({
      id: 'checksum', name: 'Checksum correctness',
      pass: vec, detail: 'sha256(abc) = ' + sha256('abc').slice(0, 16) + '...'
    });
    // 5. N-1 honesty: a radial outage must be flagged non-convergent, never smoothed over.
    var radScan = securityScan(getPreset('radial'));
    var radBad = radScan.results.filter(function (r) { return !r.converged; }).length;
    out.push({
      id: 'n1-honesty', name: 'N-1 collapse honesty',
      pass: radBad >= 1 && radScan.nonConverged === radBad,
      detail: radBad + ' of ' + radScan.screened + ' radial outages fail to converge'
    });
    // 6. Overload detection on the stressed benchmark.
    var stress = solveAC(getPreset('stress'));
    var sd = stress.converged ? diagnostics(stress) : null;
    out.push({
      id: 'overload', name: 'Thermal overload detection',
      pass: !!(sd && sd.maxLoading > 1 && sd.overloaded.length >= 1),
      detail: sd ? 'max loading ' + (sd.maxLoading * 100).toFixed(1) + '% on ' + sd.overloaded.join(',') : 'solve failed'
    });
    return out;
  }

  var api = {
    BUS_TYPES: BUS_TYPES, PRESETS: PRESETS,
    presetNames: presetNames, getPreset: getPreset, scaleLoad: scaleLoad,
    normalizeDER: normalizeDER, droopQ: droopQ, solveWithDER: solveWithDER, derImpact: derImpact,
    securityScan: securityScan, fnv1a64: fnv1a64, sha256: sha256, utf8Bytes: utf8Bytes,
    exportContingencyCSV: exportContingencyCSV, buildAudit: buildAudit,
    exportAuditJSON: exportAuditJSON, selfTestSuite: selfTestSuite,
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
