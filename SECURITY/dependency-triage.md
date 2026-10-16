# Dependency vulnerability triage — 2026-10-16

Triage of the 511 open Dependabot alerts on `team-idswyft/idswyft`. The headline
count overstates the exposure. This document records what ships, what is
reachable, and what to do about it.

## Summary

- **No active, reachable critical vulnerability.** The one critical (`proxy-addr`)
  is not on the code path, because `server.ts:53` sets `trust proxy` to `1`.
- **The 511 is inflated ~10x.** Dependabot scans six manifests. None of them
  governs production. The same advisory is counted once per manifest.
- **The only genuinely exploitable residual is the libvips JPEG/PNG path in
  `sharp`.** The `sharp` 0.34 -> 0.35.5 bump (commit `d78f8ed`) closes it.
- **Most other runtime advisories patch themselves on the next image build.**
  Both Dockerfiles run `npm install` against caret ranges with no lockfile, so
  in-range fixes land automatically.

## How production resolves dependencies

`backend/Dockerfile` and `engine/Dockerfile` copy only `package.json` files, then
run `npm install --include=optional`. They do not copy any `package-lock.json`.
CI (`.github/workflows/ci.yml`) also runs `npm install`, not `npm ci`, on Node 20.

Consequences:

- The lockfiles Dependabot scans govern neither Docker nor CI.
- Any fix inside an existing caret range lands on the next build with no code
  change.
- A fix outside the current range (a major bump) needs a `package.json` change.
- Version drift within a range is possible between builds. The `@zxing/library`
  incident (v1.12.33) came from this same mechanism.

## The 511, by manifest

| Manifest | Open alerts | Ships to production? |
|---|---|---|
| `backend/package-lock.json` | 148 | No |
| `package-lock.json` (root) | 142 | No |
| `frontend/package-lock.json` | 109 | No (static browser bundle) |
| `sdks/javascript/package-lock.json` | 75 | No (published SDK) |
| `engine/package-lock.json` | 31 | No |
| `community-overrides/frontend/package.json` | 6 | No |

The deployed surface is the production `dependencies` of `backend` and `engine`,
resolved fresh at build time. An `npm audit --omit=dev` run reports 17 distinct
advisories for `backend` and 18 for `engine`, with heavy overlap (shared
`express`, `sharp`, `image-size`). The browser bundle reports 6.

## Reachability

The attack surface is untrusted image uploads and outbound webhooks. Severity
labels alone do not reflect exposure here.

| Advisory | Severity | Reachable | Reason |
|---|---|---|---|
| `proxy-addr` IP spoof | critical | No | `trust proxy` is `1` (hop count). The bug lives in the subnet-trust path, which `1` never invokes. |
| `sharp` libheif / librsvg | high | No | `fileValidation.ts` allows only `jpeg`/`png`/`pdf` and checks magic bytes. HEIF and SVG are rejected before `sharp` runs. |
| `sharp` libvips (JPEG/PNG) | high | Partial | A malicious JPEG or PNG still reaches libvips. Fixed by `sharp` 0.35.5 (commit `d78f8ed`). |
| `image-size` JXL/ICNS/HEIF loop | high | No | The allowlist blocks every format with a vulnerable parser. |
| `axios` SSRF / redirect | high | Mitigated | `webhook.ts:275,346` sets `maxRedirects: 0`. Backend uses the Node HTTP adapter, not the fetch adapter the advisory targets. |
| `form-data` CRLF via filename | high | Low | `req.file.originalname` reaches the engine as a multipart filename. The fix is in range and lands on rebuild. |
| `adm-zip`, `dompurify` | high / mod | No | Neither is imported in source. The app does not extract untrusted ZIPs or sanitize HTML with DOMPurify. |
| frontend `axios` node adapters, `react-router` RSC/SSR | high | No | The frontend is a Vite single-page app. The Node adapters and RSC/SSR code paths do not exist in the browser bundle. |

## The `npm audit fix --force` trap

Do not run `npm audit fix --force`. `npm audit` suggests `@tensorflow/tfjs@2.1.0`
as the fix for the engine `tfjs` chain. The engine runs `^4.22.0`, so that
"fix" is a downgrade that breaks `face-api` liveness. The `tfjs`, `argparse`, and
`sprintf-js` advisories have no valid forward fix. Their real risk (the
`sprintf-js` precision denial of service) is not reachable in ML inference.
Leave them.

## Actions

### Done

- `sharp` 0.34 -> 0.35.5 in `backend` and `engine` (commit `d78f8ed`, staged on
  `dev`). Closes the libvips residual. Uses only stable `sharp` APIs, so no code
  change. Node requirement `>=20.9.0` is met by production Node 20.20.
- `storage.ts` now preserves the error `cause` on storage-write failures (commit
  `c35c243`). Unrelated to this triage, but it improves the diagnosability of the
  `storeInSupabase` path that surfaced as Sentry `NODE-EXPRESS-C`.

### Recommended, not yet done

- **Opportunistic major bumps, low urgency.** Each needs its own tested change,
  because each carries API changes:
  - `jimp` 0.22 -> 1.6 (engine)
  - `node-cron` 3 -> 4 (backend)
  - `uuid` 9 -> 14 (backend). Current use does not pass a `buf` argument, so the
    advisory does not apply today.
- **Reduce the Dependabot count.** The count reflects lockfile contents, not
  `dependabot.yml`, which controls version-update pull requests rather than
  security alerts. Two options:
  - Refresh the lockfiles (`npm install` per manifest on Node 20) so in-range
    fixes clear their alerts. This is cosmetic, because the lockfiles do not
    ship.
  - Dismiss the stale alerts in the repository Security tab.

### Leave as-is

- The `tfjs` / `argparse` / `sprintf-js` chain (no forward fix).
- The frontend browser-bundle advisories (not reachable in a Vite SPA).
- The CI `npm audit` gate.

## Verification note

This triage ran `npm audit` against each manifest. The `sharp` bump is not
verified by a local install. This machine's npm 9.2.0 crashes on `npm install`
for the whole workspace (`calc-dep-flags` arborist bug), and the crash reproduces
at `sharp` 0.34.5, so it is unrelated to the bump. CI runs `npm install` plus the
`vitest` suite on Node 20 (npm 10) on every push to `dev`, which validates the
change.
