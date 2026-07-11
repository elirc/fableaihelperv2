# CueDeck security model

## Reporting

Open a GitHub issue marked `security` (or contact the maintainer privately if the repository
lists a contact). Please do not include credentials or personal transcripts in reports.

## Controls (release gates, tested where software-controllable)

| Control                                                                             | Where                                               | Verified by                                 |
| ----------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| Renderer sandbox, context isolation, no Node integration                            | `src/main/windows/windows.ts`                       | E2E: no `require`/`process`/raw IPC in page |
| Fixed, typed preload API (no channel names, no event objects)                       | `src/preload/preload.ts`                            | E2E surface check                           |
| IPC sender-frame validation + Zod payload validation on every method                | `src/main/ipc/register.ts`, `src/shared/schemas.ts` | unit + integration                          |
| One-use, expiring capture grant; unarmed `getDisplayMedia` denied                   | `src/main/security/captureGrant.ts`, `main.ts`      | unit + E2E                                  |
| No `setContentProtection`, no capture exclusion, no hidden recording                | absent by design; persistent recording indicator    | E2E + code review                           |
| CSP from `default-src 'none'` (strict when packaged)                                | `src/main/security/windowSecurity.ts`               | code + manual                               |
| Navigation denial, window-creation denial, webview denial                           | same                                                | E2E                                         |
| `shell.openExternal` restricted to a hardcoded HTTPS allowlist                      | `src/main/security/urlPolicy.ts`                    | unit                                        |
| Outbound HTTP host allowlist in the privileged process                              | `src/main/security/http.ts`                         | unit + integration                          |
| Credentials encrypted with `safeStorage` (DPAPI), write-only from the UI            | `src/main/settings/secretVault.ts`                  | unit + E2E                                  |
| Secret redaction in diagnostics/logs                                                | `src/shared/redact.ts`, `src/main/diagnostics.ts`   | unit                                        |
| Electron fuses (no RunAsNode, no NODE_OPTIONS, asar integrity, onlyLoadAppFromAsar) | `forge.config.ts`                                   | packaged build                              |
| Structured public errors; no stack traces or provider bodies to the UI              | `src/shared/errors.ts`                              | integration                                 |

## Dependency policy

- Pin via `package-lock.json`; use currently supported stable Electron.
- `npm audit` reviewed each release; high/critical runtime or packaging advisories block release
  unless an explicit, expiring exception is documented.
- Renderer loads no remote code; all assets are bundled.

## Known limitations

- Release artifacts are unsigned (no funded signing certificate); SHA-256 checksums are
  published instead and SmartScreen warnings are expected.
- `safeStorage` on Windows protects secrets per OS user account; any process running as the
  same user could decrypt them. Do not store keys on shared accounts.
