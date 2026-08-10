import { createRequire } from 'node:module';
import { runVercelHandler } from '../_lib/runVercelHandler.js';

const require = createRequire(import.meta.url);
const handler = require('../../api/health.js');

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  return runVercelHandler(handler, context.request, context.env);
}
