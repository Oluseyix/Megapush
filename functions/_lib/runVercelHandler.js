/**
 * Run a Vercel-style (req, res) Node handler inside Cloudflare Pages Functions.
 * Injects env secrets into process.env for existing api/*.js code.
 */

function applyEnv(env = {}) {
  if (typeof globalThis.process === 'undefined') {
    globalThis.process = { env: {} };
  }
  if (!globalThis.process.env) globalThis.process.env = {};
  for (const [k, v] of Object.entries(env)) {
    if (v != null && v !== '') globalThis.process.env[k] = String(v);
  }
}

function makeRes() {
  const state = {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: null,
  };
  const res = {
    setHeader(k, v) {
      state.headers[k] = v;
      return res;
    },
    status(code) {
      state.statusCode = code;
      return res;
    },
    json(obj) {
      state.body = JSON.stringify(obj);
      if (!state.headers['Content-Type'] && !state.headers['content-type']) {
        state.headers['Content-Type'] = 'application/json';
      }
      return res;
    },
    end(data) {
      if (data != null) state.body = typeof data === 'string' ? data : JSON.stringify(data);
      return res;
    },
    getState: () => state,
  };
  return res;
}

/**
 * @param {Function} handler Vercel handler (req, res) => Promise|void
 * @param {Request} request
 * @param {Record<string, string>} env
 */
export async function runVercelHandler(handler, request, env) {
  applyEnv(env);

  const url = new URL(request.url);
  let body;
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
    const text = await request.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    } else {
      body = {};
    }
  }

  const req = {
    method: request.method,
    body,
    headers: Object.fromEntries(request.headers),
    url: url.pathname + url.search,
    query: Object.fromEntries(url.searchParams),
  };

  const res = makeRes();
  await handler(req, res);
  const state = res.getState();
  return new Response(state.body ?? '{}', {
    status: state.statusCode || 200,
    headers: state.headers,
  });
}
