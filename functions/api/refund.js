import { createRequire } from 'node:module';
import { runVercelHandler } from '../_lib/runVercelHandler.js';

const require = createRequire(import.meta.url);
const handler = require('../../api/refund.js');

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function onRequestPost(context) {
  return runVercelHandler(handler, context.request, context.env);
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return onRequestOptions();
  if (context.request.method === 'POST') return onRequestPost(context);
  return new Response(JSON.stringify({ ok: false, error: 'Use POST' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
