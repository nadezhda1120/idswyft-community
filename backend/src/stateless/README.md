# Stateless verification API

A separate server that verifies an identity document (and optionally a live capture)
in **one request**, with no database, no sessions and no stored files. It runs the
same gates, cross-validation and face matching as the stateful `/api/v2/verify` flow,
in memory, and forgets everything when the response is sent.

The stateful API is unchanged and keeps working as before.

## Run

```bash
docker compose -f docker-compose.stateless.yml up -d --build
```

| Variable | Required | Meaning |
|---|---|---|
| `STATELESS_API_KEYS` | yes* | Comma-separated keys, sent as `X-API-Key` or `Authorization: Bearer` |
| `STATELESS_ALLOW_ANONYMOUS` | | `true`: no key (local testing only) |
| `ENGINE_URL`, `ENGINE_API_KEY` | yes | The ML engine |
| `STATELESS_CHALLENGE_SECRET` | for >1 replica | Signs liveness challenge tokens; same value on every replica |
| `STATELESS_CHALLENGE_TTL` | | Challenge lifetime in seconds (default 120) |
| `STATELESS_REQUIRE_CHALLENGE` | | `true`: head-turn liveness must carry a server-issued token |
| `STATELESS_MAX_FILE_MB` | | Per-file upload limit (default 10) |

Without Docker: `cd backend && npm run build && npm run start:stateless` (port 3003).

## Endpoints

### `POST /v1/verify` (multipart/form-data)

| Field | | |
|---|---|---|
| `front` | file, required | Front of the document |
| `back` | file | Back of the document |
| `live` | file | Live capture |
| `liveness_metadata` | JSON | Complete head-turn capture (5–12 frames), same format as the stateful API |
| `challenge_token` | string | From `/v1/liveness/challenge` |
| `flow` | | `full`, `document_only` or `identity`; inferred from the uploads when omitted |
| `issuing_country` | | ISO alpha-2, e.g. `BG` |
| `document_type` | | `auto` (default), `national_id`, `passport`, `drivers_license` |
| `include_raw_text` | | `true` to also return the OCR raw text and barcode data |

Flows: `full` = front + back + live, `document_only` = front + back, `identity` =
front + live (passports). A passport detected in `full` skips the back side.

Response (200):

```json
{
  "success": true,
  "final_result": "verified | failed | manual_review",
  "status": "COMPLETE | HARD_REJECTED",
  "flow": "full",
  "rejection": null,
  "document": { "front": { "...OCR fields": "" }, "back": { "mrz_result": {}, "qr_payload": {} } },
  "checks": { "ocr_confidence": 0.9, "authenticity": {}, "cross_validation": {}, "liveness": {}, "face_match": {} }
}
```

On a failed gate, `rejection` holds `reason`, `detail` and a `user_message` to show
(for example "please retake the photo"). Face embeddings are never returned.
Errors: `400` (bad input, never echoing it), `401` (key), `502` (engine failure, no details).

### `POST /v1/liveness/challenge`

Returns `{ challenge_direction, challenge_token, expires_at }`. The client asks the
user to turn the head that way and sends the whole capture with the token in a single
`/v1/verify` call. The token is HMAC-signed and carries its own expiry, so no server
keeps it: any replica can check it until it expires. It can be reused within its
lifetime (there is no nonce store), so keep the TTL short.

## What is guaranteed

| Requirement | How |
|---|---|
| No database | The server imports no database, storage, session or webhook module; a test fails if the database module is loaded |
| No persistent sessions | `VerificationSession` lives only for the request; its id is never returned or stored |
| No stored images | Uploads stay in memory (multer `memoryStorage`) and are zero-filled after the response; the container root filesystem is read-only |
| No identity data in logs | `LOG_REDACT_PII=true` (forced on): names, numbers, dates, addresses, MRZ/raw text, images and embeddings are redacted from every log entry, in the API and the engine; no log files |
| Nothing cached | `Cache-Control: no-store`; the PaddleOCR library's in-process result cache is turned off |
| Horizontal scaling | No shared state; any replica serves any request |
| Deterministic decisions | Same gates and thresholds as the stateful flow; the ML engine only extracts |

## Third-party temporary files (audit)

| Library | Finding |
|---|---|
| multer | `memoryStorage`: no temp files |
| ppu-paddle-ocr | Writes only downloaded models to `~/.cache`. Kept the last 10 OCR results in a global in-memory LRU cache: disabled (`noCache`). Debug image dumps are off |
| sharp / libvips | Decodes from buffers in memory. An image larger than libvips' disk threshold (100 MB decoded, e.g. a 6000 × 6000 photo) may be decompressed to a temp file in `$TMPDIR`, removed right after; in `docker-compose.stateless.yml` the engine's `/tmp` is a `tmpfs` (RAM), so it never reaches disk |
| tesseract.js | Caches language data only |
| face-api.js, onnxruntime, @zxing | In memory |

## Not included

- AML / sanctions screening (Gate 6): it sends names to a provider or loads lists from the database configuration; not wired into the stateless flow.
- Voice verification (needs a server-side challenge store).
- Rate limiting: in-process limits do not hold across replicas; do it at the load balancer.
