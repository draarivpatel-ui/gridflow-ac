/* GridFlow AC controller. Uses the shared power-flow engine (window.GridFlow). */
'use strict';
(function () {
  const G = globalThis.GridFlow;
  const $ = id => document.getElementById(id);
  const RATIOS = { voltageCanvas: 230 / 720, loadingCanvas: 230 / 720, convergenceCanvas: 220 / 720 };

  const state = {
    preset: 'ieee5', loadFactor: 1, baseMVA: 100, tolerance: 1e-10, maxIter: 60,
    network: null, solution: null, diagnostics: null, contingency: null,
    scan: null, baseSolution: null, derResult: null, selfTests: null,
    der: { enabled: false, bus: 1, pSolar: 0.2, pBess: 0.3, qCap: 0.5, qGain: 8, deadband: 0.005, vRef: 1 },
    sortKey: 'rank', sortDir: 'asc', previewBranch: null, previewRow: null,
    selectedBus: 0, selectedBranch: 0,
    probe: { voltage: 0, loading: 0, convergence: 0 },
    lastExport: ''
  };

  let dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));

  function fmt(v, d = 4) { return Number.isFinite(v) ? Number(v).toFixed(d) : '--'; }
  function cssVar(name, fallback) {
    let v = '';
    if (globalThis.getComputedStyle) v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function updateExportAvailability() {
    const solutionReady = !!state.solution;
    for (const id of ['jsonBtn', 'busCsvBtn', 'branchCsvBtn', 'convergenceCsvBtn', 'auditJsonBtn']) $(id).disabled = !solutionReady;
    const scanReady = solutionReady && !!state.scan;
    $('contCsvBtn').disabled = !scanReady;
    $('auditCsvBtn').disabled = !scanReady;
  }

  function showError(msg) {
    const node = $('errorStatus');
    node.textContent = msg; node.hidden = !msg;
    updateExportAvailability();
  }

  function loadPreset(name) {
    state.preset = name;
    // Normalize the preset so every bus and branch has complete, editable
    // fields (including an explicit in-service status).
    const raw = G.getPreset(name);
    const p = G.normalizeNetwork(raw);
    p.label = raw.label; p.note = raw.note;
    state.network = p;
    state.network.baseMVA = state.baseMVA;
    state.loadFactor = 1;
    $('loadFactor').value = '1';
    $('presetNote').textContent = p.label + '. ' + p.note;
    rebuildSelectors();
    recompute();
  }

  function rebuildSelectors() {
    const busSel = $('busSelect'), branchSel = $('branchSelect');
    busSel.textContent = ''; branchSel.textContent = '';
    state.network.buses.forEach((b, i) => {
      const o = document.createElement('option'); o.value = String(i); o.textContent = `${b.id} (${b.type})`;
      busSel.appendChild(o);
    });
    state.network.branches.forEach((b, i) => {
      const o = document.createElement('option'); o.value = String(i); o.textContent = b.id;
      branchSel.appendChild(o);
    });
    state.selectedBus = Math.min(state.selectedBus, state.network.buses.length - 1);
    state.selectedBranch = Math.min(state.selectedBranch, state.network.branches.length - 1);
    busSel.value = String(state.selectedBus); branchSel.value = String(state.selectedBranch);
    // The DER host list holds PQ buses only: Volt-VAR support is meaningless
    // on the slack (P,Q computed) and redundant on a PV bus (voltage held).
    const derSel = $('derBus');
    derSel.textContent = '';
    const pqIdx = [];
    state.network.buses.forEach((b, i) => {
      if (b.type !== 'pq') return;
      pqIdx.push(i);
      const o = document.createElement('option'); o.value = String(i); o.textContent = `${b.id} (pq)`;
      derSel.appendChild(o);
    });
    if (!pqIdx.includes(state.der.bus)) state.der.bus = pqIdx.length ? pqIdx[pqIdx.length - 1] : 0;
    derSel.value = String(state.der.bus);
    syncEditor();
  }

  function syncEditor() {
    const b = state.network.buses[state.selectedBus];
    const br = state.network.branches[state.selectedBranch];
    $('busLoadP').value = String(b.pd); $('busLoadPOut').textContent = fmt(b.pd, 2);
    $('busLoadQ').value = String(b.qd); $('busLoadQOut').textContent = fmt(b.qd, 2);
    $('branchX').value = String(br.x); $('branchXOut').textContent = fmt(br.x, 2);
    $('branchRate').value = String(br.rateMVA); $('branchRateOut').textContent = String(br.rateMVA);
    $('branchStatus').checked = !!br.status;
    $('busLoadP').disabled = b.type === 'slack';
    $('busLoadQ').disabled = b.type === 'slack';
  }

  function readControls() {
    state.loadFactor = Number($('loadFactor').value);
    const parsedBase = Number($('baseMVA').value);
    state.baseMVA = Number.isFinite(parsedBase) && parsedBase >= 1 ? parsedBase : 100;
    state.tolerance = Number($('tolerance').value);
    state.maxIter = Number($('maxIter').value);
    state.der.enabled = $('derEnable').checked;
    const parsedDerBus = Number($('derBus').value);
    if (Number.isInteger(parsedDerBus) && parsedDerBus >= 0 && parsedDerBus < state.network.buses.length) state.der.bus = parsedDerBus;
    state.der.pSolar = Number($('derSolar').value);
    state.der.pBess = Number($('derBess').value);
    state.der.qCap = Number($('derQCap').value);
    state.der.qGain = Number($('derGain').value);
    state.der.deadband = Number($('derDeadband').value);
  }

  function derSpec() {
    const d = state.der;
    return { bus: d.bus, pSolar: d.pSolar, pBess: d.pBess, qCap: d.qCap, qGain: d.qGain, deadband: d.deadband, vRef: d.vRef };
  }

  function effectiveNetwork() {
    // scaleLoad applies the load factor on top of the edited base network.
    return G.scaleLoad(state.network, state.loadFactor);
  }

  function recompute() {
    try {
      readControls();
      const net = effectiveNetwork();
      net.baseMVA = state.baseMVA;
      let solution;
      if (state.der.enabled) {
        // The unassisted solve is kept alongside so the impact panel can
        // quantify what the DER actually bought: voltage floor recovered,
        // violations cleared, energy shaved.
        state.baseSolution = G.solveAC(net, { tolerance: state.tolerance, maxIter: state.maxIter });
        state.derResult = G.solveWithDER(net, derSpec(), { tolerance: state.tolerance, maxIter: state.maxIter });
        solution = state.derResult.solution;
      } else {
        state.baseSolution = null;
        state.derResult = null;
        solution = G.solveAC(net, { tolerance: state.tolerance, maxIter: state.maxIter });
      }
      state.network.baseMVA = state.baseMVA;
      state.solution = solution;
      state.diagnostics = G.diagnostics(solution);
      state.contingency = null;
      state.scan = null;
      state.previewBranch = null;
      state.previewRow = null;
      syncLabels();
      redraw();
      updateDiagnostics();
      updateTables();
      updateDERPanel();
      resetContingencyTable();
      showError('');
      const qNote = solution.qLimited && solution.qLimited.length
        ? ' | Q-limited: ' + solution.qLimited.map(q => q.id + '@' + q.bound).join(', ')
        : '';
      const derNote = state.der.enabled && state.derResult
        ? ` | DER @${state.derResult.busId}: +${fmt(state.der.pSolar + state.der.pBess, 2)} pu P, Q support ${fmt(state.derResult.qSupport, 3)} pu`
        : '';
      $('statusLine').textContent = solution.converged
        ? `${G.getPreset(state.preset).label} | load ${fmt(state.loadFactor, 2)}x | ${solution.network.buses.length} buses, ${solution.network.branches.length} branches | ${solution.iterations} Newton iterations | max mismatch ${solution.mismatch.toExponential(2)} pu${qNote}${derNote}`
        : `NON-CONVERGED: ${solution.reason} | last mismatch ${solution.mismatch.toExponential(2)} pu | charts and table show the last Newton iterate, not a valid operating point`;
      $('statusLine').classList.toggle('warn', !solution.converged);
      $('footerStatus').textContent = solution.converged ? 'Solved locally, no network requests' : 'Solve failed: ' + solution.reason;
    } catch (err) {
      state.solution = null; state.diagnostics = null; state.contingency = null;
      state.scan = null; state.previewBranch = null; state.previewRow = null;
      state.baseSolution = null; state.derResult = null;
      updateDERPanel();
      for (const id of ['statIters', 'statMismatch', 'statGen', 'statLoad', 'statLoss', 'statBalance', 'statLoading']) $(id).textContent = '--';
      $('statSolver').textContent = 'ERROR'; $('statSolver').className = 'warn';
      resetContingencyTable();
      showError('Computation failed: ' + err.message);
      $('statusLine').textContent = 'Invalid network: ' + err.message;
      $('statusLine').classList.add('warn');
      $('footerStatus').textContent = 'Solve failed: ' + err.message;
    }
  }

  function syncLabels() {
    $('loadFactorOut').textContent = fmt(state.loadFactor, 2) + 'x';
    $('maxIterOut').textContent = String(state.maxIter);
    $('busLoadPOut').textContent = fmt(state.network.buses[state.selectedBus].pd, 2);
    $('busLoadQOut').textContent = fmt(state.network.buses[state.selectedBus].qd, 2);
    $('branchXOut').textContent = fmt(state.network.branches[state.selectedBranch].x, 2);
    $('branchRateOut').textContent = String(state.network.branches[state.selectedBranch].rateMVA);
    $('derSolarOut').textContent = fmt(state.der.pSolar, 2);
    $('derBessOut').textContent = fmt(state.der.pBess, 2);
    $('derQCapOut').textContent = fmt(state.der.qCap, 2);
    $('derGainOut').textContent = fmt(state.der.qGain, 1);
    $('derDeadbandOut').textContent = fmt(state.der.deadband, 3);
  }

  function updateDERPanel() {
    const off = !state.der.enabled || !state.derResult;
    for (const id of ['derVBefore', 'derVAfter', 'derVCleared', 'derQ', 'derMWh', 'derCO2']) {
      $(id).textContent = '--'; $(id).className = '';
    }
    if (off) {
      $('derReadout').textContent = state.der.enabled
        ? 'DER enabled but the solve did not produce a usable state.'
        : 'Enable DER to compute impact against the unassisted solve.';
      return;
    }
    const r = state.derResult, base = state.baseSolution;
    const imp = G.derImpact(base, r, { vLow: 0.95, vHigh: 1.05 });
    $('derVBefore').textContent = imp.minVoltageBefore == null ? '--' : fmt(imp.minVoltageBefore, 4) + ' pu';
    $('derVAfter').textContent = imp.minVoltageAfter == null ? '--' : fmt(imp.minVoltageAfter, 4) + ' pu';
    $('derVAfter').className = imp.voltageRecovery != null && imp.voltageRecovery > 0 ? 'ok' : '';
    const cleared = imp.violationsBefore != null && imp.violationsAfter != null ? imp.violationsBefore - imp.violationsAfter : null;
    $('derVCleared').textContent = cleared == null ? '--' : String(cleared);
    $('derVCleared').className = cleared != null && cleared > 0 ? 'ok' : '';
    $('derQ').textContent = r.qEffective ? fmt(r.qSupport, 3) + ' pu' : '0 (PV bus)';
    $('derMWh').textContent = fmt(imp.peakShavedMWh, 1) + ' MWh';
    $('derCO2').textContent = fmt(imp.co2eDisplacedT, 1) + ' t';
    const convNote = r.solution && r.solution.converged ? '' : ' | DER solve did not converge';
    $('derReadout').textContent =
      `DER @${r.busId}: solar ${fmt(state.der.pSolar, 2)} pu + battery ${fmt(state.der.pBess, 2)} pu discharge` +
      ` | droop ${fmt(state.der.qGain, 1)} Q/V beyond +/-${fmt(state.der.deadband, 3)} pu, cap ${fmt(state.der.qCap, 2)} pu` +
      ` | fixed-point ${r.settled ? 'settled in ' + r.iterations + ' solve(s)' : 'did not settle'}${convNote}` +
      ` | estimates: ${fmt(imp.durationH, 0)} h peak window, ${fmt(imp.emissionTPerMWh, 2)} t/MWh`;
  }

  function updateDiagnostics() {
    const s = state.solution, d = state.diagnostics;
    $('statSolver').textContent = s.converged ? 'CONVERGED' : 'NO SOLUTION';
    $('statSolver').className = s.converged ? 'ok' : 'warn';
    $('statIters').textContent = String(s.iterations);
    $('statMismatch').textContent = s.mismatch.toExponential(2);
    $('statGen').textContent = d ? fmt(d.totalGeneration * state.baseMVA, 1) + ' MW' : '--';
    $('statLoad').textContent = d ? fmt(d.totalLoad * state.baseMVA, 1) + ' MW' : '--';
    $('statLoss').textContent = d ? fmt(d.totalLoss * state.baseMVA, 2) + ' MW' : '--';
    $('statBalance').textContent = d ? d.balanceError.toExponential(2) + ' pu' : '--';
    $('statLoading').textContent = d ? fmt(d.maxLoading * 100, 1) + '%' : '--';
    $('statLoading').className = d && d.maxLoading > 1 ? 'warn' : '';
  }

  function updateTables() {
    const s = state.solution, body = $('busTable').querySelector('tbody');
    body.textContent = '';
    if (!s) return;
    const limited = new Set((s.qLimited || []).map(q => q.bus));
    for (let i = 0; i < s.network.buses.length; i++) {
      const b = s.network.buses[i];
      const tr = document.createElement('tr');
      const cells = [b.id, b.type + (limited.has(i) ? ' (Q-limited)' : ''), fmt(s.vm[i], 5), fmt(s.va[i] * 180 / Math.PI, 3), fmt(s.P[i], 5), fmt(s.Q[i], 5)];
      for (const v of cells) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); }
      body.appendChild(tr);
    }
    $('networkReadout').textContent = describeSelection();
  }

  function describeSelection() {
    const s = state.solution, b = s.network.buses[state.selectedBus];
    const br = s.network.branches[state.selectedBranch];
    const lim = (s.qLimited || []).find(q => q.bus === state.selectedBus);
    const qNote = lim ? `, generator Q clamped to ${lim.bound} ${fmt(lim.qSet, 3)} pu` : '';
    return `Bus ${b.id}: |V| ${fmt(s.vm[state.selectedBus], 5)} pu, angle ${fmt(s.va[state.selectedBus] * 180 / Math.PI, 2)} deg, load ${fmt(b.pd, 2)} + j${fmt(b.qd, 2)} pu${qNote} | Branch ${br.id}: x ${fmt(br.x, 3)} pu, rating ${br.rateMVA} MVA, ${br.status ? 'in service' : 'out of service'}`;
  }

  function resetContingencyTable() {
    const body = $('contTable').querySelector('tbody');
    body.textContent = '';
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 7; td.textContent = 'Press Run N-1 screen to compute'; tr.appendChild(td); body.appendChild(tr);
    $('contStatus').textContent = 'Not yet computed';
    $('contPreview').textContent = '';
  }

  /* ---------------------------- Canvas drawing ---------------------------- */
  function prepareCanvas(id) {
    const canvas = $(id);
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 720 };
    const cssW = Math.max(300, Math.round(rect.width || 720));
    const cssH = Math.max(150, Math.round(cssW * (RATIOS[id] || 0.32)));
    const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx, w: cssW, h: cssH };
  }

  function axes(ctx, w, h, m, rows, yMin, yMax, xLabel) {
    const grid = cssVar('--grid', '#26344f'), muted = cssVar('--muted', '#8296b4');
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.font = '10px ui-monospace, monospace'; ctx.fillStyle = muted;
    for (let i = 0; i <= rows; i++) {
      const y = m.t + (h - m.t - m.b) * i / rows;
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(w - m.r, y); ctx.stroke();
      ctx.fillText(fmt(yMax - (yMax - yMin) * i / rows, 2), 3, y + 3);
    }
    ctx.strokeStyle = muted;
    ctx.beginPath(); ctx.moveTo(m.l, m.t); ctx.lineTo(m.l, h - m.b); ctx.lineTo(w - m.r, h - m.b); ctx.stroke();
    ctx.fillText(xLabel || '', m.l, h - 6);
  }

  function drawVoltage() {
    const { ctx, w, h } = prepareCanvas('voltageCanvas');
    const s = state.solution, m = { l: 44, r: 12, t: 12, b: 26 };
    axes(ctx, w, h, m, 4, 0.7, 1.1, 'Bus index');
    if (!s) return;
    const n = s.vm.length, bandW = (w - m.l - m.r) / n;
    const toY = v => m.t + (h - m.t - m.b) * (1 - (v - 0.7) / 0.4);
    // Voltage limit band.
    ctx.fillStyle = cssVar('--accent-soft', '#1e3559');
    ctx.fillRect(m.l, toY(1.1), w - m.l - m.r, toY(0.9) - toY(1.1));
    for (let i = 0; i < n; i++) {
      const x = m.l + bandW * (i + 0.5);
      // A failed solve can leave the last iterate far outside the band; clamp
      // the drawn marker to the plot rect so the chart stays readable.
      const y = Math.min(h - m.b, Math.max(m.t, toY(s.vm[i])));
      const bad = s.vm[i] < s.network.buses[i].vMin || s.vm[i] > s.network.buses[i].vMax;
      ctx.strokeStyle = bad ? cssVar('--warn', '#ffab7a') : (i === state.probe.voltage ? cssVar('--signal-b', '#ff87b2') : cssVar('--signal-a', '#62a6ff'));
      ctx.lineWidth = i === state.probe.voltage ? 4 : 2.5;
      ctx.beginPath(); ctx.moveTo(x, toY(1.0)); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = cssVar('--muted', '#8296b4'); ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(s.network.buses[i].id, x - 8, h - m.b + 12);
    }
    const i = Math.min(n - 1, Math.max(0, state.probe.voltage));
    const suffix = s.converged ? '' : ' | NOT CONVERGED: last iterate';
    $('voltageReadout').textContent = `bus ${s.network.buses[i].id} | |V| ${fmt(s.vm[i], 5)} pu | angle ${fmt(s.va[i] * 180 / Math.PI, 3)} deg | limits ${fmt(s.network.buses[i].vMin, 2)} to ${fmt(s.network.buses[i].vMax, 2)} pu${suffix}`;
  }

  function drawLoading() {
    const { ctx, w, h } = prepareCanvas('loadingCanvas');
    const s = state.solution, d = state.diagnostics, m = { l: 44, r: 12, t: 12, b: 26 };
    const flows = d ? d.flows : [];
    const maxVal = Math.max(1.2, ...flows.map(f => f.loading * 1.1));
    axes(ctx, w, h, m, 4, 0, maxVal, 'Branch index');
    if (!d) {
      $('loadingReadout').textContent = 'No line flows to report: the solver did not converge.';
      return;
    }
    const n = flows.length, bandW = (w - m.l - m.r) / Math.max(1, n);
    const y100 = m.t + (h - m.t - m.b) * (1 - 1 / maxVal);
    ctx.strokeStyle = cssVar('--warn', '#ffab7a'); ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(m.l, y100); ctx.lineTo(w - m.r, y100); ctx.stroke(); ctx.setLineDash([]);
    for (let i = 0; i < n; i++) {
      const x = m.l + bandW * (i + 0.5);
      const y = m.t + (h - m.t - m.b) * (1 - flows[i].loading / maxVal);
      ctx.strokeStyle = flows[i].loading > 1 ? cssVar('--warn', '#ffab7a') : (i === state.probe.loading ? cssVar('--signal-b', '#ff87b2') : cssVar('--fir', '#4ade80'));
      ctx.lineWidth = i === state.probe.loading ? 4 : 2.5;
      ctx.beginPath(); ctx.moveTo(x, m.t + (h - m.t - m.b)); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = cssVar('--muted', '#8296b4'); ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(flows[i].id, x - 10, h - m.b + 12);
    }
    const i = Math.min(n - 1, Math.max(0, state.probe.loading)), f = flows[i];
    $('loadingReadout').textContent = `${f.id} | loading ${fmt(f.loading * 100, 1)}% | P loss ${fmt(f.lossP * state.baseMVA, 3)} MW | P from ${fmt(f.pFrom, 4)} pu | P to ${fmt(f.pTo, 4)} pu`;
  }

  function drawConvergence() {
    const { ctx, w, h } = prepareCanvas('convergenceCanvas');
    const s = state.solution, m = { l: 52, r: 12, t: 12, b: 26 };
    axes(ctx, w, h, m, 4, -14, 2, 'Newton iteration (log10 max mismatch)');
    if (!s) return;
    const hist = s.history;
    const yOf = v => {
      const lg = Math.log10(Math.max(v, 1e-14));
      return m.t + (h - m.t - m.b) * (1 - (lg + 14) / 16);
    };
    ctx.strokeStyle = cssVar('--fir', '#4ade80'); ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const x = m.l + (w - m.l - m.r) * i / Math.max(1, hist.length - 1);
      const y = yOf(hist[i].maxMismatch);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    for (let i = 0; i < hist.length; i++) {
      const x = m.l + (w - m.l - m.r) * i / Math.max(1, hist.length - 1);
      ctx.fillStyle = i === state.probe.convergence ? cssVar('--signal-b', '#ff87b2') : cssVar('--signal-a', '#62a6ff');
      ctx.beginPath(); ctx.arc(x, yOf(hist[i].maxMismatch), 3, 0, Math.PI * 2); ctx.fill();
    }
    const i = Math.min(hist.length - 1, Math.max(0, state.probe.convergence));
    const qNote = (s.qLimited || []).length ? ` | ${s.qLimited.length} PV bus(es) Q-limited` : '';
    $('convergenceReadout').textContent = `iteration ${hist[i].iteration} | max mismatch ${hist[i].maxMismatch.toExponential(3)} pu | max P ${hist[i].maxP.toExponential(3)} | max Q ${hist[i].maxQ.toExponential(3)} | ${s.converged ? 'converged' : 'not converged'}${qNote}`;
  }

  /* ------------------------------ SVG diagram ----------------------------- */
  function busPositions(n) {
    // Deterministic layout: a ring for meshed networks, a horizontal chain
    // for radial ones. Positions are in the 720x420 viewBox.
    const pts = [];
    const radial = state.network.branches.length === n - 1 &&
      state.network.branches.every((b, i) => b.from === i && b.to === i + 1);
    if (radial) {
      for (let i = 0; i < n; i++) pts.push({ x: 70 + (580 * i) / Math.max(1, n - 1), y: 210 });
    } else {
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + 2 * Math.PI * i / n;
        pts.push({ x: 360 + 250 * Math.cos(a), y: 210 + 155 * Math.sin(a) });
      }
    }
    return pts;
  }

  function drawNetwork() {
    const svg = $('networkSvg');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const ns = 'http://www.w3.org/2000/svg';
    const add = (tag, attrs, parent) => {
      const node = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      (parent || svg).appendChild(node);
      return node;
    };
    const t = add('title', {}); t.textContent = 'Network one-line diagram';
    const d = add('desc', {}); d.textContent = 'Buses and branches colored by solved voltage and loading.';
    const s = state.solution, d2 = state.diagnostics;
    if (!s) return;
    const n = s.network.buses.length, pts = busPositions(n);
    const grid = cssVar('--grid', '#26344f'), muted = cssVar('--muted', '#8296b4');
    const flows = d2 ? d2.flows : [];
    const preview = state.previewBranch != null ? state.previewRow : null;
    const previewBad = preview && preview.violatedBuses ? new Set(preview.violatedBuses) : new Set();
    // Branches first, then buses on top.
    s.network.branches.forEach((br, i) => {
      const p = pts[br.from], q = pts[br.to];
      const f = flows[i];
      const heavy = f && f.loading > 1;
      const tripped = i === state.previewBranch;
      const line = add('line', {
        x1: p.x, y1: p.y, x2: q.x, y2: q.y,
        stroke: tripped ? cssVar('--warn', '#ffab7a') : !br.status ? grid : heavy ? cssVar('--warn', '#ffab7a') : (i === state.selectedBranch ? cssVar('--signal-b', '#ff87b2') : cssVar('--accent', '#62a6ff')),
        'stroke-width': tripped ? 6 : br.status ? (heavy ? 5 : 3) : 2,
        'stroke-dasharray': tripped ? '4,4' : br.status ? '' : '6,5',
        opacity: !br.status ? 0.55 : 1
      });
      line.addEventListener('click', () => { state.selectedBranch = i; $('branchSelect').value = String(i); syncEditor(); redraw(); });
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const label = add('text', { x: mx, y: my - 6, 'text-anchor': 'middle', fill: tripped ? cssVar('--warn', '#ffab7a') : muted, 'font-size': 10, 'font-weight': tripped ? 700 : 400 });
      label.textContent = br.id + (tripped ? ' OUT' : f && br.status ? ' ' + fmt(f.loading * 100, 0) + '%' : '');
    });
    s.network.buses.forEach((b, i) => {
      const p = pts[i];
      const bad = s.vm[i] < b.vMin || s.vm[i] > b.vMax || previewBad.has(b.id);
      const color = b.type === 'slack' ? cssVar('--fir', '#4ade80') : bad ? cssVar('--warn', '#ffab7a') : cssVar('--signal-a', '#62a6ff');
      add('circle', { cx: p.x, cy: p.y, r: 22, fill: cssVar('--surface-2', '#1b2740'), stroke: color, 'stroke-width': i === state.selectedBus ? 4 : 2 });
      const label = add('text', { x: p.x, y: p.y + 4, 'text-anchor': 'middle', fill: cssVar('--text', '#e8eefb'), 'font-size': 11, 'font-weight': 600 });
      label.textContent = b.id;
      const v = add('text', { x: p.x, y: p.y + 38, 'text-anchor': 'middle', fill: muted, 'font-size': 10 });
      v.textContent = fmt(s.vm[i], 3) + ' pu';
      svg.lastChild.addEventListener('click', () => { state.selectedBus = i; $('busSelect').value = String(i); syncEditor(); redraw(); });
      // Make the whole node group clickable.
      const circle = svg.querySelectorAll('circle')[svg.querySelectorAll('circle').length - 1];
      circle.addEventListener('click', () => { state.selectedBus = i; $('busSelect').value = String(i); syncEditor(); redraw(); });
    });
    $('networkReadout').textContent = describeSelection();
  }

  function redraw() {
    drawVoltage(); drawLoading(); drawConvergence(); drawNetwork();
  }

  /* -------------------------------- Exports ------------------------------- */
  function download(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    state.lastExport = name;
    $('exportNote').textContent = 'Generated ' + name + ' locally.';
  }

  function bindExports() {
    $('jsonBtn').addEventListener('click', () => {
      if (!state.solution) return;
      download('gridflow-ac-experiment.json', G.exportExperimentJSON(state.solution, { preset: state.preset, loadFactor: state.loadFactor }), 'application/json');
    });
    $('busCsvBtn').addEventListener('click', () => {
      if (!state.solution) return;
      download('gridflow_buses.csv', G.exportBusCSV(state.solution), 'text/csv');
    });
    $('branchCsvBtn').addEventListener('click', () => {
      if (!state.solution) return;
      download('gridflow_branches.csv', G.exportBranchCSV(state.solution), 'text/csv');
    });
    $('convergenceCsvBtn').addEventListener('click', () => {
      if (!state.solution) return;
      download('gridflow_convergence.csv', G.exportConvergenceCSV(state.solution), 'text/csv');
    });
    $('contCsvBtn').addEventListener('click', () => {
      if (!state.scan) return;
      download('gridflow_n1.csv', G.exportContingencyCSV(state.scan), 'text/csv');
    });
    $('auditJsonBtn').addEventListener('click', () => {
      if (!state.solution) return;
      const text = G.exportAuditJSON({
        solution: state.solution, scan: state.scan, derResult: state.derResult,
        preset: state.preset, loadFactor: state.loadFactor
      });
      download('gridflow-ac-audit.json', text, 'application/json');
      const sums = G.buildAudit({ solution: state.solution, scan: state.scan, derResult: state.derResult, preset: state.preset, loadFactor: state.loadFactor }).checksums;
      $('auditNote').textContent = `gridflow-ac-audit.json | fnv1a64 ${sums.fnv1a64} | sha256 ${sums.sha256.slice(0, 24)}...`;
    });
    $('auditCsvBtn').addEventListener('click', () => {
      if (!state.scan) return;
      download('gridflow-ac-n1-audit.csv', G.exportContingencyCSV(state.scan), 'text/csv');
      $('auditNote').textContent = 'N-1 audit CSV generated locally (ranked, with violated buses and overloaded branches).';
    });
    $('selfTestBtn').addEventListener('click', () => {
      const list = $('selfTestList');
      try {
        const results = G.selfTestSuite();
        state.selfTests = results;
        list.textContent = '';
        list.hidden = false;
        for (const t of results) {
          const li = document.createElement('li');
          const mark = document.createElement('span');
          mark.className = 'selftest-mark ' + (t.pass ? 'pass' : 'fail');
          mark.textContent = t.pass ? 'PASS' : 'FAIL';
          li.appendChild(mark);
          li.appendChild(document.createTextNode(` ${t.name}: ${t.detail}`));
          list.appendChild(li);
        }
        const passed = results.filter(t => t.pass).length;
        $('auditNote').textContent = `${passed}/${results.length} self-tests passed | Kirchhoff balance, N-1 determinism, Volt-VAR, checksums, collapse honesty, overloads`;
      } catch (err) {
        state.selfTests = null;
        $('auditNote').textContent = 'Self-tests failed to run: ' + err.message;
      }
    });
  }

  /* --------------------------- N-1 security scanner ----------------------- */
  const SORT_KEYS = {
    rank: r => r.rank, outage: r => r.outage, converged: r => (r.converged ? 1 : 0),
    maxLoading: r => (r.maxLoading == null ? -1 : r.maxLoading),
    overloaded: r => (r.overloaded == null ? -1 : r.overloaded),
    voltageViolations: r => (r.voltageViolations == null ? -1 : r.voltageViolations),
    severity: r => r.severity
  };

  function sortedScanRows() {
    const key = SORT_KEYS[state.sortKey] ? state.sortKey : 'rank';
    const rows = state.scan ? state.scan.results.slice() : [];
    const dir = state.sortDir === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const va = SORT_KEYS[key](a), vb = SORT_KEYS[key](b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return a.outage < b.outage ? -1 : a.outage > b.outage ? 1 : 0;
    });
    return rows;
  }

  function renderScanTable() {
    const body = $('contTable').querySelector('tbody');
    body.textContent = '';
    for (const r of sortedScanRows()) {
      const tr = document.createElement('tr');
      tr.classList.toggle('row-fail', !r.converged);
      tr.classList.toggle('row-crit', r.rank === 1 && r.severity > 0);
      tr.classList.toggle('row-preview', state.previewBranch === r.branchIndex);
      const togglePreview = () => {
        // Clicking the row or activating its native toggle button previews
        // that exact outage on the one-line diagram; activating it again
        // clears the preview.
        if (state.previewBranch === r.branchIndex) {
          state.previewBranch = null; state.previewRow = null;
          $('contPreview').textContent = '';
        } else {
          state.previewBranch = r.branchIndex; state.previewRow = r;
          $('contPreview').textContent = `Preview: ${r.outage} out of service | ` +
            (r.converged
              ? `min |V| ${fmt(r.minVoltage, 4)} pu${r.violatedBuses.length ? ' | violated: ' + r.violatedBuses.join(', ') : ''}` +
                `${r.overloadedBranches.length ? ' | overloaded: ' + r.overloadedBranches.join(', ') : ''} | severity ${fmt(r.severity, 1)}`
              : `solve failed (${r.reason}) | severity ${fmt(r.severity, 1)}`) +
            ` | rank ${r.rank} of ${state.scan.results.length}`;
        }
        renderScanTable(); redraw();
      };
      const vals = [
        String(r.rank), r.outage, r.converged ? 'yes' : 'NO',
        r.maxLoading == null ? '--' : fmt(r.maxLoading * 100, 1) + '%',
        String(r.overloaded ?? '--'), String(r.voltageViolations ?? '--'),
        fmt(r.severity, 1)
      ];
      vals.forEach((v, cellIndex) => {
        const td = document.createElement('td');
        if (cellIndex === 1) {
          const previewBtn = document.createElement('button');
          previewBtn.type = 'button';
          previewBtn.className = 'cont-preview-btn';
          previewBtn.textContent = v;
          previewBtn.setAttribute('aria-label', 'Preview outage ' + r.outage);
          previewBtn.setAttribute('aria-pressed', String(state.previewBranch === r.branchIndex));
          previewBtn.addEventListener('click', ev => { ev.stopPropagation(); togglePreview(); });
          td.appendChild(previewBtn);
        } else td.textContent = v;
        tr.appendChild(td);
      });
      tr.addEventListener('click', togglePreview);
      body.appendChild(tr);
    }
    for (const btn of $('contTable').querySelectorAll('thead .th-sort')) {
      const active = btn.getAttribute('data-key') === state.sortKey;
      btn.parentNode.setAttribute('aria-sort', active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
      btn.removeAttribute('aria-sort');
      btn.classList.toggle('sorted', active);
    }
  }

  function runContingency() {
    try {
      const net = effectiveNetwork();
      net.baseMVA = state.baseMVA;
      const scan = G.securityScan(net, {
        tolerance: state.tolerance, maxIter: state.maxIter,
        der: state.der.enabled ? derSpec() : null
      });
      state.scan = scan;
      state.contingency = scan.results;
      state.previewBranch = null; state.previewRow = null;
      $('contPreview').textContent = '';
      updateExportAvailability();
      renderScanTable();
      const band = `band ${fmt(scan.band.low, 2)}-${fmt(scan.band.high, 2)} pu`;
      $('contStatus').textContent =
        `${scan.screened} outages screened | ${scan.nonConverged} did not converge | ${scan.withOverloads} produce overloads | ` +
        `${scan.withVoltageViolations} violate ${band} | ` +
        (scan.secure ? 'grid is N-1 secure' : `critical: ${scan.critical}`) +
        (state.der.enabled ? ' | DER active' : '');
    } catch (err) {
      state.contingency = null; state.scan = null;
      updateExportAvailability();
      $('contStatus').textContent = 'N-1 screen failed: ' + err.message;
    }
  }

  /* -------------------------------- Bindings ------------------------------ */
  function markCustom() {
    // The preset control still shows the base network; the note marks edits.
    $('presetNote').textContent = 'Custom synthetic benchmark derived from ' + G.getPreset(state.preset).label + '. Loads and branch data edited locally.';
  }

  function bindControls() {
    $('presetSelect').addEventListener('change', ev => { loadPreset(ev.target.value); });
    for (const id of ['loadFactor', 'baseMVA', 'tolerance', 'maxIter']) {
      $(id).addEventListener('input', recompute);
      $(id).addEventListener('change', recompute);
    }
    $('busSelect').addEventListener('change', ev => { state.selectedBus = Number(ev.target.value); syncEditor(); redraw(); });
    $('branchSelect').addEventListener('change', ev => { state.selectedBranch = Number(ev.target.value); syncEditor(); redraw(); });
    $('busLoadP').addEventListener('input', ev => {
      state.network.buses[state.selectedBus].pd = Number(ev.target.value); markCustom(); recompute();
    });
    $('busLoadQ').addEventListener('input', ev => {
      state.network.buses[state.selectedBus].qd = Number(ev.target.value); markCustom(); recompute();
    });
    $('branchX').addEventListener('input', ev => {
      state.network.branches[state.selectedBranch].x = Number(ev.target.value); markCustom(); recompute();
    });
    $('branchRate').addEventListener('input', ev => {
      state.network.branches[state.selectedBranch].rateMVA = Number(ev.target.value); markCustom(); recompute();
    });
    $('branchStatus').addEventListener('change', ev => {
      state.network.branches[state.selectedBranch].status = ev.target.checked ? 1 : 0; markCustom(); recompute();
    });
    $('derEnable').addEventListener('change', recompute);
    $('derBus').addEventListener('change', recompute);
    const derEdit = () => { readControls(); if (state.der.enabled) recompute(); else syncLabels(); };
    for (const id of ['derSolar', 'derBess', 'derQCap', 'derGain', 'derDeadband']) {
      $(id).addEventListener('input', derEdit);
      $(id).addEventListener('change', derEdit);
    }
    for (const btn of $('contTable').querySelectorAll('thead .th-sort')) {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-key');
        if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortKey = key; state.sortDir = key === 'outage' || key === 'converged' ? 'asc' : 'desc'; }
        if (state.scan) renderScanTable();
      });
    }
    $('resetBtn').addEventListener('click', () => { $('presetSelect').value = state.preset; loadPreset(state.preset); });
    $('contBtn').addEventListener('click', runContingency);
    $('themeToggle').addEventListener('click', () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      // aria-pressed reports whether the light (alternate) theme is active;
      // the label names the current state so the two never disagree.
      document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
      $('themeToggle').setAttribute('aria-pressed', String(dark));
      $('themeToggle').textContent = 'Theme: ' + (dark ? 'light' : 'dark');
      try { localStorage.setItem('gridflow-theme', dark ? 'light' : 'dark'); } catch (e) { /* storage optional */ }
      redraw();
    });
    try {
      if (localStorage.getItem('gridflow-theme') === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        $('themeToggle').setAttribute('aria-pressed', 'true');
        $('themeToggle').textContent = 'Theme: light';
      }
    } catch (e) { /* storage optional */ }
    $('helpToggle').addEventListener('click', () => {
      const p = $('helpPanel'); p.hidden = !p.hidden;
      $('helpToggle').setAttribute('aria-expanded', String(!p.hidden));
    });
    globalThis.addEventListener('resize', () => { if (state.solution) redraw(); });

    // Keyboard probes on the three numeric canvases.
    for (const [id, key, maxFn] of [
      ['voltageCanvas', 'voltage', () => (state.solution ? state.solution.network.buses.length - 1 : 0)],
      ['loadingCanvas', 'loading', () => (state.diagnostics ? state.diagnostics.flows.length - 1 : 0)],
      ['convergenceCanvas', 'convergence', () => (state.solution && state.solution.history.length ? state.solution.history.length - 1 : 0)]
    ]) {
      const canvas = $(id);
      canvas.addEventListener('pointermove', ev => {
        if (!state.solution) return;
        const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, width: 720 };
        const t = G.clamp((Number(ev.clientX) - (rect.left || 0)) / Math.max(1, rect.width || 720), 0, 1);
        state.probe[key] = Math.round(t * maxFn());
        redraw();
      });
      canvas.addEventListener('keydown', ev => {
        if (!state.solution) return;
        const max = maxFn(), step = ev.shiftKey ? 5 : 1;
        let handled = true;
        if (ev.key === 'ArrowLeft') state.probe[key] = Math.max(0, state.probe[key] - step);
        else if (ev.key === 'ArrowRight') state.probe[key] = Math.min(max, state.probe[key] + step);
        else if (ev.key === 'Home') state.probe[key] = 0;
        else if (ev.key === 'End') state.probe[key] = max;
        else handled = false;
        if (handled) { ev.preventDefault(); redraw(); }
      });
    }

    globalThis.__GRIDFLOW__ = {
      get state() { return state; },
      get solution() { return state.solution; },
      get diagnostics() { return state.diagnostics; },
      get scan() { return state.scan; },
      get derResult() { return state.derResult; },
      recompute, redraw, runContingency, renderScanTable
    };
  }

  function start() {
    if (!G) {
      $('engineBadge').textContent = 'engine unavailable';
      showError('Power-flow engine failed to load. Verify src/gridflow.cjs exists.');
      return;
    }
    $('engineBadge').textContent = 'local AC solver ready';
    bindControls(); bindExports();
    $('presetSelect').value = 'ieee5';
    loadPreset('ieee5');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
