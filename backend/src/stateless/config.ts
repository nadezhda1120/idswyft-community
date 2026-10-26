/**
 * Stateless verification server configuration — environment only, no database.
 *
 *   STATELESS_API_KEYS          comma-separated keys accepted in X-API-Key / Bearer (required
 *                               unless STATELESS_ALLOW_ANONYMOUS=true)
 *   STATELESS_ALLOW_ANONYMOUS   true: no API key (local testing only)
 *   STATELESS_CHALLENGE_SECRET  HMAC secret for liveness challenge tokens; must be the same on
 *                               every replica (a random per-process secret is used if unset)
 *   STATELESS_CHALLENGE_TTL     challenge token lifetime in seconds (default 120)
 *   STATELESS_REQUIRE_CHALLENGE true: head-turn liveness must carry a server-issued challenge token
 *   STATELESS_MAX_FILE_MB       per-file upload limit (default 10)
 *   STATELESS_PORT / PORT       listen port (default 3003)
 *   ENGINE_URL, ENGINE_API_KEY  the ML engine (required)
 */

import { randomBytes } from 'crypto';
import { getFaceMatchingThresholdSync } from '@/config/verificationThresholds.js';

export interface StatelessConfig {
  apiKeys: string[];
  allowAnonymous: boolean;
  challengeSecret: Buffer;
  challengeSecretIsEphemeral: boolean;
  challengeTtlSeconds: number;
  requireChallenge: boolean;
  maxFileBytes: number;
  faceMatchThreshold: number;
  port: number;
}

export function loadStatelessConfig(env: NodeJS.ProcessEnv = process.env): StatelessConfig {
  const secret = env.STATELESS_CHALLENGE_SECRET;
  return {
    apiKeys: (env.STATELESS_API_KEYS ?? '').split(',').map(k => k.trim()).filter(Boolean),
    allowAnonymous: env.STATELESS_ALLOW_ANONYMOUS === 'true',
    challengeSecret: secret ? Buffer.from(secret, 'utf8') : randomBytes(32),
    challengeSecretIsEphemeral: !secret,
    challengeTtlSeconds: Number(env.STATELESS_CHALLENGE_TTL) > 0 ? Number(env.STATELESS_CHALLENGE_TTL) : 120,
    requireChallenge: env.STATELESS_REQUIRE_CHALLENGE === 'true',
    maxFileBytes: Math.floor((Number(env.STATELESS_MAX_FILE_MB) > 0 ? Number(env.STATELESS_MAX_FILE_MB) : 10) * 1024 * 1024),
    faceMatchThreshold: getFaceMatchingThresholdSync(false),
    port: Number(env.STATELESS_PORT || env.PORT) || 3003,
  };
}
