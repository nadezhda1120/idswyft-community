/**
 * Stateless verification server entry point.
 *
 *   node dist/stateless/server.js        (npm run start:stateless)
 *
 * Needs ENGINE_URL and STATELESS_API_KEYS (or STATELESS_ALLOW_ANONYMOUS=true).
 * No DATABASE_URL, Supabase or storage configuration is read.
 */

export {}; // ES module: top-level await below

// Before the logger loads: this server never logs identity data or writes log files
process.env.LOG_REDACT_PII = 'true';
process.env.LOG_FILES = 'false';

const { logger } = await import('@/utils/logger.js');
const { default: engineClient } = await import('@/services/engineClient.js');
const { loadStatelessConfig } = await import('./config.js');
const { createStatelessApp } = await import('./app.js');

const config = loadStatelessConfig();

if (!engineClient.isEnabled()) {
  logger.error('Stateless server: ENGINE_URL is required');
  process.exit(1);
}
if (!config.allowAnonymous && config.apiKeys.length === 0) {
  logger.error('Stateless server: set STATELESS_API_KEYS (or STATELESS_ALLOW_ANONYMOUS=true for local testing)');
  process.exit(1);
}
if (config.challengeSecretIsEphemeral) {
  logger.warn('Stateless server: STATELESS_CHALLENGE_SECRET is not set; challenge tokens only verify on this replica');
}

const app = createStatelessApp(config, {
  extractFront: engineClient.extractFront,
  extractBack: engineClient.extractBack,
  extractLive: engineClient.extractLive,
  faceMatchThreshold: config.faceMatchThreshold,
});

app.listen(config.port, () => {
  logger.info('Stateless verification server listening', { port: config.port, anonymous: config.allowAnonymous });
});
