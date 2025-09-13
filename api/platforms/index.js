const express = require('express');
const router = express.Router();

router.use('/espn', require('../../../routers/espnRouter'));
router.use('/sleeper', require('../../../routers/sleeperRouter'));
router.use('/health', require('../../../routers/healthRouter'));

module.exports = router;
