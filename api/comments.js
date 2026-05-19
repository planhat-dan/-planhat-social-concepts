const { createClient } = require('@supabase/supabase-js');

// Trim env vars — Vercel dashboard paste often introduces trailing whitespace
// or newlines, which break URL parsing and surface as opaque "fetch failed".
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const SLACK_WEBHOOK_URL = (process.env.SLACK_WEBHOOK_URL || '').trim();

function validateConfig() {
  const problems = [];
  if (!SUPABASE_URL) problems.push('SUPABASE_URL is missing');
  else {
    try {
      const u = new URL(SUPABASE_URL);
      if (u.protocol !== 'https:') problems.push(`SUPABASE_URL protocol must be https (got ${u.protocol})`);
      if (!u.hostname.endsWith('.supabase.co') && !u.hostname.endsWith('.supabase.in')) {
        problems.push(`SUPABASE_URL hostname looks wrong: ${u.hostname} (expected *.supabase.co)`);
      }
      if (u.pathname && u.pathname !== '/' && u.pathname !== '') {
        problems.push(`SUPABASE_URL should have no path (got "${u.pathname}") — use https://<ref>.supabase.co only`);
      }
    } catch (e) {
      problems.push(`SUPABASE_URL is not a valid URL: ${e.message}`);
    }
  }
  if (!SUPABASE_KEY) problems.push('SUPABASE_KEY is missing');
  else if (SUPABASE_KEY.length < 40) problems.push('SUPABASE_KEY looks too short — paste the full anon or service_role key');
  return problems;
}

let _client = null;
function getClient() {
  if (_client) return _client;
  const problems = validateConfig();
  if (problems.length) {
    const err = new Error('Supabase config invalid: ' + problems.join('; '));
    err.code = 'CONFIG';
    throw err;
  }
  _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
    global: { fetch: (...args) => fetch(...args) }
  });
  return _client;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function pageUrl(req, commentId) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const base  = `${proto}://${host}/`;
  return commentId ? `${base}#comment-${commentId}` : base;
}

async function notifySlack({ author, text, url, x, y }) {
  if (!SLACK_WEBHOOK_URL) return;
  const payload = {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*New review comment* from *${author}*\n>${String(text).replace(/\n/g, '\n>')}`
        }
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `Position: ${Number(x).toFixed(1)}%, ${Number(y).toFixed(1)}%` },
          { type: 'mrkdwn', text: `<${url}|Open page>` }
        ]
      }
    ]
  };
  try {
    const r = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) console.warn('[slack] non-2xx:', r.status, await r.text());
  } catch (e) {
    console.warn('[slack] notify failed:', e.message);
  }
}

function sendError(res, status, message, extra) {
  res.status(status).json({ error: message, ...(extra || {}) });
}

function fetchErrorDetail(err) {
  // undici surfaces the underlying cause on err.cause
  const cause = err && err.cause;
  if (!cause) return null;
  return {
    causeMessage: cause.message,
    causeCode: cause.code,
    causeErrno: cause.errno,
    causeSyscall: cause.syscall,
    causeHostname: cause.hostname
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let sb;
  try {
    sb = getClient();
  } catch (e) {
    console.error('[api/comments] config error:', e.message);
    return sendError(res, 500, e.message, { stage: 'config' });
  }

  try {
    if (req.method === 'GET') {
      const { data, error } = await sb
        .from('comments').select('*')
        .order('created_at', { ascending: true });
      if (error) {
        console.error('[api/comments] GET supabase error:', error);
        return sendError(res, 500, error.message, { stage: 'select', supabase: error });
      }
      return res.status(200).json(data || []);
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const { x, y, author, text } = body || {};
      if (
        typeof x !== 'number' || typeof y !== 'number' ||
        typeof author !== 'string' || typeof text !== 'string' ||
        !author.trim() || !text.trim()
      ) {
        return sendError(res, 400, 'Invalid payload. Required: x, y (numbers), author, text (non-empty strings).');
      }
      const row = {
        x: Math.max(0, Math.min(100, x)),
        y: Math.max(0, Math.min(100, y)),
        author: author.trim().slice(0, 80),
        text:   text.trim().slice(0, 2000),
        resolved: false
      };
      const { data, error } = await sb.from('comments').insert(row).select().single();
      if (error) {
        console.error('[api/comments] POST supabase error:', error);
        return sendError(res, 500, error.message, { stage: 'insert', supabase: error });
      }
      notifySlack({
        author: data.author, text: data.text,
        url: pageUrl(req, data.id), x: data.x, y: data.y
      });
      return res.status(201).json(data);
    }

    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const { id, resolved } = body || {};
      if (!id) return sendError(res, 400, 'Missing id');
      if (typeof resolved !== 'boolean') return sendError(res, 400, 'resolved must be a boolean');
      const { data, error } = await sb
        .from('comments').update({ resolved }).eq('id', id).select().single();
      if (error) {
        console.error('[api/comments] PATCH supabase error:', error);
        return sendError(res, 500, error.message, { stage: 'update', supabase: error });
      }
      return res.status(200).json(data);
    }

    return sendError(res, 405, 'Method not allowed');
  } catch (e) {
    const detail = fetchErrorDetail(e);
    console.error('[api/comments] unhandled:', e.message, detail || '');
    return sendError(res, 500, e.message || 'Internal error', {
      stage: 'network',
      hint: detail
        ? 'Network call from the function failed — most often a malformed SUPABASE_URL (trailing newline/whitespace) or wrong project URL. See "hint" for the underlying cause.'
        : undefined,
      ...(detail || {})
    });
  }
};
