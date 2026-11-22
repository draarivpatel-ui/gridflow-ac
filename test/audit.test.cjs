/**
 * Deterministic audit report tests: FNV-1a/SHA-256 checksums, ranked N-1
 * CSV, audit JSON structure and the in-page self-test battery.
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/gridflow.cjs');

const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${a} within ${eps} of ${b}`);

describe('utf8Bytes encoding', () => {
  test('ASCII maps one byte per character', () => {
    assert.deepEqual(G.utf8Bytes('abc'), [97, 98, 99]);
    assert.deepEqual(G.utf8Bytes(''), []);
  });

  test('two and three byte sequences are correct', () => {
    assert.deepEqual(G.utf8Bytes('é'), [0xc3, 0xa9]);
    assert.deepEqual(G.utf8Bytes('€'), [0xe2, 0x82, 0xac]);
  });

  test('surrogate pairs encode as four bytes', () => {
    assert.deepEqual(G.utf8Bytes('😀'), [0xf0, 0x9f, 0x98, 0x80]);
  });

  test('a lone surrogate encodes the replacement character', () => {
    assert.deepEqual(G.utf8Bytes('\ud800'), [0xef, 0xbf, 0xbd]);
    assert.deepEqual(G.utf8Bytes('\udfff'), [0xef, 0xbf, 0xbd]);
  });
});

describe('fnv1a64', () => {
  test('matches the published FNV-1a 64 vectors', () => {
    assert.equal(G.fnv1a64(''), 'cbf29ce484222325');
    assert.equal(G.fnv1a64('a'), 'af63dc4c8601ec8c');
    assert.equal(G.fnv1a64('abc'), 'e71fa2190541574b');
    assert.equal(G.fnv1a64('foobar'), '85944171f73967e8');
  });

  test('is sensitive to single-character changes and stable under repeat', () => {
    assert.notEqual(G.fnv1a64('gridflow-a'), G.fnv1a64('gridflow-b'));
    assert.equal(G.fnv1a64('gridflow-ac'), G.fnv1a64('gridflow-ac'));
    assert.match(G.fnv1a64('x'), /^[0-9a-f]{16}$/);
  });
});

describe('sha256', () => {
  test('matches the published SHA-256 vectors', () => {
    assert.equal(G.sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(G.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(G.sha256('The quick brown fox jumps over the lazy dog'),
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
    assert.equal(G.sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  test('handles multi-block and unicode inputs', () => {
    const long = 'gridflow-ac-'.repeat(40);
    assert.match(G.sha256(long), /^[0-9a-f]{64}$/);
    assert.match(G.sha256('büs € 😀'), /^[0-9a-f]{64}$/);
    assert.notEqual(G.sha256('a'.repeat(64)), G.sha256('a'.repeat(65)));
  });
});

describe('exportContingencyCSV', () => {
  const scan = G.securityScan(G.getPreset('ieee5'));

  test('emits a header plus one row per screened outage in ranked order', () => {
    const rows = G.exportContingencyCSV(scan).trim().split('\n');
    assert.equal(rows.length, scan.screened + 1);
    assert.equal(rows[0], 'outage,rank,severity,converged,reason,max_loading_fraction,overloaded_branches,voltage_violation_buses,min_voltage_pu,max_voltage_pu,iterations');
    const ranked = scan.ranked.map(r => r.outage);
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].split(',')[0], ranked[i - 1]);
  });

  test('converged rows carry finite numeric fields', () => {
    const rows = G.exportContingencyCSV(G.securityScan(G.getPreset('ieee5'))).trim().split('\n');
    for (let i = 1; i < rows.length; i++) {
      const f = rows[i].split(',');
      assert.equal(f.length, 11);
      assert.ok(Number.isFinite(Number(f[2])), 'severity');
      assert.equal(f[3], 'true');
      assert.ok(Number.isFinite(Number(f[5])), 'loading');
      assert.ok(Number.isFinite(Number(f[8])), 'minV');
    }
  });

  test('failed rows stay honest: blanks for metrics, real reason string', () => {
    const rows = G.exportContingencyCSV(G.securityScan(G.getPreset('radial'))).trim().split('\n');
    let fails = 0;
    for (let i = 1; i < rows.length; i++) {
      const f = rows[i].split(',');
      if (f[3] === 'false') {
        fails++;
        assert.equal(f[5], '', 'no fabricated loading');
        assert.equal(f[8], '', 'no fabricated minV');
        assert.ok(f[4].length > 0, 'reason recorded');
      }
    }
    assert.ok(fails >= 1);
  });

  test('adversarial ids are CSV-quoted and formula-guarded', () => {
    const net = {
      buses: [{ id: '=EVIL', type: 'slack', vm: 1 }, { id: 'L2', type: 'pq', pd: 0.2, qd: 0.1 }, { id: 'L3', type: 'pq', pd: 0.1, qd: 0.05 }],
      branches: [{ id: 'T,"x"', from: 0, to: 1, r: 0.02, x: 0.1 }, { id: 'T2', from: 1, to: 2, r: 0.02, x: 0.1 }],
      baseMVA: 100
    };
    const csv = G.exportContingencyCSV(G.securityScan(net));
    assert.match(csv, /"T,""x"""/);
    assert.doesNotMatch(csv, /NaN|Infinity/);
  });

  test('no NaN or Infinity tokens leak into the CSV', () => {
    for (const name of G.presetNames()) {
      const csv = G.exportContingencyCSV(G.securityScan(G.getPreset(name)));
      assert.doesNotMatch(csv, /NaN|Infinity|undefined/, name);
    }
  });
});

describe('buildAudit and exportAuditJSON', () => {
  const sol = G.solveAC(G.getPreset('ieee5'));
  const scan = G.securityScan(G.getPreset('ieee5'));
  const der = G.solveWithDER(G.getPreset('ieee5'), { bus: 4, pSolar: 0.2, pBess: 0.3, qCap: 0.5, qGain: 8 });

  test('the report carries operating point, buses, branches and security blocks', () => {
    const a = G.buildAudit({ solution: sol, scan, derResult: der, preset: 'ieee5', loadFactor: 1 });
    assert.equal(a.schemaVersion, 1);
    assert.equal(a.generator, 'gridflow-ac');
    assert.equal(a.kind, 'n1-security-audit');
    assert.equal(a.operatingPoint.converged, true);
    assert.equal(a.buses.length, 5);
    assert.equal(a.branches.length, 7);
    assert.equal(a.security.screened, 7);
    assert.equal(a.security.results.length, 7);
    assert.equal(a.der.bus, 4);
    assert.ok(a.der.qEffective);
  });

  test('checksums are deterministic for an identical input state', () => {
    const a = G.buildAudit({ solution: sol, scan, derResult: der, preset: 'ieee5', loadFactor: 1 });
    const b = G.buildAudit({ solution: sol, scan, derResult: der, preset: 'ieee5', loadFactor: 1 });
    assert.equal(a.checksums.fnv1a64, b.checksums.fnv1a64);
    assert.equal(a.checksums.sha256, b.checksums.sha256);
    assert.match(a.checksums.sha256, /^[0-9a-f]{64}$/);
    assert.match(a.checksums.fnv1a64, /^[0-9a-f]{16}$/);
  });

  test('the recorded checksums match a fresh hash of the payload', () => {
    const a = G.buildAudit({ solution: sol, scan, preset: 'ieee5', loadFactor: 1 });
    const body = JSON.parse(JSON.stringify(a));
    const sums = body.checksums;
    delete body.checksums;
    const payload = JSON.stringify(body);
    assert.equal(G.fnv1a64(payload), sums.fnv1a64);
    assert.equal(G.sha256(payload), sums.sha256);
  });

  test('the digest changes when the operating point changes', () => {
    const a = G.buildAudit({ solution: sol, scan, preset: 'ieee5', loadFactor: 1 });
    const other = G.solveAC(G.scaleLoad(G.getPreset('ieee5'), 1.2));
    const b = G.buildAudit({ solution: other, scan, preset: 'ieee5', loadFactor: 1.2 });
    assert.notEqual(a.checksums.sha256, b.checksums.sha256);
    assert.notEqual(a.checksums.fnv1a64, b.checksums.fnv1a64);
  });

  test('a missing scan and missing DER serialize as null, not errors', () => {
    const a = G.buildAudit({ solution: sol, preset: 'ieee5' });
    assert.equal(a.security, null);
    assert.equal(a.der, null);
    assert.ok(a.checksums.sha256.length === 64);
  });

  test('a failed solve audits honestly: null metrics, empty rows', () => {
    const failed = G.solveAC(G.getPreset('collapse'));
    const a = G.buildAudit({ solution: failed, preset: 'collapse' });
    assert.equal(a.operatingPoint.converged, false);
    assert.equal(a.operatingPoint.totalGeneration, null);
    assert.deepEqual(a.buses, []);
    assert.deepEqual(a.branches, []);
    assert.ok(a.checksums.sha256.length === 64);
  });

  test('exportAuditJSON is valid JSON, newline-terminated, and finite', () => {
    const text = G.exportAuditJSON({ solution: sol, scan, derResult: der, preset: 'ieee5', loadFactor: 1 });
    assert.ok(text.endsWith('\n'));
    const obj = JSON.parse(text);
    assert.equal(obj.schemaVersion, 1);
    assert.doesNotMatch(text, /NaN|Infinity|undefined/);
    assert.equal(obj.security.results.length, 7);
    assert.equal(obj.security.band.low, 0.95);
    assert.equal(obj.security.band.high, 1.05);
  });

  test('exportAuditJSON is byte-identical for identical inputs', () => {
    const x = G.exportAuditJSON({ solution: sol, scan, preset: 'ieee5', loadFactor: 1 });
    const y = G.exportAuditJSON({ solution: sol, scan, preset: 'ieee5', loadFactor: 1 });
    assert.equal(x, y);
  });
});

describe('selfTestSuite', () => {
  test('returns six named checks that all pass', () => {
    const list = G.selfTestSuite();
    assert.equal(list.length, 6);
    for (const t of list) {
      assert.ok(t.id && t.name, 'entry needs id and name');
      assert.equal(typeof t.pass, 'boolean');
      assert.ok(typeof t.detail === 'string' && t.detail.length > 0);
      assert.equal(t.pass, true, t.id + ' failed: ' + t.detail);
    }
  });

  test('check ids are the documented battery', () => {
    const ids = G.selfTestSuite().map(t => t.id);
    assert.deepEqual(ids, ['balance', 'n1-determinism', 'volt-var', 'checksum', 'n1-honesty', 'overload']);
  });

  test('the suite is deterministic across runs', () => {
    const a = G.selfTestSuite().map(t => t.id + ':' + t.pass + ':' + t.detail).join('|');
    const b = G.selfTestSuite().map(t => t.id + ':' + t.pass + ':' + t.detail).join('|');
    assert.equal(a, b);
  });

  test('details carry real numbers from the solver', () => {
    const list = G.selfTestSuite();
    const bal = list.find(t => t.id === 'balance');
    assert.match(bal.detail, /e-\d+ pu/);
    const vv = list.find(t => t.id === 'volt-var');
    assert.match(vv.detail, /min \|V\| 0\.\d+ -> 0\.\d+ pu/);
  });
});
