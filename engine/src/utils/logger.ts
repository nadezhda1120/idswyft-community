import winston from 'winston';
import { redactLogEntry } from '@idswyft/shared';

const nodeEnv = process.env.NODE_ENV || 'development';

// LOG_REDACT_PII=true: strip names, numbers, dates, MRZ text and images from every entry
const redact = winston.format(info => (process.env.LOG_REDACT_PII === 'true' ? redactLogEntry(info) : info));

const logFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  redact(),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: {
    service: 'idswyft-engine',
    environment: nodeEnv,
  },
  transports: [
    new winston.transports.Console({
      format: nodeEnv === 'development' ? consoleFormat : logFormat,
    }),
  ],
});

export const logVerificationEvent = (event: string, verificationId: string, meta: any = {}) => {
  logger.info(`Verification ${event}`, { event, verificationId, ...meta });
};

export default logger;
