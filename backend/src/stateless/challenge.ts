/**
 * Liveness challenge tokens without server state.
 *
 * The server picks the head-turn direction and returns it with a signed token
 * (HMAC-SHA256 over direction + expiry + nonce). The client submits the token with
 * the complete capture sequence in one request; the server checks the signature,
 * the expiry and that the captured direction is the one it asked for. Nothing is
 * stored, so any replica can verify any token while it is valid, and an expired
 * token is simply rejected — the state expires by itself.
 *
 * A token can be reused until it expires (no server-side nonce store); keep the
 * TTL short. Deterministic apart from the random direction and nonce.
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';

export type ChallengeDirection = 'left' | 'right';

export interface IssuedChallenge {
  challenge_type: 'head_turn';
  challenge_direction: ChallengeDirection;
  challenge_token: string;
  expires_at: string;
}

const VERSION = 'v1';

function sign(payload: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueChallenge(secret: Buffer, ttlSeconds: number, now: number = Date.now()): IssuedChallenge {
  const direction: ChallengeDirection = randomInt(2) === 0 ? 'left' : 'right';
  const expires = Math.floor(now / 1000) + ttlSeconds;
  const payload = `${VERSION}.${direction}.${expires}.${randomBytes(12).toString('base64url')}`;
  return {
    challenge_type: 'head_turn',
    challenge_direction: direction,
    challenge_token: `${payload}.${sign(payload, secret)}`,
    expires_at: new Date(expires * 1000).toISOString(),
  };
}

export type ChallengeCheck =
  | { valid: true; direction: ChallengeDirection }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'direction_mismatch' };

export function verifyChallenge(
  token: string,
  capturedDirection: string,
  secret: Buffer,
  now: number = Date.now(),
): ChallengeCheck {
  const parts = (token ?? '').split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) return { valid: false, reason: 'malformed' };
  const [, direction, expires, , signature] = parts;
  if (direction !== 'left' && direction !== 'right') return { valid: false, reason: 'malformed' };

  const expected = Buffer.from(sign(parts.slice(0, 4).join('.'), secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { valid: false, reason: 'bad_signature' };
  }
  if (!/^\d+$/.test(expires) || Number(expires) * 1000 < now) return { valid: false, reason: 'expired' };
  if (capturedDirection !== direction) return { valid: false, reason: 'direction_mismatch' };
  return { valid: true, direction };
}
