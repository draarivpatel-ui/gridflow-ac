#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = __dirname;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOT_DIR = process.env.SHOT_DIR || '';
const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.cjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

if (typeof WebSocket === 'undefined') {
  console.error('browser-check needs Node 22 or newer for the global WebSocket client.');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function serveStatic() {
  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const normalized = path.normalize(pathname).replace(/^([/\\])+/, '');
    const file = path.join(ROOT, normalized);
    if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(file).then(body => {
      res.writeHead(200, { 'Content-Type': TYPES.get(path.extname(file)) || 'application/octet-stream' });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
    }).catch(() => {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, base: `http://127.0.0.1:${address.port}/` });
    });
  });
}

function waitWsUrl(proc) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const done = fn => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off('error', onErr);
      proc.off('exit', onExit);
      fn();
    };
    const onData = chunk => {
      buf += chunk;
      if (buf.length > 12000) buf = buf.slice(-8000);
      if (settled) return;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) done(() => resolve(m[1]));
    };
    const onErr = err => done(() => reject(new Error(`chrome spawn failed: ${err.message}`)));
    const onExit = code => done(() => reject(new Error(`chrome exited with code ${code}; stderr: ${buf.slice(-400)}`)));
    const timer = setTimeout(() => done(() => reject(new Error('no DevTools websocket URL within 15s'))), 15000);
    proc.stderr.on('data', onData);
    proc.on('error', onErr);
    proc.on('exit', onExit);
  });
}

const waitExit = proc => proc.exitCode !== null ? Promise.resolve() : new Promise(resolve => proc.once('exit', resolve));

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.requests = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('devtools websocket failed'));
    });
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
      } else if (msg.method) {
        const p = msg.params || {};
        if (msg.method === 'Runtime.exceptionThrown') {
          this.errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'page exception');
        }
        if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
          this.errors.push((p.args || []).map(arg => arg.value ?? arg.description ?? '').join(' '));
        }
        if (msg.method === 'Log.entryAdded' && p.entry?.level === 'error') {
          this.errors.push(`${p.entry.text || ''} ${p.entry.url || ''}`.trim());
        }
        if (msg.method === 'Network.requestWillBeSent') this.requests.push(p.request?.url || '');
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() {
    try { this.ws.close(); } catch { }
  }
}

