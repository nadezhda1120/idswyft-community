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
  `sharp`.** The `sharp` 0.34 -> 0.35.5 bump (commit `d78f8ed`) is staged on
  `dev` and closes it. Production still runs `sharp` 0.34.5 until the next
  deploy, so the window is open until then.
- **Most other runtime advisories patch themselves on each image build, and
  many are likely already live.** Both Dockerfiles run `npm install` against
  caret ranges with no lockfile. The most recent build (v1.12.36) resolved
  dependencies fresh, so in-range fixes released before that date already ship.

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
| `sdks/javascript/package-lock.json` | 75 | No to the production service; yes, published to customers via npm |
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
| `sharp` libvips (JPEG/PNG) | high | Partial | A malicious JPEG or PNG still reaches libvips. Fixed by `sharp` 0.35.5 (commit `d78f8ed`), staged on `dev`, not yet deployed. |
| `image-size` JXL/ICNS/HEIF loop | high | No | The allowlist blocks every format with a vulnerable parser. |

The "No" verdicts above depend on `validateFileType` running before `sharp` or
`image-size` touches the buffer. That is verified for the three v2 verify upload
routes (`newVerification.ts:1157`, `:1486`, `:1713`) and address verification
(`addressVerification.ts:63`). The API-key `batch.ts` path is not separately
verified.
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
  - `uuid` 9 -> 14 (backend). Source never passes a `buf` argument (verified by
    grep), so the advisory does not apply today.
- **SDK advisories reach customers.** `npm audit --omit=dev` in
  `sdks/javascript` reports 2 high-severity production advisories. The published
  SDK ships them to every consumer. Triage and patch these on their own track.
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

## Verification

What CI verified on push `df4d219` (`ubuntu-latest`, Node 20):

- `npm install` resolved `sharp` 0.35.5 cleanly for the backend workspace.
- `tsc --noEmit` passed for shared, backend, frontend, and engine.
- The backend `vitest` suite passed. It loads real `sharp`, including
  `sharpTamperDetector.test.ts` and `imagePreprocessor.test.ts`, so the
  ELA/entropy tamper path ran under 0.35.5 and its assertions held.

What remains unverified:

- The engine has no test script, so its `sharp` path (`engine/src/routes/extract.ts`)
  is untested by CI.
- CI runs on `ubuntu-latest`, not the Debian 12 `node:20-slim` runtime image.
- A local install could not confirm any of this. This machine's `npm install`
  crashes for the whole workspace (`calc-dep-flags` arborist error). The crash
  reproduces at the unmodified `sharp` 0.34.5, so it is a pre-existing
  local-environment problem, not the bump. The cause is not fully established.

Pre-deploy gates for the `sharp` bump:

- Build both images with `docker-compose.build.yml` and run
  `node -e "require('sharp')"` inside each. Railway deploys from `main`, and the
  Docker image CI runs only on `v*` tags, so neither catches a native-load
  failure on the runtime base before deploy.
- Run the tamper path on `backend/scripts/benchmark/specimens` under 0.34.5 and
  0.35.5 inside a `node:20` container. A libvips change can shift ELA, entropy,
  and FFT scores. The gates use fixed thresholds, so a case near a boundary can
  flip.
