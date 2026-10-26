import { describe, it, expect } from 'vitest';
import { issueChallenge, verifyChallenge } from '../challenge.js';

const secret = Buffer.from('test-secret-test-secret-test-secret');
const now = Date.UTC(2026, 9, 26, 12, 0, 0);

describe('liveness challenge tokens', () => {
  it('verifies a token for the direction it was issued with', () => {
    const c = issueChallenge(secret, 120, now);
    expect(verifyChallenge(c.challenge_token, c.challenge_direction, secret, now + 60_000))
      .toEqual({ valid: true, direction: c.challenge_direction });
    expect(c.expires_at).toBe(new Date(now + 120_000).toISOString());
  });

  it('rejects the other direction', () => {
    const c = issueChallenge(secret, 120, now);
    const other = c.challenge_direction === 'left' ? 'right' : 'left';
    expect(verifyChallenge(c.challenge_token, other, secret, now)).toEqual({ valid: false, reason: 'direction_mismatch' });
  });

  it('rejects an expired token', () => {
    const c = issueChallenge(secret, 120, now);
    expect(verifyChallenge(c.challenge_token, c.challenge_direction, secret, now + 121_000))
      .toEqual({ valid: false, reason: 'expired' });
  });

  it('rejects a token signed with another secret or edited', () => {
    const c = issueChallenge(secret, 120, now);
    expect(verifyChallenge(c.challenge_token, c.challenge_direction, Buffer.from('other'), now))
      .toEqual({ valid: false, reason: 'bad_signature' });

    const flipped = c.challenge_direction === 'left' ? 'right' : 'left';
    const edited = c.challenge_token.replace(`.${c.challenge_direction}.`, `.${flipped}.`);
    expect(verifyChallenge(edited, flipped, secret, now)).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects malformed tokens', () => {
    expect(verifyChallenge('', 'left', secret, now)).toEqual({ valid: false, reason: 'malformed' });
    expect(verifyChallenge('v2.left.1.n.s', 'left', secret, now)).toEqual({ valid: false, reason: 'malformed' });
    expect(verifyChallenge('v1.up.1.n.s', 'left', secret, now)).toEqual({ valid: false, reason: 'malformed' });
  });
});
