'use strict';
/* The one serverless function. vercel.json sends every /api/* request here. */
const { handler } = require('../src/app');

module.exports = handler;
