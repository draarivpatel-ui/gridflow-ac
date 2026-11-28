# Security policy

## Reporting a vulnerability

Use the private GitHub Security Advisory form at [Report a vulnerability](https://github.com/draarivpatel-ui/gridflow-ac/security/advisories/new). Do not open a public issue, pull request or discussion with exploit details.

Never include a live secret, token, cookie, private key, victim hostname or proprietary payload in a report. Use synthetic values and redacted transcripts.

## Supported versions

| Version | Status |
| --- | --- |
| latest `main` | Supported |

Security fixes are applied to the latest state of the default branch.

## Scope

This policy covers the static GridFlow AC browser application and its Node test harnesses, including power-flow solving, DER and Volt-VAR controls, N-1 audit output, imported case data, generated reports and URL or file based state handling.

In scope:

- A cross-site scripting or HTML injection path through bus names, component labels, imported case text, audit output or rendered report content.
- A parser or validation bypass that loads malformed power-system data outside the documented bounds and corrupts solver state.
- A solver, control or audit logic flaw that causes attacker-controlled input to execute script, formula content or unexpected command text downstream.
- A generated CSV, JSON or report export flaw that makes the output execute a formula or script when opened.
- A checksum, audit or determinism verification bypass that makes altered output validate as untampered.

Out of scope:

- Browser vulnerabilities, operating system compromise or physical access to the machine.
- Damage caused by modified copies of the static application that do not come from this repository.
- Engineering accuracy of a user-selected study case without a security impact.
- Denial of service that only affects the attacker's own browser tab.

## Coordinated disclosure

- Acknowledgment: within 3 business days.
- Initial triage: within 14 calendar days.
- Fix or mitigation target: within 90 calendar days for confirmed reports.
- Coordinated public disclosure: up to 90 days by default, adjusted by mutual agreement when exploitation or user risk requires a different date.