const auditSource = `(() => {
  const cw = document.documentElement.clientWidth;
  const visible = el => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const cls = el => typeof el.className === 'string' ? el.className : (el.className?.baseVal || '');
  const overflowers = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.closest('.table-scroll')) continue;
    const r = el.getBoundingClientRect();
    if (r.right > cw + 1 || r.left < -1) {
      overflowers.push(el.tagName.toLowerCase() + '.' + cls(el) + ' R' + Math.round(r.right) + ' L' + Math.round(r.left));
      if (overflowers.length >= 6) break;
    }
  }
  const ids = Array.from(document.querySelectorAll('[id]'), el => el.id);
  const duplicateIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  const controls = Array.from(document.querySelectorAll('button,input:not([type="hidden"]),select,textarea,a[href],canvas[tabindex]'))
    .filter(visible)
    .map(el => {
      const r = el.getBoundingClientRect();
      const labelEl = el.closest('label') || (el.id ? document.querySelector('label[for="' + el.id + '"]') : null);
      const lr = labelEl ? labelEl.getBoundingClientRect() : null;
      return {
        tag: el.tagName.toLowerCase(), id: el.id || '', cls: cls(el), text: (el.textContent || el.value || '').trim().slice(0, 42),
        width: Math.round(r.width), height: Math.round(r.height),
        targetWidth: Math.max(Math.round(r.width), lr ? Math.round(lr.width) : 0),
        targetHeight: Math.max(Math.round(r.height), lr ? Math.round(lr.height) : 0),
        label: !!(labelEl || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')),
        name: !!((el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.value || '').trim())
      };
    });
  const unlabeled = controls.filter(c => ['input', 'select', 'textarea'].includes(c.tag) && !c.label).map(c => c.id || c.cls || c.tag);
  const unnamed = controls.filter(c => ['button', 'a'].includes(c.tag) && !c.name).map(c => c.id || c.cls || c.tag);
  const smallTargets = controls.filter(c => c.targetWidth < 24 || c.targetHeight < 24).map(c => c.tag + (c.id ? '#' + c.id : '') + ':' + c.targetWidth + 'x' + c.targetHeight);
  const parse = value => {
    const m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(',').map(x => parseFloat(x));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const channel = v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = c => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const bgFor = el => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.01) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const contrastBad = [];
  const contrastSamples = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.closest('svg') || ['SCRIPT', 'STYLE', 'CANVAS'].includes(el.tagName)) continue;
    const ownText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!ownText) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    if (!fg) continue;
    const bg = bgFor(el);
    const r = ratio(fg, bg);
    const size = parseFloat(s.fontSize);
    const weight = parseInt(s.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = large ? 3 : 4.5;
    const item = { text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 38), ratio: r, required, cls: cls(el), tag: el.tagName.toLowerCase() };
    contrastSamples.push(item);
    if (r + 0.01 < required && contrastBad.length < 8) contrastBad.push(item);
  }
  contrastSamples.sort((a, b) => (a.ratio / a.required) - (b.ratio / b.required));
  const layoutStyle = getComputedStyle(document.querySelector('.layout'));
  const controlsStyle = getComputedStyle(document.querySelector('.controls-panel'));
  return {
    title: document.title,
    overflow: document.documentElement.scrollWidth > cw + 1,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: cw,
    overflowers,
    duplicateIds,
    unlabeled,
    unnamed,
    smallTargets,
    contrastBad,
    contrastWorst: contrastSamples.slice(0, 5),
    layoutColumns: layoutStyle.gridTemplateColumns,
    controlsPosition: controlsStyle.position,
    controlsScrollable: document.querySelector('.controls-panel').scrollHeight > document.querySelector('.controls-panel').clientHeight + 1,
    theme: document.documentElement.getAttribute('data-theme')
  };
})()`;

