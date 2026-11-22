# GridFlow AC

A self-contained, zero-dependency AC power-flow workbench: damped Newton-Raphson solver, reactive-limit PV to PQ switching, DC approximation, branch flows and losses, N-1 contingency screening and local CSV/JSON exports. Every network is a synthetic teaching benchmark, not a published IEEE test system or measured grid data.

**Live demo:** [https://aariv.me/gridflow-ac/](https://aariv.me/gridflow-ac/)

## Quick start

Open `index.html` in any modern browser. There is no build step, no package install, no server and no network request. The engine `src/gridflow.cjs` is a plain browser script that also loads under Node as CommonJS, so the test suite executes the exact solver the page uses.

```sh
npm test
# or
node --test --test-reporter=spec test/gridflow.test.cjs ui.test.cjs
```

Node 22 or newer is required for `node --test`. The browser needs no specific Node version.

## What is inside

| Path | Purpose |
| --- | --- |
| `index.html` | Responsive workbench: controls, SVG one-line diagram, three numeric canvases, result tables and export buttons |
| `style.css` | Dark and light themes, sticky controls, focus rings, reduced-motion and mobile rules |
| `app.js` | Browser wiring, canvas and SVG renderers, probes, exports, theme and guide toggles |
| `src/gridflow.cjs` | The solver: Ybus, damped Newton-Raphson, Q-limit switching, DC flow, branch flows, diagnostics, N-1 screening, exporters |
| `test/gridflow.test.cjs` | Numerical, physics, edge-case, contingency and exporter tests |
| `test/numerics.test.cjs` | Finite-difference Jacobian verification, Newton update semantics and reactive-limit tests |
| `test/hygiene.test.cjs` | Repository hygiene: CSP, punctuation, offline guarantees, license |
| `ui.test.cjs` | Deterministic DOM/canvas interaction tests driven by `dom-harness.cjs` |
| `dom-harness.cjs` | Tiny dependency-free DOM, SVG, canvas and download double used only by tests |

## Engine pipeline

1. `normalizeNetwork` validates buses, branches, ratings and optional PV reactive limits.
2. `buildYbus` assembles the complex admittance matrix in real G/B form with half line charging at each end.
3. `newtonCore` runs the damped Newton loop: analytic four-block Jacobian, Gaussian elimination with partial pivoting, and a backtracking line search that never accepts a step which increases the maximum mismatch.
4. The N and L blocks are the V-scaled partials `V * d/dV`, so the solved correction is the relative step `dV/V` and the voltage update is multiplicative.
5. After each converged solve, PV buses whose required reactive output violates `qMin`/`qMax` are switched to PQ at the violated limit and the flow is re-solved, hot-started from the last state.
6. `diagnostics` aggregates generation, load, losses, balance error, branch loadings, overloads and voltage violations. A failed solve reports `converged: false` with a reason; diagnostics stay null rather than fabricating values.
7. `contingencyAnalysis` re-solves the full AC flow once per in-service branch outage.
8. Exporters emit bus, branch, convergence and N-1 CSV plus a full JSON experiment snapshot with the real solver residual history.

## Solver honesty

- The Jacobian is verified against central finite differences of the injection functions in `test/numerics.test.cjs`.
- The voltage-collapse preset honestly fails: the solver reports non-convergence and the page labels the last iterate as such, never as an operating point.
- Singular Jacobians, iteration-limit exhaustion and unresolvable Newton steps all produce `converged: false` with a specific reason, never an exception swallowed into fake numbers.
- Q-limit switching is deterministic: every violator is switched per pass, results record the required Q and the applied limit per bus.

## Accessibility and responsive layout

- Every canvas is keyboard focusable with arrow-key probes, and each has `role="img"` plus a text readout that publishes the same numbers in words.
- ARIA live regions announce readouts, the status line and the N-1 summary; the error banner uses `role="alert"`.
- Focus-visible outlines, a skip link, labelled controls, `prefers-reduced-motion` support and dark/light themes are included.
- Below 980 px the layout stacks to a single column and the controls panel stops being sticky.

## Security

- A Content-Security-Policy meta tag restricts the page to same-origin scripts and styles, forbids connections, objects, forms and framing.
- A Permissions-Policy meta tag disables geolocation, camera, microphone, payment and USB.
- The page sets no cookies and makes no requests; `localStorage` is used only for the theme preference and is wrapped so private-mode failures are harmless.
- All rendered text goes through `textContent` or static markup; no user-supplied string reaches an HTML sink.

## Exports

- `gridflow-ac-experiment.json` records the normalized network, the full solution (including `reason`, `history` and `qLimited`), diagnostics and branch flows.
- `gridflow_buses.csv` and `gridflow_branches.csv` hold per-unit results; `gridflow_convergence.csv` holds the true residual per Newton iteration; `gridflow_n1.csv` holds the N-1 screen.
- Export fields are CSV-quoted when they can contain separators, and nonfinite values are encoded as JSON `null` rather than the literal `Infinity`.

## Licence

MIT. See `LICENSE`. No third-party runtime dependencies and no external assets.
