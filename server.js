import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config/index.js';
import { corsMiddleware } from './middleware/cors.js';
import { limiter } from './middleware/rateLimit.js';
import { notFound, errorHandler } from './middleware/error.js';
import { httpLogger } from './utils/logger.js';
import { healthRouter } from './routers/healthRouter.js';
import { sleeperRouter } from './routers/sleeperRouter.js';
import { espnRouter } from './routers/espnRouter.js';

const app = express();

// Core middleware
app.use(httpLogger);
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(corsMiddleware());
app.use(limiter);
app.use(morgan('tiny'));

// Routers
app.use('/', healthRouter());
app.use('/api/sleeper', sleeperRouter());
app.use('/api/espn', espnRouter());

// 404 + error
app.use(notFound);
app.use(errorHandler);

// Start
app.listen(config.port, () => {
  console.log(`[ff-platforms-server] ${config.env} listening on :${config.port}`);
});
