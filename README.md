# GridFlow AC

A self-contained, zero-dependency AC power-flow workbench: damped Newton-Raphson solver, reactive-limit PV to PQ switching, DC approximation, branch flows and losses, a ranked N-1 security scanner, a Solar PV + battery Volt-VAR optimizer, deterministic audit exports and local CSV/JSON downloads. Every network is a synthetic teaching benchmark, not a published IEEE test system or measured grid data.

**Live demo:** [https://aariv.me/gridflow-ac/](https://aariv.me/gridflow-ac/)

## Quick start

Open `index.html` in any modern browser. There is no build step, no package install, no server and no network request. The engine `src/gridflow.cjs` is a plain browser script that also loads under Node as CommonJS, so the test suite executes the exact solver the page uses.

```sh
npm test
# 316 tests, 0 failures
```

Node 22 or newer is required for `node --test`. The browser needs no specific Node version.

## What is inside

| Path | Purpose |
| --- | --- |
| `index.html` | Responsive workbench: controls, SVG one-line diagram, three numeric canvases, N-1 scanner table, DER panel, audit and self-test panels, export buttons |
| `style.css` | Dark and light themes, sticky controls, focus rings, reduced-motion and mobile rules |
| `app.js` | Browser wiring, canvas and SVG renderers, probes, scanner sorting and outage preview, DER controls, exports, theme and guide toggles |
| `src/gridflow.cjs` | The solver: Ybus, damped Newton-Raphson, Q-limit switching, DC flow, branch flows, diagnostics, N-1 security scan, Volt-VAR DER solve, checksums, exporters |
| `test/gridflow.test.cjs` | Numerical, physics, edge-case, contingency and exporter tests |
| `test/numerics.test.cjs` | Finite-difference Jacobian verification, Newton update semantics and reactive-limit tests |
| `test/security.test.cjs` | Ranked N-1 scanner: violations, overloads, severity ordering, determinism |
| `test/der.test.cjs` | Volt-VAR droop law, fixed-point equilibrium, DER impact accounting |
| `test/audit.test.cjs` | FNV-1a/SHA-256 checksums, audit JSON/CSV, in-page self-test battery |
| `test/hygiene.test.cjs` | Repository hygiene: CSP, punctuation, offline guarantees, license |
| `ui.test.cjs` | Deterministic DOM/canvas interaction tests driven by `dom-harness.cjs` |
| `ui2.test.cjs` | Scanner, click-preview, DER controls, audit exports and self-test UI tests |
| `dom-harness.cjs` | Tiny dependency-free DOM, SVG, canvas and download double used only by tests |
| `browser-check.cjs` | Dependency-free headless-Chrome audit of the live page at 1440x900 and 390x844 |

## Engine pipeline

1. `normalizeNetwork` validates buses, branches, ratings and optional PV reactive limits.
2. `buildYbus` assembles the complex admittance matrix in real G/B form with half line charging at each end.
3. `newtonCore` runs the damped Newton loop: analytic four-block Jacobian, Gaussian elimination with partial pivoting, and a backtracking line search that never accepts a step which increases the maximum mismatch.
4. The N and L blocks are the V-scaled partials `V * d/dV`, so the solved correction is the relative step `dV/V` and the voltage update is multiplicative.
5. After each converged solve, PV buses whose required reactive output violates `qMin`/`qMax` are switched to PQ at the violated limit and the flow is re-solved, hot-started from the last state.
6. `diagnostics` aggregates generation, load, losses, balance error, branch loadings, overloads and voltage violations. A failed solve reports `converged: false` with a reason; diagnostics stay null rather than fabricating values.
7. `securityScan` trips every in-service branch one at a time and re-solves the full AC flow. Each contingency is scored for severity (band excursion plus overloads; non-convergence tops the scale), ranked deterministically, and reported with the violated bus ids, overloaded branch ids and real iteration counts.
8. `solveWithDER` attaches a Solar PV + battery resource to one PQ bus. Real power enters the bus schedule directly; inverter Q follows an IEEE-1547-style Volt-VAR droop (deadband, gain, cap). The droop equilibrium is found by deterministic bisection on `droopQ(v(q)) - q = 0`, which cannot oscillate the way a naive Q-chasing iteration does on a steep gain.
9. `derImpact` measures what the resource bought: voltage-floor recovery, secure-band violations and overloads cleared, loss change, plus labeled scenario estimates for peak-shaved MWh and displaced CO2e over a configurable peak window.
10. Exporters emit bus, branch, convergence and N-1 CSV, a full JSON experiment snapshot, and a deterministic audit report stamped with FNV-1a-64 and SHA-256 checksums computed over the exact report payload.

## N-1 security scanner

- One click trips every in-service line and runs a complete Newton-Raphson re-solve per outage.
- The table ranks contingencies by severity and can be re-sorted by rank, outage, solve status, max loading, overload count, violation count or severity.
- Clicking a row previews that outage on the live one-line diagram: the tripped branch is drawn dashed with an `OUT` tag and the buses it violates are highlighted, while the readout names them.
- Non-convergent contingencies are shown honestly (`NO` in the solved column, severity 1000) rather than hidden or smoothed over, so a radial feeder correctly reports every outage as critical.

## Solar PV + battery Volt-VAR optimizer

- Enable DER, pick a PQ host bus, then tune solar output, battery discharge/charge, inverter Q capacity, droop gain and deadband.
- The panel reports minimum voltage before and after, secure-band violations cleared, applied inverter Q, and labeled scenario estimates for peak-shaved MWh and displaced CO2e.
- With DER enabled, the N-1 scan re-solves every outage through the same droop loop, so the scanner shows which violations storage actually removes.
- A PV bus cannot host reactive support (its voltage is already held); the host selector lists PQ buses only.

## Deterministic audit report

- `gridflow-ac-audit.json` bundles the operating point, per-bus and per-branch results, the full ranked security scan, the DER block, and FNV-1a-64 + SHA-256 checksums of the payload. Identical inputs produce a byte-identical report.
- `gridflow-ac-n1-audit.csv` is the ranked contingency table with violated buses and overloaded branches per outage.
- The in-page `Run self-tests` button executes six real checks against the live solver: Kirchhoff power balance `|sum(Pgen) - sum(Pload) - Ploss| < 1e-6`, N-1 ranking determinism, Volt-VAR droop stabilization, checksum vectors, collapse honesty and thermal overload detection.

## Solver honesty

- The Jacobian is verified against central finite differences of the injection functions in `test/numerics.test.cjs`.
- The voltage-collapse preset honestly fails: the solver reports non-convergence and the page labels the last iterate as such, never as an operating point.
- Singular Jacobians, iteration-limit exhaustion and unresolvable Newton steps all produce `converged: false` with a specific reason, never an exception swallowed into fake numbers.
- Q-limit switching is deterministic: every violator is switched per pass, results record the required Q and the applied limit per bus.
- A DER solve that cannot settle its droop fixed point reports `settled: false`; a failed assisted solve reports null impact metrics instead of fabricating savings.

## Accessibility and responsive layout

- Every canvas is keyboard focusable with arrow-key probes, and each has `role="img"` plus a text readout that publishes the same numbers in words.
- ARIA live regions announce readouts, the status line, the N-1 summary and the outage preview; sortable headers publish `aria-sort`; the error banner uses `role="alert"`.
- Focus-visible outlines, a skip link, labelled controls, `prefers-reduced-motion` support and dark/light themes are included.
- Below 980 px the layout stacks to a single column and the controls panel stops being sticky.

## Security

- A Content-Security-Policy meta tag restricts the page to same-origin scripts and styles, forbids connections, objects, forms and framing.
- A Permissions-Policy meta tag disables geolocation, camera, microphone, payment and USB.
- The page sets no cookies and makes no requests; `localStorage` is used only for the theme preference and is wrapped so private-mode failures are harmless.
- All rendered text goes through `textContent` or static markup; no user-supplied string reaches an HTML sink.
- Checksums are computed locally in pure JavaScript (FNV-1a over a WHATWG-conformant UTF-8 encoder, and a self-contained SHA-256), so audit digests match byte-for-byte in Node and in the browser.

## Exports

- `gridflow-ac-experiment.json` records the normalized network, the full solution (including `reason`, `history` and `qLimited`), diagnostics and branch flows.
- `gridflow_buses.csv` and `gridflow_branches.csv` hold per-unit results; `gridflow_convergence.csv` holds the true residual per Newton iteration; `gridflow_n1.csv` holds the N-1 screen.
- `gridflow-ac-audit.json` is the checksum-stamped security audit; `gridflow-ac-n1-audit.csv` is its ranked contingency table.
- Export fields are CSV-quoted when they can contain separators, formula-leading values are guarded, and nonfinite values are encoded as JSON `null` rather than the literal `Infinity`.

## Verification

- `npm test` runs 316 tests (44 suites) over the real engine and the real page scripts, all passing with zero failures.
- `npm run test:browser` runs 54 dependency-free headless-Chrome checks at 1440x900 and 390x844. It exercises the N-1 scan, contingency click-preview, DER Volt-VAR controls, keyboard probes, theme contrast, audit export and self-test battery with 0 console errors, 0 uncaught page errors, 0 external network requests and 0 horizontal overflow. The checker uses an ephemeral local server port, an ephemeral DevTools port and a disposable browser profile.

## Licence

MIT. See `LICENSE`. No third-party runtime dependencies and no external assets.
