import cors from 'cors';
import { config } from '../config/index.js';

export function corsMiddleware() {
  const allowAll = config.allowedOrigins.length === 0 || config.env !== 'production';
  return cors({
    origin(origin, cb) {
      if (allowAll || !origin || config.allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS: ' + origin));
    },
    credentials: true
  });
}
