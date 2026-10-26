import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import type { Buffer as NodeBuffer } from 'buffer';

// The stateless server must start without a database: fail loudly if anything imports it.
vi.mock('@/config/database.js', () => {
  throw new Error('stateless app imported the database module');
});

import { createStatelessApp } from '../app.js';
import { loadStatelessConfig } from '../config.js';
import { issueChallenge } from '../challenge.js';
import { mockDeps, headTurn } from './fixtures.js';

const KEY = 'stateless-test-key';
const config = loadStatelessConfig({
  STATELESS_API_KEYS: KEY,
  STATELESS_CHALLENGE_SECRET: 'challenge-secret-for-tests-only',
} as NodeJS.ProcessEnv);

const image = () => Buffer.from('fake-image-bytes');

function app(deps = mockDeps()) {
  return { deps, http: request(createStatelessApp(config, deps)) };
}

describe('stateless API — auth and transport', () => {
  it('serves /health without a key', async () => {
    const res = await app().http.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', mode: 'stateless' });
  });

  it('rejects requests without a valid key', async () => {
    const { http } = app();
    expect((await http.post('/v1/verify')).status).toBe(401);
    expect((await http.post('/v1/verify').set('X-API-Key', 'wrong')).status).toBe(401);
  });

  it('accepts the key as a Bearer token and marks responses no-store', async () => {
    const res = await app().http.post('/v1/liveness/challenge').set('Authorization', `Bearer ${KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ success: true, challenge_type: 'head_turn' });
  });
});

describe('POST /v1/verify', () => {
  it('verifies front + back + live in one request', async () => {
    const res = await app().http.post('/v1/verify').set('X-API-Key', KEY)
      .attach('front', image(), 'front.jpg')
      .attach('back', image(), 'back.jpg')
      .attach('live', image(), 'live.jpg')
      .field('issuing_country', 'bg');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, final_result: 'verified', flow: 'full' });
    expect(JSON.stringify(res.body)).not.toContain('face_embedding');
  });

  it('zero-fills the uploaded images after the response', async () => {
    const seen: NodeBuffer[] = [];
    const deps = mockDeps();
    const extractFront = deps.extractFront;
    deps.extractFront = vi.fn(async (buffer: NodeBuffer, opts) => { seen.push(buffer); return extractFront(buffer, opts); });
    await app(deps).http.post('/v1/verify').set('X-API-Key', KEY)
      .attach('front', image(), 'front.jpg')
      .attach('back', image(), 'back.jpg');
    expect(seen).toHaveLength(1);
    expect([...seen[0]].every(b => b === 0)).toBe(true);
  });

  it('requires a front image and the uploads the flow needs', async () => {
    const { http } = app();
    const noFront = await http.post('/v1/verify').set('X-API-Key', KEY).attach('back', image(), 'b.jpg');
    expect(noFront.status).toBe(400);
    const noBack = await http.post('/v1/verify').set('X-API-Key', KEY)
      .attach('front', image(), 'f.jpg').field('flow', 'document_only');
    expect(noBack.status).toBe(400);
    expect(noBack.body.error).toMatch(/back/);
    const badFlow = await http.post('/v1/verify').set('X-API-Key', KEY)
      .attach('front', image(), 'f.jpg').field('flow', 'everything');
    expect(badFlow.status).toBe(400);
  });

  it('rejects malformed liveness metadata without echoing it', async () => {
    const res = await app().http.post('/v1/verify').set('X-API-Key', KEY)
      .attach('front', image(), 'f.jpg').attach('live', image(), 'l.jpg')
      .field('liveness_metadata', '{"challenge_type":"head_turn","secret":"JOHN DOE"}');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('JOHN DOE');
  });

  it('checks a server-issued challenge against the captured direction', async () => {
    const c = issueChallenge(config.challengeSecret, 120);
    const other = c.challenge_direction === 'left' ? 'right' : 'left';
    const send = (direction: 'left' | 'right') => app().http.post('/v1/verify').set('X-API-Key', KEY)
      .attach('front', image(), 'f.jpg').attach('live', image(), 'l.jpg')
      .field('liveness_metadata', JSON.stringify(headTurn(direction)))
      .field('challenge_token', c.challenge_token);

    const ok = await send(c.challenge_direction);
    expect(ok.status).toBe(200);
    expect(ok.body.flow).toBe('identity');

    const mismatch = await send(other);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toMatch(/direction_mismatch/);
  });

  it('answers 502 without details when the engine fails', async () => {
    const deps = mockDeps({ extractFront: vi.fn(async () => { throw new Error('engine down: JOHN DOE'); }) });
    const res = await app(deps).http.post('/v1/verify').set('X-API-Key', KEY)
      .attach('front', image(), 'f.jpg').attach('back', image(), 'b.jpg');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ success: false, error: 'Verification could not be completed' });
  });

  it('rejects files over the size limit', async () => {
    const small = loadStatelessConfig({ STATELESS_API_KEYS: KEY, STATELESS_MAX_FILE_MB: '1' } as NodeJS.ProcessEnv);
    const res = await request(createStatelessApp(small, mockDeps())).post('/v1/verify').set('X-API-Key', KEY)
      .attach('front', Buffer.alloc(1024 * 1024 + 1), 'f.jpg');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/LIMIT_FILE_SIZE/);
  });
});