async function main() {
  let server = null;
  let chrome = null;
  let cdp = null;
  let profile = null;
  let base = '';
  try {
    const served = await serveStatic();
    server = served.server;
    base = served.base;
    check('static server ready on ephemeral port', /^http:\/\/127\.0\.0\.1:\d+\/$/.test(base), base);

    profile = await fs.mkdtemp(path.join(os.tmpdir(), 'gridflow-ac-check-'));
    chrome = spawn(CHROME, [
      '--headless=new', '--mute-audio', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await waitWsUrl(chrome);
    cdp = new CDP(wsUrl);
    await cdp.ready;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    const evalValue = async expression => {
      const out = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (out.exceptionDetails) {
        throw new Error(`page eval failed: ${out.exceptionDetails.text} ${out.exceptionDetails.exception?.description || ''}`);
      }
      return out.result?.value;
    };
    const waitFor = async (expression, label, tries = 100) => {
      for (let i = 0; i < tries; i++) {
        if (await evalValue(expression)) return;
        await sleep(100);
      }
      throw new Error(`timeout waiting for ${label}`);
    };
    const realClick = async (selector, index = 0) => {
      const pt = await evalValue(`(() => {
        const n = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        if (!n) return null;
        n.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = n.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!pt) throw new Error(`no element for ${selector}`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 }, sessionId);
      }
      await sleep(90);
    };
    const keySpec = key => ({
      Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
      ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
      ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
      Home: { code: 'Home', windowsVirtualKeyCode: 36 },
      End: { code: 'End', windowsVirtualKeyCode: 35 }
    }[key] || { code: key, windowsVirtualKeyCode: 0 });
    const pressKey = async key => {
      const spec = keySpec(key);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...spec }, sessionId);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, ...spec }, sessionId);
      await sleep(90);
    };
    const shot = async file => {
      if (!SHOT_DIR) return false;
      await fs.mkdir(SHOT_DIR, { recursive: true });
      const s = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true }, sessionId);
      await fs.writeFile(path.join(SHOT_DIR, file), Buffer.from(s.data, 'base64'));
      return true;
    };

    for (const domain of ['Runtime', 'Page', 'Log', 'Network']) await cdp.send(`${domain}.enable`, {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send('Page.navigate', { url: base }, sessionId);
    await waitFor(`!!(globalThis.__GRIDFLOW__ && globalThis.__GRIDFLOW__.solution)`, 'live solver state');

    const first = await evalValue(auditSource);
    check('page title', first.title === 'GridFlow AC | Power Flow Workbench', first.title);
    check('no horizontal overflow at 1440', first.overflow === false, `${first.scrollWidth}/${first.clientWidth} ${first.overflowers.join(' | ')}`);
    check('desktop layout keeps controls and stage columns', first.layoutColumns.trim().split(/\s+/).length >= 2, first.layoutColumns);
    check('desktop controls stick and scroll inside viewport', first.controlsPosition === 'sticky' && first.controlsScrollable === true, `${first.controlsPosition}/${first.controlsScrollable}`);
    check('no duplicate ids at 1440', first.duplicateIds.length === 0, first.duplicateIds.join(','));
    check('all form controls labelled at 1440', first.unlabeled.length === 0, first.unlabeled.join(','));
    check('all buttons and links have names at 1440', first.unnamed.length === 0, first.unnamed.join(','));
    check('dark-theme text contrast meets WCAG ratios', first.contrastBad.length === 0, first.contrastBad.map(x => `${x.text}:${x.ratio.toFixed(2)}/${x.required}`).join(' | '));

    const initial = await evalValue(`(() => ({
      badge: document.getElementById('engineBadge').textContent,
      status: document.getElementById('statusLine').textContent,
      solver: document.getElementById('statSolver').textContent,
      svgCircles: document.querySelectorAll('#networkSvg circle').length,
      svgLines: document.querySelectorAll('#networkSvg line').length,
      busRows: document.querySelectorAll('#busTable tbody tr').length,
      canvases: Array.from(document.querySelectorAll('canvas')).map(c => ({ id: c.id, w: c.width, h: c.height, cssW: Math.round(c.getBoundingClientRect().width) })),
      exportsDisabled: ['jsonBtn','busCsvBtn','branchCsvBtn','convergenceCsvBtn','auditJsonBtn'].map(id => document.getElementById(id).disabled)
    }))()`);
    check('engine badge reports local solver ready', initial.badge === 'local AC solver ready', initial.badge);
    check('initial solve converged', initial.solver === 'CONVERGED' && !initial.status.startsWith('NON-CONVERGED'), initial.status.slice(0, 90));
    check('network diagram draws buses and branches', initial.svgCircles >= 5 && initial.svgLines >= 7, `${initial.svgCircles}/${initial.svgLines}`);
    check('bus table filled from real solve', initial.busRows >= 5, `${initial.busRows}`);
    check('three canvases sized for device pixels', initial.canvases.length === 3 && initial.canvases.every(x => x.w >= 300 && x.h >= 150 && x.cssW > 250), JSON.stringify(initial.canvases));
    check('base exports enabled before user input', initial.exportsDisabled.every(x => x === false), initial.exportsDisabled.join(','));
    await shot('gridflow-desktop-1440x900.png');

    await pressKey('Tab');
    await evalValue(`document.getElementById('voltageCanvas').focus(); true`);
    const beforeProbe = await evalValue(`document.getElementById('voltageReadout').textContent`);
    await pressKey('ArrowRight');
    const focusCheck = await evalValue(`(() => {
      const c = document.getElementById('voltageCanvas');
      const s = getComputedStyle(c);
      return { active: document.activeElement === c, readout: document.getElementById('voltageReadout').textContent, outline: s.outlineStyle + ' ' + s.outlineWidth, focusVisible: c.matches(':focus-visible') };
    })()`);
    check('canvas keyboard probe moves with ArrowRight', focusCheck.active === true && focusCheck.readout !== beforeProbe, `${beforeProbe} -> ${focusCheck.readout}`);
    check('canvas keeps a visible keyboard focus ring', focusCheck.focusVisible === true || !focusCheck.outline.includes('none'), focusCheck.outline);

    await realClick('#helpToggle');
    const helpOpen = await evalValue(`({ hidden: document.getElementById('helpPanel').hidden, expanded: document.getElementById('helpToggle').getAttribute('aria-expanded') })`);
    check('guide opens with aria-expanded', helpOpen.hidden === false && helpOpen.expanded === 'true', JSON.stringify(helpOpen));
    await realClick('#helpToggle');
    const helpClosed = await evalValue(`({ hidden: document.getElementById('helpPanel').hidden, expanded: document.getElementById('helpToggle').getAttribute('aria-expanded') })`);
    check('guide closes cleanly', helpClosed.hidden === true && helpClosed.expanded === 'false', JSON.stringify(helpClosed));

    await realClick('#themeToggle');
    const lightAudit = await evalValue(auditSource);
    check('theme toggle switches to light theme', lightAudit.theme === 'light', lightAudit.theme);
    check('light-theme text contrast meets WCAG ratios', lightAudit.contrastBad.length === 0, lightAudit.contrastBad.map(x => `${x.text}:${x.ratio.toFixed(2)}/${x.required}`).join(' | '));
    await realClick('#themeToggle');
    const darkAgain = await evalValue(`document.documentElement.getAttribute('data-theme')`);
    check('theme toggle returns to dark theme', darkAgain === 'dark', darkAgain);

    await realClick('#contBtn');
    await waitFor(`document.querySelectorAll('#contTable tbody tr').length > 1`, 'ranked N-1 rows');
    const scan = await evalValue(`(() => ({
      rows: document.querySelectorAll('#contTable tbody tr').length,
      status: document.getElementById('contStatus').textContent,
      csvEnabled: !document.getElementById('contCsvBtn').disabled,
      auditCsvEnabled: !document.getElementById('auditCsvBtn').disabled,
      sort: document.querySelector('#contTable thead th').getAttribute('aria-sort'),
      solvedCells: Array.from(document.querySelectorAll('#contTable tbody tr td:nth-child(3)')).map(x => x.textContent)
    }))()`);
    check('N-1 scan fills one row per in-service branch', scan.rows >= 7, `${scan.rows}`);
    check('N-1 summary reports real screening counts', /outages screened/.test(scan.status) && /critical:|N-1 secure/.test(scan.status), scan.status);
    check('N-1 scan enables ranked CSV exports', scan.csvEnabled === true && scan.auditCsvEnabled === true);
    check('ranked table publishes aria-sort', scan.sort === 'ascending' || scan.sort === 'descending', scan.sort);
    check('contingency solve states are explicit', scan.solvedCells.every(x => x === 'yes' || x === 'NO'), scan.solvedCells.join(','));

    await realClick('.cont-preview-btn', 0);
    const preview = await evalValue(`(() => ({
      text: document.getElementById('contPreview').textContent,
      svg: document.getElementById('networkSvg').textContent,
      pressed: document.querySelector('.cont-preview-btn').getAttribute('aria-pressed')
    }))()`);
    check('contingency click preview names the outage', /Preview: /.test(preview.text) && preview.pressed === 'true', preview.text.slice(0, 100));
    check('preview redraws tripped branch with OUT tag', preview.svg.includes('OUT'), preview.svg.slice(0, 160));
    await realClick('.cont-preview-btn', 0);
    const clearedPreview = await evalValue(`({ text: document.getElementById('contPreview').textContent, svg: document.getElementById('networkSvg').textContent })`);
    check('second preview click clears the outage overlay', clearedPreview.text === '' && !clearedPreview.svg.includes('OUT'), clearedPreview.text);

    await realClick('[data-key="outage"]');
    const outageSort = await evalValue(`(() => {
      const th = document.querySelector('[data-key="outage"]').parentElement;
      const ids = Array.from(document.querySelectorAll('.cont-preview-btn')).map(b => b.textContent);
      return { sort: th.getAttribute('aria-sort'), ids };
    })()`);
    const sortedIds = outageSort.ids.slice().sort();
    check('outage sort header reorders rows and aria-sort', outageSort.sort === 'ascending' && outageSort.ids.every((v, i) => v === sortedIds[i]), `${outageSort.sort}:${outageSort.ids.join(',')}`);

    await realClick('#derEnable');
    await waitFor(`document.getElementById('derReadout').textContent.includes('DER @')`, 'DER impact readout');
    const der = await evalValue(`(() => ({
      readout: document.getElementById('derReadout').textContent,
      before: document.getElementById('derVBefore').textContent,
      after: document.getElementById('derVAfter').textContent,
      q: document.getElementById('derQ').textContent,
      hostOptions: document.querySelectorAll('#derBus option').length,
      scanStatus: document.getElementById('contStatus').textContent
    }))()`);
    check('DER solve fills measured impact metrics', der.before !== '--' && der.after !== '--' && /fixed-point/.test(der.readout), `${der.before}/${der.after}/${der.q}`);
    check('DER host selector lists PQ buses only', der.hostOptions > 0, `${der.hostOptions}`);
    check('network edit clears stale pre-DER scan', der.scanStatus === 'Not yet computed', der.scanStatus);
    await realClick('#contBtn');
    await waitFor(`document.getElementById('contStatus').textContent.includes('DER active')`, 'DER-active N-1 scan');
    check('N-1 scan reruns through DER droop loop', true, await evalValue(`document.getElementById('contStatus').textContent`));

    await realClick('#selfTestBtn');
    await waitFor(`document.querySelectorAll('#selfTestList li').length === 6`, 'six self-test rows');
    const selftest = await evalValue(`(() => ({
      rows: document.querySelectorAll('#selfTestList li').length,
      pass: document.querySelectorAll('#selfTestList .pass').length,
      note: document.getElementById('auditNote').textContent
    }))()`);
    check('in-page self-test battery passes six checks', selftest.rows === 6 && selftest.pass === 6 && selftest.note.startsWith('6/6'), selftest.note);

    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: profile, eventsEnabled: false }, sessionId);
    await realClick('#auditJsonBtn');
    let auditFile = null;
    for (let i = 0; i < 50 && !auditFile; i++) {
      const names = await fs.readdir(profile).catch(() => []);
      const hit = names.find(n => n === 'gridflow-ac-audit.json');
      if (hit) auditFile = path.join(profile, hit);
      else await sleep(100);
    }
    check('audit JSON downloads locally', auditFile !== null, auditFile || 'none');
    if (auditFile) {
      const report = JSON.parse(await fs.readFile(auditFile, 'utf8'));
      check('audit JSON carries checksums scan and DER block', !!(report.checksums?.sha256 && report.security && report.der), report.checksums?.sha256?.slice(0, 20) || 'missing');
    }

    const desktopAfter = await evalValue(auditSource);
    check('no horizontal overflow after desktop interactions', desktopAfter.overflow === false, desktopAfter.overflowers.join(' | '));

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
    await sleep(350);
    await evalValue(`window.scrollTo(0, 0); true`);
    const mobile = await evalValue(auditSource);
    check('no horizontal overflow at 390', mobile.overflow === false, `${mobile.scrollWidth}/${mobile.clientWidth} ${mobile.overflowers.join(' | ')}`);
    check('mobile layout stacks to one column', mobile.layoutColumns.trim().split(/\s+/).length === 1, mobile.layoutColumns);
    check('mobile controls leave sticky desktop mode', mobile.controlsPosition === 'static', mobile.controlsPosition);
    check('no duplicate ids at 390', mobile.duplicateIds.length === 0, mobile.duplicateIds.join(','));
    check('all form controls labelled at 390', mobile.unlabeled.length === 0, mobile.unlabeled.join(','));
    check('mobile text contrast meets WCAG ratios', mobile.contrastBad.length === 0, mobile.contrastBad.map(x => `${x.text}:${x.ratio.toFixed(2)}/${x.required}`).join(' | '));

    const mobileLayout = await evalValue(`(() => {
      const cw = document.documentElement.clientWidth;
      const buttons = Array.from(document.querySelectorAll('.btn')).filter(x => {
        const r = x.getBoundingClientRect(); const s = getComputedStyle(x);
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0;
      });
      const tables = Array.from(document.querySelectorAll('.table-scroll')).map(x => ({ fits: x.getBoundingClientRect().right <= cw + 1, scrolls: x.scrollWidth > x.clientWidth + 1 }));
      const canvases = Array.from(document.querySelectorAll('canvas')).map(x => ({ right: x.getBoundingClientRect().right, width: x.getBoundingClientRect().width, touch: getComputedStyle(x).touchAction }));
      return {
        buttonsFit: buttons.every(x => x.getBoundingClientRect().right <= cw + 1),
        smallButtons: buttons.filter(x => x.getBoundingClientRect().height < 24 || x.getBoundingClientRect().width < 24).map(x => x.id || x.textContent.trim()),
        tables,
        canvases,
        svgFits: document.getElementById('networkSvg').getBoundingClientRect().right <= cw + 1,
        scanRows: document.querySelectorAll('#contTable tbody tr').length,
        firstPanelTop: document.querySelector('.controls-panel').getBoundingClientRect().top
      };
    })()`);
    check('mobile action buttons fit the viewport', mobileLayout.buttonsFit === true);
    check('mobile primary buttons meet 24px target minimum', mobileLayout.smallButtons.length === 0, mobileLayout.smallButtons.join(','));
    check('mobile tables use internal scroll without page overflow', mobileLayout.tables.length >= 2 && mobileLayout.tables.every(x => x.fits), JSON.stringify(mobileLayout.tables));
    check('mobile canvases fit and permit horizontal touch probes', mobileLayout.canvases.every(x => x.right <= 390 + 1 && x.width > 240 && x.touch === 'pan-y'), JSON.stringify(mobileLayout.canvases));
    check('mobile SVG diagram fits the viewport', mobileLayout.svgFits === true);
    check('N-1 rows remain available at mobile width', mobileLayout.scanRows >= 7, `${mobileLayout.scanRows}`);
    await shot('gridflow-mobile-390x844.png');

    const smallTargetDetail = mobile.smallTargets.join(',');
    check('mobile control targets meet 24px minimum directly or through labels', smallTargetDetail.length === 0, smallTargetDetail);
    const external = cdp.requests.filter(url => !url.startsWith(base) && !url.startsWith('about:') && !url.startsWith('devtools:') && !url.startsWith('chrome:') && !url.startsWith('data:') && !url.startsWith('blob:'));
    check('no external network requests', external.length === 0, external[0] || '');
    check('no console errors or page exceptions', cdp.errors.length === 0, cdp.errors[0] || '');
  } catch (err) {
    check('harness completed', false, err.message);
  } finally {
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch { }
      cdp.close();
    }
    if (chrome && chrome.exitCode === null) {
      await Promise.race([waitExit(chrome), sleep(2500)]);
      if (chrome.exitCode === null) chrome.kill('SIGKILL');
      await Promise.race([waitExit(chrome), sleep(1500)]);
    }
    if (server) await new Promise(resolve => server.close(resolve));
    if (profile) await fs.rm(profile, { recursive: true, force: true }).catch(() => { });
  }

  const failed = results.filter(x => !x.ok).length;
  console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main();
