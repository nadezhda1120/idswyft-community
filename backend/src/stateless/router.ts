/**
 * Stateless verification API.
 *
 *   POST /v1/verify               multipart: front (required), back, live + fields
 *                                 document_type, issuing_country, flow, liveness_metadata,
 *                                 challenge_token, include_raw_text
 *   POST /v1/liveness/challenge   server-chosen head-turn direction + signed token
 *
 * Uploads stay in memory (multer memoryStorage) and are zero-filled after the
 * request. Responses carry Cache-Control: no-store. Error responses never echo
 * request content.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { createHash, timingSafeEqual } from 'crypto';
import { HeadTurnLivenessMetadataSchema } from '@idswyft/shared';
import type { HeadTurnLivenessMetadata } from '@idswyft/shared';
import { logger } from '@/utils/logger.js';
import type { StatelessConfig } from './config.js';
import { issueChallenge, verifyChallenge } from './challenge.js';
import {
  STATELESS_FLOWS, inferFlow, missingUploads, runStatelessVerification, wipe,
  type StatelessDeps, type StatelessFlow,
} from './verify.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** X-API-Key or Authorization: Bearer, compared in constant time against the configured keys. */
export function apiKeyAuth(config: StatelessConfig) {
  const keys = config.apiKeys.map(digest);
  return (req: Request, res: Response, next: NextFunction) => {
    if (config.allowAnonymous) return next();
    const header = req.get('x-api-key') ?? req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const given = digest(header);
    if (header && keys.some(k => timingSafeEqual(k, given))) return next();
    res.status(401).json({ success: false, error: 'Invalid or missing API key' });
  };
}

class BadRequest extends Error {}

function parseHeadTurn(raw: unknown): HeadTurnLivenessMetadata | undefined {
  if (raw === undefined || raw === '') return undefined;
  try {
    return HeadTurnLivenessMetadataSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
  } catch {
    throw new BadRequest('Invalid liveness_metadata: expected the head_turn capture with 5-12 frames');
  }
}

export function createStatelessRouter(config: StatelessConfig, deps: StatelessDeps) {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxFileBytes,
      files: 3,
      fields: 10,
      fieldSize: 3 * 1024 * 1024, // liveness_metadata: up to 12 base64 frames
    },
  });
  const files = upload.fields([{ name: 'front', maxCount: 1 }, { name: 'back', maxCount: 1 }, { name: 'live', maxCount: 1 }]);

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(apiKeyAuth(config));

  router.post('/v1/liveness/challenge', (_req, res) => {
    res.json({ success: true, ...issueChallenge(config.challengeSecret, config.challengeTtlSeconds) });
  });

  router.post('/v1/verify', files, async (req: Request, res: Response) => {
    const uploaded = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;
    const front = uploaded.front?.[0]?.buffer;
    const back = uploaded.back?.[0]?.buffer;
    const live = uploaded.live?.[0]?.buffer;
    const started = Date.now();

    try {
      const has = { front: !!front, back: !!back, live: !!live };
      const requested = req.body.flow as string | undefined;
      if (requested && !(requested in STATELESS_FLOWS)) {
        throw new BadRequest(`flow must be one of: ${Object.keys(STATELESS_FLOWS).join(', ')}`);
      }
      const flow = (requested as StatelessFlow | undefined) ?? inferFlow(has);
      const missing = missingUploads(flow, has);
      if (missing.length) throw new BadRequest(`Missing upload(s) for flow "${flow}": ${missing.join(', ')}`);

      const headTurnMetadata = STATELESS_FLOWS[flow].live ? parseHeadTurn(req.body.liveness_metadata) : undefined;
      const token = req.body.challenge_token as string | undefined;
      if (headTurnMetadata && (token || config.requireChallenge)) {
        if (!token) throw new BadRequest('challenge_token is required: get one from POST /v1/liveness/challenge');
        const check = verifyChallenge(token, headTurnMetadata.challenge_direction, config.challengeSecret);
        if (!check.valid) throw new BadRequest(`Liveness challenge rejected: ${check.reason}`);
      }

      const issuing = typeof req.body.issuing_country === 'string' ? req.body.issuing_country.trim().toUpperCase() : '';
      if (issuing && !/^[A-Z]{2}$/.test(issuing)) throw new BadRequest('issuing_country must be an ISO 3166-1 alpha-2 code');

      const result = await runStatelessVerification({
        front: front!,
        back: STATELESS_FLOWS[flow].back ? back : undefined,
        live: STATELESS_FLOWS[flow].live ? live : undefined,
        documentType: typeof req.body.document_type === 'string' && req.body.document_type ? req.body.document_type : 'auto',
        issuingCountry: issuing || undefined,
        flow,
        headTurnMetadata,
        includeRawText: req.body.include_raw_text === 'true',
      }, deps);

      // Outcome only — never names, numbers or images
      logger.info('Stateless verification complete', {
        flow: result.flow, final_result: result.final_result, status: result.status,
        rejection_reason: result.rejection?.reason ?? null, elapsedMs: Date.now() - started,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      if (err instanceof BadRequest) {
        res.status(400).json({ success: false, error: err.message });
        return;
      }
      logger.error('Stateless verification failed', {
        error: err instanceof Error ? err.name : 'Unknown', elapsedMs: Date.now() - started,
      });
      res.status(502).json({ success: false, error: 'Verification could not be completed' });
    } finally {
      wipe(front, back, live);
      req.files = undefined;
      req.body = {};
    }
  });

  // Upload limits and malformed multipart → 400, without request details
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      res.status(400).json({ success: false, error: `Upload rejected: ${err.code}` });
      return;
    }
    next(err);
  });

  return router;
}
