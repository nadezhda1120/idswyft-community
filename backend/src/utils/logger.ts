import winston from 'winston';
import { redactLogEntry } from '@idswyft/shared';

// Read NODE_ENV directly rather than through @/config: the logger must load
// without the API's secrets so the stateless server can use it.
const nodeEnv = process.env.NODE_ENV || 'development';

// LOG_REDACT_PII=true: strip names, numbers, dates, MRZ text and images from every entry
const redact = winston.format(info => (process.env.LOG_REDACT_PII === 'true' ? redactLogEntry(info) : info));

// LOG_FILES=false: stdout only (containers, stateless server)
const writeFiles = nodeEnv === 'production' && process.env.LOG_FILES !== 'false';

// The logger-level format runs before any transport format, so redaction here covers every transport
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
    service: 'idswyft-api',
    environment: nodeEnv
  },
  transports: [
    // Console transport for development
    new winston.transports.Console({
      format: nodeEnv === 'development' ? consoleFormat : logFormat
    }),
    
    // File transports for production
    ...(writeFiles ? [
      new winston.transports.File({ 
        filename: 'logs/error.log', 
        level: 'error',
        maxsize: 5242880, // 5MB
        maxFiles: 5
      }),
      new winston.transports.File({ 
        filename: 'logs/combined.log',
        maxsize: 5242880, // 5MB
        maxFiles: 5
      })
    ] : [])
  ],
  
  // Handle exceptions and rejections
  exceptionHandlers: [
    new winston.transports.Console(),
    ...(writeFiles ? [
      new winston.transports.File({ filename: 'logs/exceptions.log' })
    ] : [])
  ],
  
  rejectionHandlers: [
    new winston.transports.Console(),
    ...(writeFiles ? [
      new winston.transports.File({ filename: 'logs/rejections.log' })
    ] : [])
  ]
});

// Add request ID to logs for tracing
export const addRequestId = (req: any, res: any, next: any) => {
  req.requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  res.setHeader('X-Request-ID', req.requestId);
  next();
};

// Structured logging helpers
export const logError = (message: string, error: Error, meta: any = {}) => {
  logger.error(message, {
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack
    },
    ...meta
  });
};

export const logVerificationEvent = (event: string, verificationId: string, meta: any = {}) => {
  logger.info(`Verification ${event}`, {
    event,
    verificationId,
    ...meta
  });
};

export const logAPIRequest = (req: any, duration: number) => {
  logger.info('API Request', {
    method: req.method,
    url: req.originalUrl,
    requestId: req.requestId,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    duration: `${duration}ms`,
    apiKey: req.apiKey?.key_prefix ? `${req.apiKey.key_prefix}***` : 'none'
  });
};

export const logWebhookDelivery = (webhookId: string, status: string, meta: any = {}) => {
  logger.info('Webhook delivery', {
    webhookId,
    status,
    ...meta
  });
};

export default logger;