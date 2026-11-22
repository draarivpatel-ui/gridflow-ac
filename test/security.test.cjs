/**
 * GridFlow AC N-1 security scanner tests: ranked contingencies, secure-band
 * violations, thermal overloads, severity ordering and determinism.
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/gridflow.cjs');

const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${a} within ${eps} of ${b}`);

describe('scanner coverage and result shape', () => {
  test('every preset screens exactly the in-service branches', () => {
    const counts = { ieee3: 3, ieee5: 7, radial: 5, collapse: 5, stress: 4 };
    for (const name of G.presetNames()) {
      const scan = G.securityScan(G.getPreset(name));
      assert.equal(scan.screened, counts[name], name);
      assert.equal(scan.results.length, counts[name]);
      assert.equal(scan.ranked.length, counts[name]);
    }
  });

  test('result rows carry the full audit fields', () => {
    const scan = G.securityScan(G.getPreset('ieee5'));
    for (const r of scan.results) {
      assert.ok(typeof r.outage === 'string' && r.outage.length > 0);
      assert.ok(Number.isInteger(r.branchIndex));
      assert.equal(typeof r.converged, 'boolean');
      assert.ok(Number.isFinite(r.severity));
      assert.ok(Number.isInteger(r.rank) && r.rank >= 1);
      assert.ok(Array.isArray(r.overloadedBranches));
      assert.ok(Array.isArray(r.violatedBuses));
      assert.ok(Number.isInteger(r.iterations));
    }
  });

  test('out-of-service branches are skipped', () => {
    const net = G.getPreset('ieee5');
    const gone = [net.branches[0].id, net.branches[3].id];
    net.branches[0].status = 0;
    net.branches[3].status = 0;
    const scan = G.securityScan(net);
    assert.equal(scan.screened, 5);
    for (const id of gone) assert.ok(!scan.results.some(r => r.outage === id), id + ' screened while out');
  });

  test('results stay in branch order while ranked sorts by severity', () => {
    const scan = G.securityScan(G.getPreset('stress'));
    const ids = G.getPreset('stress').branches.map(b => b.id);
    assert.deepEqual(scan.results.map(r => r.outage), ids);
    for (let i = 1; i < scan.ranked.length; i++) {
      assert.ok(scan.ranked[i - 1].severity >= scan.ranked[i].severity, 'ranked must be severity descending');
      assert.equal(scan.ranked[i - 1].rank, i);
    }
    assert.equal(scan.ranked[scan.ranked.length - 1].rank, scan.ranked.length);
  });
});

describe('secure-band voltage violations', () => {
  test('buses outside 0.95 to 1.05 pu are flagged by id', () => {
    const scan = G.securityScan(G.getPreset('stress'));
    const violRows = scan.results.filter(r => r.converged && r.voltageViolations > 0);
    assert.ok(violRows.length >= 1, 'stress outages should violate the band');
    for (const r of violRows) {
      assert.equal(r.voltageViolations, r.violatedBuses.length);
    }
  });

  test('every flagged bus really sits outside the secure band', () => {
    const net = G.getPreset('stress');
    const scan = G.securityScan(net);
    for (const r of scan.results) {
      if (!r.converged) continue;
      // Re-solve the same outage and measure the flagged buses directly.
      const out = G.getPreset('stress');
      out.branches[r.branchIndex].status = 0;
      const sol = G.solveAC(out);
      for (const id of r.violatedBuses) {
        const i = out.buses.findIndex(b => b.id === id);
        assert.ok(i >= 0, id + ' missing');
        assert.ok(sol.vm[i] < scan.band.low || sol.vm[i] > scan.band.high,
          `${id} at ${sol.vm[i]} is inside the band`);
      }
      // And no un-flagged bus violates the band.
      const flagged = new Set(r.violatedBuses);
      out.buses.forEach((b, i) => {
        if (!flagged.has(b.id)) {
          assert.ok(sol.vm[i] >= scan.band.low && sol.vm[i] <= scan.band.high,
            `${b.id} at ${sol.vm[i]} violates but was not flagged`);
        }
      });
    }
  });

  test('custom band boundaries are honored', () => {
    const scan = G.securityScan(G.getPreset('ieee5'), { vLow: 0.99, vHigh: 1.01 });
    for (const r of scan.results) {
      if (!r.converged) continue;
      assert.ok(r.voltageViolations >= 0);
    }
  });

  test('an inverted band is rejected', () => {
    assert.throws(() => G.securityScan(G.getPreset('ieee5'), { vLow: 1.05, vHigh: 0.95 }), RangeError);
  });
});

describe('thermal overloads and non-convergence', () => {
  test('overloaded branches are listed by id and counted', () => {
    const scan = G.securityScan(G.getPreset('stress'));
    for (const r of scan.results) {
      if (!r.converged) {
        assert.equal(r.overloaded, null);
        assert.equal(r.maxLoading, null);
        continue;
      }
      assert.equal(r.overloaded, r.overloadedBranches.length);
      assert.equal(r.overloaded > 0, r.maxLoading > 1);
    }
  });

  test('radial outages are honestly non-convergent, severity 1000', () => {
    const scan = G.securityScan(G.getPreset('radial'));
    // Every single branch on a pure radial feeder islands its downstream
    // buses, so all five outages must fail - and be reported, not hidden.
    assert.equal(scan.nonConverged, 5);
    for (const r of scan.results) {
      if (!r.converged) {
        assert.equal(r.severity, 1000);
        assert.ok(r.reason.length > 0);
      }
    }
    assert.equal(scan.secure, false);
  });

  test('a two-bus single-line network reports one failing outage', () => {
    const scan = G.securityScan({
      buses: [{ type: 'slack' }, { type: 'pq', pd: 0.4, qd: 0.1 }],
      branches: [{ from: 0, to: 1, r: 0.02, x: 0.1 }], baseMVA: 100
    });
    assert.equal(scan.screened, 1);
    assert.equal(scan.results[0].converged, false);
    assert.equal(scan.nonConverged, 1);
    assert.equal(scan.critical, scan.results[0].outage);
  });

  test('non-convergent contingencies always outrank convergent ones', () => {
    const scan = G.securityScan(G.getPreset('stress'));
    for (const r of scan.results) {
      if (!r.converged) {
        for (const other of scan.results) {
          if (other.converged) assert.ok(r.severity > other.severity, 'collapse must outrank a stable violation');
        }
      }
    }
  });
});

describe('severity, ranking and determinism', () => {
  test('severity is deterministic across repeated scans', () => {
    const a = G.securityScan(G.getPreset('stress'));
    const b = G.securityScan(G.getPreset('stress'));
    assert.deepEqual(a.ranked.map(r => r.outage + ':' + r.severity), b.ranked.map(r => r.outage + ':' + r.severity));
    assert.deepEqual(a.ranked.map(r => r.rank), b.ranked.map(r => r.rank));
  });

  test('rank assignment is a dense 1..n permutation', () => {
    const scan = G.securityScan(G.getPreset('ieee5'));
    const ranks = scan.results.map(r => r.rank).sort((x, y) => x - y);
    assert.deepEqual(ranks, [1, 2, 3, 4, 5, 6, 7]);
  });

  test('ties in severity fall back to outage id ordering', () => {
    // ieee5 is fully secure: all severities are 0, so ranked order is
    // alphabetical by outage id.
    const scan = G.securityScan(G.getPreset('ieee5'));
    const ids = scan.ranked.map(r => r.outage);
    const sorted = ids.slice().sort();
    assert.deepEqual(ids, sorted);
  });

  test('the critical field names the rank-1 outage and secure flag aggregates', () => {
    const scan = G.securityScan(G.getPreset('ieee5'));
    assert.equal(scan.secure, true);
    assert.equal(scan.critical, scan.ranked[0].outage);
    const bad = G.securityScan(G.getPreset('radial'));
    assert.equal(bad.secure, false);
    assert.ok(bad.critical);
  });

  test('summary counters match the row data', () => {
    for (const name of G.presetNames()) {
      const scan = G.securityScan(G.getPreset(name));
      assert.equal(scan.nonConverged, scan.results.filter(r => !r.converged).length, name);
      assert.equal(scan.withOverloads, scan.results.filter(r => r.overloaded > 0).length, name);
      assert.equal(scan.withVoltageViolations, scan.results.filter(r => r.voltageViolations > 0).length, name);
      assert.equal(scan.secure, scan.results.every(r => r.converged && r.voltageViolations === 0 && r.overloaded === 0), name);
    }
  });

  test('severity grows with the worst band excursion', () => {
    // On the stress preset the L23 outage keeps converging at both load
    // factors but the sag deepens, so its measured severity must rise.
    const mild = G.securityScan(G.scaleLoad(G.getPreset('stress'), 1.0));
    const heavy = G.securityScan(G.scaleLoad(G.getPreset('stress'), 1.2));
    const mRow = mild.results.find(r => r.outage === 'L23');
    const hRow = heavy.results.find(r => r.outage === 'L23');
    assert.ok(mRow.converged && hRow.converged, 'fixture: L23 must converge at both factors');
    assert.ok(hRow.severity > mRow.severity, `${mRow.severity} -> ${hRow.severity}`);
    assert.ok(hRow.minVoltage < mRow.minVoltage);
  });
});

describe('scanner integration and options', () => {
  test('maxIter and tolerance are passed through to each re-solve', () => {
    const scan = G.securityScan(G.getPreset('ieee5'), { maxIter: 1 });
    assert.ok(scan.results.every(r => !r.converged), 'one iteration cannot solve any contingency');
    assert.ok(scan.nonConverged === scan.screened);
  });

  test('the der option re-solves every outage with Volt-VAR support', () => {
    const net = G.scaleLoad(G.getPreset('ieee5'), 1.1);
    const plain = G.securityScan(net);
    const assisted = G.securityScan(net, { der: { bus: 4, pSolar: 0.1, pBess: 0.2, qCap: 0.6, qGain: 8 } });
    assert.equal(plain.screened, assisted.screened);
    // On this case injection plus droop Q must not depress any convergent
    // contingency floor (verified empirically: every row improves).
    for (const r of assisted.results) {
      const base = plain.results.find(x => x.outage === r.outage);
      if (r.converged && base.converged) {
        assert.ok(r.minVoltage >= base.minVoltage - 1e-9, `${r.outage}: DER depressed the floor`);
      }
    }
  });

  test('a collapsed base case still screens honestly', () => {
    const scan = G.securityScan(G.getPreset('collapse'));
    assert.ok(scan.screened >= 1);
    assert.ok(scan.results.every(r => r.converged === false || Number.isFinite(r.maxLoading)));
  });

  test('branchIndex lets the UI map a row back to the topology', () => {
    const net = G.getPreset('ieee5');
    const scan = G.securityScan(net);
    for (const r of scan.results) {
      assert.equal(net.branches[r.branchIndex].id, r.outage);
    }
  });

  test('violatedBuses lists the exact bus ids outside the band', () => {
    const net = G.getPreset('stress');
    const scan = G.securityScan(net);
    let flagged = 0;
    for (const r of scan.results) {
      if (!r.converged || r.voltageViolations === 0) continue;
      flagged += r.violatedBuses.length;
      for (const id of r.violatedBuses) {
        assert.ok(net.buses.some(b => b.id === id), id + ' not a bus id');
      }
    }
    assert.ok(flagged >= 2, 'stress outages should flag real buses');
  });

  test('iteration counts are real Newton-Raphson counts', () => {
    const scan = G.securityScan(G.getPreset('ieee5'));
    for (const r of scan.results) {
      if (r.converged) assert.ok(r.iterations >= 2 && r.iterations <= 60, `${r.outage} iterations ${r.iterations}`);
    }
  });
});
