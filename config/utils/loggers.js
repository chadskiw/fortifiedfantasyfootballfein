CHECK THIS OUT
// TRUE_LOCATION: config/utils/loggers.js
// IN_USE: FALSE
import pino from 'pino';
import pinoHttp from 'pino-http';

export const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' }
});

export const httpLogger = pinoHttp({ logger });
