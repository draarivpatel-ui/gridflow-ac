/* GridFlow AC controller. Uses the shared power-flow engine (window.GridFlow). */
'use strict';
(function () {
  const G = globalThis.GridFlow;
  const $ = id => document.getElementById(id);
  const RATIOS = { voltageCanvas: 230 / 720, loadingCanvas: 230 / 720, convergenceCanvas: 220 / 720 };

  const state = {
    preset: 'ieee5', loadFactor: 1, baseMVA: 100, tolerance: 1e-10, maxIter: 60,
    network: null, solution: null, diagnostics: null, contingency: null,
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

  function showError(msg) {
    const node = $('errorStatus');
    node.textContent = msg; node.hidden = !msg;
    for (const id of ['jsonBtn', 'busCsvBtn', 'branchCsvBtn', 'convergenceCsvBtn', 'contCsvBtn']) $(id).disabled = !!msg;
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
      const solution = G.solveAC(net, { tolerance: state.tolerance, maxIter: state.maxIter });
      state.network.baseMVA = state.baseMVA;
      state.solution = solution;
      state.diagnostics = G.diagnostics(solution);
      state.contingency = null;
      syncLabels();
      redraw();
      updateDiagnostics();
      updateTables();
      resetContingencyTable();
      showError('');
      const qNote = solution.qLimited && solution.qLimited.length
        ? ' | Q-limited: ' + solution.qLimited.map(q => q.id + '@' + q.bound).join(', ')
        : '';
      $('statusLine').textContent = solution.converged
        ? `${G.getPreset(state.preset).label} | load ${fmt(state.loadFactor, 2)}x | ${solution.network.buses.length} buses, ${solution.network.branches.length} branches | ${solution.iterations} Newton iterations | max mismatch ${solution.mismatch.toExponential(2)} pu${qNote}`
        : `NON-CONVERGED: ${solution.reason} | last mismatch ${solution.mismatch.toExponential(2)} pu | charts and table show the last Newton iterate, not a valid operating point`;
      $('statusLine').classList.toggle('warn', !solution.converged);
      $('footerStatus').textContent = solution.converged ? 'Solved locally, no network requests' : 'Solve failed: ' + solution.reason;
    } catch (err) {
      state.solution = null; state.diagnostics = null; state.contingency = null;
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
    td.colSpan = 5; td.textContent = 'Press Run N-1 screen to compute'; tr.appendChild(td); body.appendChild(tr);
    $('contStatus').textContent = 'Not yet computed';
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
    // Branches first, then buses on top.
    s.network.branches.forEach((br, i) => {
      const p = pts[br.from], q = pts[br.to];
      const f = flows[i];
      const heavy = f && f.loading > 1;
      const line = add('line', {
        x1: p.x, y1: p.y, x2: q.x, y2: q.y,
        stroke: !br.status ? grid : heavy ? cssVar('--warn', '#ffab7a') : (i === state.selectedBranch ? cssVar('--signal-b', '#ff87b2') : cssVar('--accent', '#62a6ff')),
        'stroke-width': br.status ? (heavy ? 5 : 3) : 2,
        'stroke-dasharray': br.status ? '' : '6,5',
        opacity: br.status ? 1 : 0.55
      });
      line.addEventListener('click', () => { state.selectedBranch = i; $('branchSelect').value = String(i); syncEditor(); redraw(); });
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const label = add('text', { x: mx, y: my - 6, 'text-anchor': 'middle', fill: muted, 'font-size': 10 });
      label.textContent = br.id + (f && br.status ? ' ' + fmt(f.loading * 100, 0) + '%' : '');
    });
    s.network.buses.forEach((b, i) => {
      const p = pts[i];
      const bad = s.vm[i] < b.vMin || s.vm[i] > b.vMax;
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
      if (!state.contingency) return;
      const rows = [['outage', 'converged', 'reason', 'max_loading', 'overloads', 'voltage_violations', 'min_voltage']];
      for (const r of state.contingency) {
        rows.push([G.csvField(r.outage), String(r.converged), G.csvField(r.reason),
          r.maxLoading == null ? '' : r.maxLoading.toFixed(6), String(r.overloaded ?? ''),
          String(r.voltageViolations ?? ''), r.minVoltage == null ? '' : r.minVoltage.toFixed(6)]);
      }
      download('gridflow_n1.csv', rows.join('\n') + '\n', 'text/csv');
    });
  }

  /* ------------------------------ Contingency ----------------------------- */
  function runContingency() {
    try {
      const body = $('contTable').querySelector('tbody');
      body.textContent = '';
      const results = G.contingencyAnalysis(effectiveNetwork(), { tolerance: state.tolerance, maxIter: state.maxIter });
      state.contingency = results;
      for (const r of results) {
        const tr = document.createElement('tr');
        const vals = [r.outage, r.converged ? 'yes' : 'NO', r.maxLoading == null ? '--' : fmt(r.maxLoading * 100, 1) + '%',
          String(r.overloaded ?? '--'), String(r.voltageViolations ?? '--')];
        for (const v of vals) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); }
        body.appendChild(tr);
      }
      const failures = results.filter(r => !r.converged).length;
      const overloaded = results.filter(r => r.overloaded > 0).length;
      $('contStatus').textContent = `${results.length} outages screened | ${failures} did not converge | ${overloaded} produce overloads | each row is a full AC re-solve`;
    } catch (err) {
      state.contingency = null;
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
      recompute, redraw, runContingency
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
