/**
 * GridFlow AC repository hygiene: security metadata, offline guarantees,
 * punctuation rules and shipped-file requirements.
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));

const SHIPPED = ['index.html', 'style.css', 'app.js', 'src/gridflow.cjs',
  'dom-harness.cjs', 'ui.test.cjs', 'test/gridflow.test.cjs',
  'test/numerics.test.cjs', 'test/hygiene.test.cjs',
  'package.json', 'README.md', 'LICENSE', '.gitignore'];

describe('security metadata and offline guarantees', () => {
  test('index.html carries a restrictive Content-Security-Policy', () => {
    const html = read('index.html');
    const m = html.match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]*>/i);
    assert.ok(m, 'CSP meta tag missing');
    const tag = m[0].toLowerCase();
    /* frame-ancestors is deliberately absent: browsers ignore it inside a
       meta element and log an error, so it only belongs in a real header. */
    assert.ok(!tag.includes('frame-ancestors'), 'frame-ancestors must not sit in a meta CSP');
    for (const directive of ['default-src', 'script-src', 'connect-src', 'object-src', 'base-uri', 'form-action']) {
      assert.ok(tag.includes(directive), 'CSP missing ' + directive);
    }
    assert.ok(tag.includes("connect-src 'none'"), 'page must not make network connections');
    assert.ok(tag.includes("script-src 'self'"), 'scripts restricted to same origin');
    assert.ok(!tag.includes('unsafe-eval'), 'no unsafe-eval');
    assert.ok(!tag.includes('unsafe-inline') || tag.indexOf('unsafe-inline') > tag.indexOf('style-src'), 'unsafe-inline only for styles if present');
  });

  test('index.html carries a Permissions-Policy', () => {
    const html = read('index.html');
    const m = html.match(/<meta[^>]+http-equiv="Permissions-Policy"[^>]*>/i);
    assert.ok(m, 'Permissions-Policy meta tag missing');
    const tag = m[0].toLowerCase();
    for (const feat of ['geolocation', 'camera', 'microphone', 'payment', 'usb']) {
      assert.ok(tag.includes(feat + '=()'), 'Permissions-Policy missing ' + feat);
    }
  });

  test('no external URLs, scripts, styles, fonts or iframes are referenced', () => {
    const html = read('index.html');
    assert.doesNotMatch(html, /https?:\/\//, 'absolute URL in markup');
    assert.doesNotMatch(html, /src=["']\/\//, 'protocol-relative URL');
    assert.doesNotMatch(html, /<link[^>]+stylesheet[^>]+href=["'](?!style\.css)/i, 'external stylesheet');
    assert.doesNotMatch(html, /<iframe/i, 'iframe embed');
    const css = read('style.css');
    assert.doesNotMatch(css, /@import|url\(/i, 'stylesheet imports or remote assets');
  });

  test('scripts execute no remote code and use no risky sinks', () => {
    for (const f of ['app.js', 'src/gridflow.cjs']) {
      const src = read(f);
      assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|WebSocket|EventSource/, f + ' makes a network call');
      assert.doesNotMatch(src, /\beval\s*\(|new Function/, f + ' uses dynamic code execution');
      assert.doesNotMatch(src, /\.innerHTML\s*=[^=]/, f + ' writes innerHTML');
      assert.doesNotMatch(src, /document\.write/, f + ' uses document.write');
      assert.doesNotMatch(src, /localStorage\.(getItem|setItem)\([^)]*(pd|qd|network|solution)/i, f + ' persists network data');
    }
  });

  test('app.js makes no assumptions that leak secrets into exports', () => {
    const src = read('app.js');
    assert.doesNotMatch(src, /api[_-]?key|token|password|secret/i);
  });
});

describe('punctuation and wording rules', () => {
  const EM = String.fromCharCode(0x2014), EN = String.fromCharCode(0x2013);
  for (const f of SHIPPED) {
    test(f + ' contains no em or en dashes', () => {
      const text = read(f);
      assert.ok(!text.includes(EM), 'em dash found in ' + f);
      assert.ok(!text.includes(EN), 'en dash found in ' + f);
    });
  }

  test('no model or vendor attribution strings in shipped files', () => {
    const pat = new RegExp(['claude', 'chatgpt', 'openai', 'llm', 'gpt-[0-9]', 'anthropic', 'devin'].join('|'), 'i');
    for (const f of SHIPPED) {
      if (f === 'test/hygiene.test.cjs') continue; // this file is the scanner
      assert.doesNotMatch(read(f), pat, f + ' mentions a model or vendor');
    }
  });

  test('no smooth scrolling behavior anywhere', () => {
    for (const f of SHIPPED) {
      assert.doesNotMatch(read(f), /scroll-behavior:\s*smooth/i, f);
    }
  });

  test('the title stands alone: no kicker above it, no tagline under it', () => {
    const html = read('index.html');
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    assert.ok(h1, 'h1 missing');
    assert.doesNotMatch(html, /class=["'][^"']*(tagline|subtitle|kicker|eyebrow|lede|panel-tag)/i, 'tagline or kicker element present');
    const brand = html.match(/<div class="brand">([\s\S]*?)<\/div>\s*<\/div>/i);
    assert.ok(brand, 'brand block missing');
    const inner = brand[1].replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, '').replace(/aria-hidden="true">[^<]*</, 'aria-hidden="true"><');
    assert.doesNotMatch(inner, />[^<>\s][^<>]*</, 'extra copy beside the title in the brand block');
  });
});

describe('shipped repository files', () => {
  test('LICENSE exists, is MIT and matches package.json', () => {
    assert.ok(exists('LICENSE'));
    assert.match(read('LICENSE'), /MIT License/);
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.license, 'MIT');
  });

  test('README documents offline use, synthetic data and the test command', () => {
    const md = read('README.md');
    assert.match(md, /index\.html/);
    assert.match(md, /no build step|no network request/i);
    assert.match(md, /synthetic/i);
    assert.match(md, /npm test|node --test/);
  });

  test('.nojekyll exists so Pages serves the tree as-is', () => {
    assert.ok(exists('.nojekyll'));
  });

  test('.gitignore excludes build and OS noise', () => {
    const gi = read('.gitignore');
    assert.match(gi, /node_modules/);
    assert.match(gi, /DS_Store/);
  });

  test('every HTML id is unique and every labelled control resolves', () => {
    const html = read('index.html');
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'duplicate ids');
    for (const m of html.matchAll(/for="([^"]+)"/g)) {
      assert.ok(ids.includes(m[1]), 'label for=' + m[1] + ' has no matching control');
    }
  });

  test('skip link target exists and is focusable', () => {
    const html = read('index.html');
    const skip = html.match(/<a\b(?=[^>]*class="[^"]*skip[^"]*")(?=[^>]*href="#([^"]+)")[^>]*>/i);
    assert.ok(skip, 'skip link missing');
    const target = html.match(new RegExp('id="' + skip[1] + '"[^>]*>'));
    assert.ok(target, 'skip target missing');
    assert.match(target[0], /tabindex="-1"/, 'skip target needs tabindex=-1 to receive focus');
  });

  test('ARIA live regions and labelled canvases are present', () => {
    const html = read('index.html');
    assert.ok((html.match(/aria-live/g) || []).length >= 3, 'expected several live regions');
    assert.match(html, /role="alert"/);
    const canvases = [...html.matchAll(/<canvas[^>]*>/g)].map(m => m[0]);
    assert.ok(canvases.length >= 3);
    for (const c of canvases) {
      assert.match(c, /role="img"/, 'canvas missing role=img');
      assert.match(c, /aria-label|aria-labelledby/, 'canvas missing accessible name');
      assert.match(c, /tabindex="0"/, 'canvas must be keyboard focusable for probes');
    }
  });
});
