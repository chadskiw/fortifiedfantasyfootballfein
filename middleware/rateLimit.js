import rateLimit from 'express-rate-limit';
import { config } from '../config/index.js';

export const limiter = rateLimit({
  windowMs: config.rate.windowMs,
  max: config.rate.max,
  standardHeaders: true,
  legacyHeaders: false
});
