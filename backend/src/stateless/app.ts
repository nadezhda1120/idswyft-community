/**
 * Express app for the stateless verification server. Separate from the main API:
 * it imports no database, storage, session or webhook modules, so it starts with
 * only ENGINE_URL and its own keys, and any number of replicas can run behind a
 * load balancer.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { logger } from '@/utils/logger.js';
import type { StatelessConfig } from './config.js';
import type { StatelessDeps } from './verify.js';
import { createStatelessRouter } from './router.js';

export function createStatelessApp(config: StatelessConfig, deps: StatelessDeps) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.use(helmet());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode: 'stateless' });
  });

  // Method, path and status only: no query string, headers or body
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      logger.info('Stateless request', { method: req.method, path: req.path, status: res.statusCode, elapsedMs: Date.now() - started });
    });
    next();
  });

  app.use(createStatelessRouter(config, deps));

  app.use((_req, res) => {
    res.status(404).json({ success: false, error: 'Not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Stateless server error', { error: err instanceof Error ? err.name : 'Unknown' });
    res.status(500).json({ success: false, error: 'Internal error' });
  });

  return app;
}
