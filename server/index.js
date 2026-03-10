/**
 * Billing v2 — Backend API Server
 * Features: SQLite, multi-model, streaming, waitlist, rate limiting, prompt collection
 */

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const https   = require('https');
const path    = require('path');
const logger  = require('./debug-log');
const { Users, Sessions, ApiKeys, Usage, Prompts, Waitlist, RateLimit, Admin } = require('./database');

const app  = express();
const PORT = process.env.PORT || 3000;

const REQUIRE_APPROVAL = process.env.REQUIRE_APPROVAL !== 'false';
const HOURLY_LIMIT     = parseInt(process.env.HOURLY_LIMIT  || '200');
const DAILY_LIMIT      = parseInt(process.env.DAILY_LIMIT   || '1000');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(logger.middleware());

function genId()     { return crypto.randomUUID(); }
function genToken()  { return 'bill_sess_' + crypto.randomBytes(32).toString('hex'); }
function genApiKey() { return 'bill_sk_'   + crypto.randomBytes(36).toString('hex'); }
function hashPass(p) { return crypto.createHash('sha256').update(p + 'billing_salt_2026').digest('hex'); }

const PROVIDERS = [
  {
    name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY',
    host: 'api.anthropic.com', path: '/v1/messages',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }),
    format: 'anthropic',
  },
  {
    name: 'OpenRouter', envKey: 'OPENROUTER_API_KEY',
    host: 'openrouter.ai', path: '/api/v1/chat/completions',
    models: ['deepseek/deepseek-r1', 'meta-llama/llama-4-maverick', 'google/gemma-3-27b-it:free'],
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'Billing', 'Content-Type': 'application/json' }),
    format: 'openai',
  },
];

const CODENAMES = ['cute-koala','angry-giraffe','happy-panda','lazy-fox','swift-eagle','brave-wolf','wise-owl','silly-penguin','grumpy-bear','jolly-dolphin','sneaky-cat','bold-tiger','fuzzy-rabbit','wild-moose','tiny-gecko'];
function randomCodename() { return CODENAMES[Math.floor(Math.random() * CODENAMES.length)]; }
function getProvider()    { for (const p of PROVIDERS) { if (process.env[p.envKey]) return { ...p, apiKey: process.env[p.envKey] }; } return null; }
function pickModel(p)     { return p.models[Math.floor(Math.random() * p.models.length)]; }

function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = Sessions.get(token);
  if (!session || session.expires_at < Date.now()) {
    if (session) Sessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }
  req.user = session;
  next();
}

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!key) return res.status(401).json({ error: 'API key required' });
  const keyData = ApiKeys.getByValue(key);
  if (keyData) {
    if (!keyData.active) return res.status(403).json({ error: 'API key revoked' });
    req.apiKey = keyData; req.apiKeyType = 'key'; return next();
  }
  const session = Sessions.get(key);
  if (session && session.expires_at > Date.now()) {
    req.apiKey = { id: 'session', user_id: session.user_id, name: 'CLI Session', requests: 0, active: 1 };
    req.apiKeyType = 'session'; return next();
  }
  return res.status(401).json({ error: 'Invalid API key' });
}

function requireAdmin(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  const session = Sessions.get(token);
  if (!session || session.expires_at < Date.now()) return res.status(403).json({ error: 'Admin only' });
  const user = Users.getById(session.user_id);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  req.user = session;
  next();
}

function rateLimit(req, res, next) {
  const userId = req.apiKey?.user_id;
  if (!userId) return next();
  const hourly = RateLimit.check(userId, 3600000,  HOURLY_LIMIT);
  const daily  = RateLimit.check(userId, 86400000, DAILY_LIMIT);
  res.setHeader('X-RateLimit-Hourly-Remaining', hourly.remaining);
  res.setHeader('X-RateLimit-Daily-Remaining',  daily.remaining);
  if (!hourly.allowed) return res.status(429).json({ error: 'Hourly rate limit exceeded', limit: HOURLY_LIMIT, reset: new Date(hourly.resetAt).toISOString() });
  if (!daily.allowed)  return res.status(429).json({ error: 'Daily rate limit exceeded',  limit: DAILY_LIMIT,  reset: new Date(daily.resetAt).toISOString() });
  next();
}

/* ── WAITLIST ── */
app.post('/api/waitlist', (req, res) => {
  const { name, email, reason } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  if (Users.getByEmail(email)) return res.status(409).json({ error: 'Email already registered' });
  const result = Waitlist.add(name, email, reason || '');
  if (!result) return res.status(409).json({ error: 'Already on waitlist' });
  logger.info(`Waitlist: ${name} <${email}>`);
  res.json({ ok: true, message: 'Added to waitlist!' });
});

app.get('/api/waitlist/status', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const entry = Waitlist.get(email);
  if (!entry) return res.json({ status: 'not_found' });
  res.json({ status: entry.status });
});

/* ── AUTH ── */
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be 8+ chars' });
  if (Users.getByEmail(email)) return res.status(409).json({ error: 'Email already registered' });

  if (REQUIRE_APPROVAL) {
    const w = Waitlist.get(email);
    if (!w) return res.status(403).json({ error: 'Join the waitlist first', waitlist: true });
    if (w.status !== 'approved') return res.status(403).json({ error: 'Your application is pending review', waitlist: true, status: w.status });
  }

  const id = genId();
  Users.create(id, name, email, hashPass(password), 1);
  const token = genToken();
  Sessions.create(token, id, email, name, Date.now() + 30 * 24 * 3600 * 1000);
  logger.auth(`Registered: ${name} <${email}>`);
  res.json({ token, user: { id, name, email } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = Users.getByEmail(email);
  if (!user || user.password !== hashPass(password)) return res.status(401).json({ error: 'Invalid email or password' });
  const token = genToken();
  Sessions.create(token, user.id, user.email, user.name, Date.now() + 30 * 24 * 3600 * 1000);
  logger.auth(`Login: ${user.name} <${email}>`);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  Sessions.delete(req.headers['authorization']?.replace('Bearer ', '')); res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = Users.getById(req.user.user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.created_at });
});

app.patch('/api/auth/me', requireAuth, (req, res) => {
  if (req.body.name) Users.updateName(req.user.user_id, req.body.name);
  const user = Users.getById(req.user.user_id);
  res.json({ id: user.id, name: user.name, email: user.email });
});

/* ── API KEYS ── */
app.post('/api/keys', requireAuth, (req, res) => {
  const name = req.body.name || 'My Key';
  const key  = genApiKey();
  const id   = genId();
  ApiKeys.create(id, req.user.user_id, name, key);
  logger.info(`Key created: "${name}"`);
  res.json({ id, name, key, createdAt: new Date().toISOString(), active: true, requests: 0 });
});

app.get('/api/keys', requireAuth, (req, res) => {
  const keys = ApiKeys.listByUser(req.user.user_id).map(k => ({
    id: k.id, name: k.name, active: k.active, requests: k.requests, createdAt: k.created_at,
    key: k.key_value.slice(0, 14) + '••••••••••••' + k.key_value.slice(-4)
  }));
  res.json(keys);
});

app.patch('/api/keys/:id/revoke', requireAuth, (req, res) => {
  const r = ApiKeys.revoke(req.params.id, req.user.user_id);
  if (!r.changes) return res.status(404).json({ error: 'Key not found' });
  res.json({ ok: true });
});

app.delete('/api/keys/:id', requireAuth, (req, res) => {
  const r = ApiKeys.delete(req.params.id, req.user.user_id);
  if (!r.changes) return res.status(404).json({ error: 'Key not found' });
  res.json({ ok: true });
});

/* ── USAGE ── */
app.get('/api/usage', requireAuth, (req, res) => res.json(Usage.getStats(req.user.user_id)));

/* ── MODELS ── */
app.get('/api/models', (req, res) => {
  res.json([
    { id: 'claude-sonnet-4-6',           name: 'Claude Sonnet 4.6', provider: 'Anthropic',  tags: ['Coding','Fast'],      stealth: 'cute-koala'  },
    { id: 'claude-opus-4-6',             name: 'Claude Opus 4.6',   provider: 'Anthropic',  tags: ['Powerful'],           stealth: 'wise-owl'    },
    { id: 'claude-haiku-4-5-20251001',   name: 'Claude Haiku 4.5',  provider: 'Anthropic',  tags: ['Fast','Cheap'],       stealth: 'tiny-gecko'  },
    { id: 'deepseek/deepseek-r1',        name: 'DeepSeek R1',       provider: 'OpenRouter', tags: ['Reasoning','Free'],   stealth: 'sneaky-cat'  },
    { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick',  provider: 'OpenRouter', tags: ['Fast','Free'],        stealth: 'bold-tiger'  },
    { id: 'google/gemma-3-27b-it:free',  name: 'Gemma 3 27B',       provider: 'OpenRouter', tags: ['Free'],               stealth: 'lazy-fox'    },
  ]);
});

/* ── PROXY /v1/messages ── */
app.post('/v1/messages', requireApiKey, rateLimit, async (req, res) => {
  const keyData  = req.apiKey;
  const userId   = keyData.user_id;
  const codename = randomCodename();
  const provider = getProvider();
  const isStream = req.body.stream === true;

  Usage.track(userId);
  if (req.apiKeyType === 'key') ApiKeys.incrementRequests(keyData.id);
  logger.proxy(`Request`, { codename, stream: isStream });

  if (!provider) {
    const mockText = `[Billing — ${codename}] Mock mode. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.`;
    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: mockText } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      return res.end();
    }
    Prompts.save(userId, null, 'mock', codename, req.body.messages, mockText, 10, 30);
    return res.json({ id: 'msg_mock', type: 'message', role: 'assistant', content: [{ type: 'text', text: mockText }], model: codename, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 30 } });
  }

  const model = pickModel(provider);
  logger.proxy(`→ ${provider.name}/${model}`);

  let body;
  if (provider.format === 'anthropic') {
    body = JSON.stringify({ model, max_tokens: req.body.max_tokens || 8192, messages: req.body.messages, system: req.body.system, stream: isStream, temperature: req.body.temperature, tools: req.body.tools });
  } else {
    const msgs = [];
    if (req.body.system) msgs.push({ role: 'system', content: req.body.system });
    for (const m of (req.body.messages || [])) msgs.push({ role: m.role, content: Array.isArray(m.content) ? m.content.map(c => c.text || '').join('') : m.content });
    body = JSON.stringify({ model, messages: msgs, max_tokens: req.body.max_tokens || 8192, stream: isStream, temperature: req.body.temperature });
  }

  const options = {
    hostname: provider.host, port: 443, path: provider.path, method: 'POST',
    headers: { ...provider.headers(provider.apiKey), 'Content-Length': Buffer.byteLength(body) }
  };

  if (isStream) { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('X-Accel-Buffering', 'no'); }

  const proxyReq = https.request(options, (proxyRes) => {
    logger.proxy(`Response ${proxyRes.statusCode} from ${provider.name}`);
    if (isStream) {
      if (provider.format === 'anthropic') { proxyRes.pipe(res); return; }
      let buf = '';
      proxyRes.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const d = line.slice(6).trim();
          if (d === '[DONE]') { res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`); continue; }
          try { const p = JSON.parse(d); const text = p.choices?.[0]?.delta?.content; if (text) res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`); } catch {}
        }
      });
      proxyRes.on('end', () => res.end());
      return;
    }
    let rb = '';
    proxyRes.on('data', c => rb += c);
    proxyRes.on('end', () => {
      try {
        const parsed = JSON.parse(rb);
        let final;
        if (provider.format === 'anthropic') {
          final = { ...parsed, model: codename };
          Prompts.save(userId, req.apiKeyType === 'key' ? keyData.id : null, model, codename, req.body.messages, parsed.content?.[0]?.text || '', final.usage?.input_tokens, final.usage?.output_tokens);
        } else {
          const text = parsed.choices?.[0]?.message?.content || '';
          final = { id: 'msg_' + genId().replace(/-/g,''), type: 'message', role: 'assistant', content: [{ type: 'text', text }], model: codename, stop_reason: 'end_turn', usage: { input_tokens: parsed.usage?.prompt_tokens || 0, output_tokens: parsed.usage?.completion_tokens || 0 } };
          Prompts.save(userId, req.apiKeyType === 'key' ? keyData.id : null, model, codename, req.body.messages, text, final.usage.input_tokens, final.usage.output_tokens);
        }
        res.status(proxyRes.statusCode).json(final);
      } catch (e) { logger.error('Parse error', { e: e.message }); res.status(502).json({ error: 'Invalid upstream response' }); }
    });
  });

  proxyReq.on('error', (e) => { logger.error('Proxy error', { e: e.message }); if (!res.headersSent) res.status(502).json({ error: 'Upstream error' }); });
  proxyReq.setTimeout(60000, () => { proxyReq.destroy(); if (!res.headersSent) res.status(504).json({ error: 'Timeout' }); });
  proxyReq.write(body);
  proxyReq.end();
});

/* ── ADMIN ── */
app.get('/api/admin/stats',    requireAdmin, (req, res) => res.json(Admin.stats()));
app.get('/api/admin/users',    requireAdmin, (req, res) => res.json(Users.list()));
app.get('/api/admin/waitlist', requireAdmin, (req, res) => res.json(Waitlist.list()));
app.post('/api/admin/waitlist/:id/approve', requireAdmin, (req, res) => { Waitlist.approve(req.params.id); logger.auth(`Waitlist approved: ${req.params.id}`); res.json({ ok: true }); });
app.post('/api/admin/users/:id/approve',   requireAdmin, (req, res) => { Users.approve(req.params.id); res.json({ ok: true }); });
app.get('/api/admin/prompts',       requireAdmin, (req, res) => res.json(Prompts.list(parseInt(req.query.limit) || 100)));
app.get('/api/admin/prompts/stats', requireAdmin, (req, res) => res.json(Prompts.stats()));

/* ── LOGS ── */
app.get('/api/logs',    requireAuth,  (req, res) => res.json({ lines: logger.tail(parseInt(req.query.n) || 100, req.query.type || 'all') }));
app.delete('/api/logs', requireAdmin, (req, res) => { logger.clear(); res.json({ ok: true }); });

/* ── CLI AUTH ── */
app.get('/cli/auth/start', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  Sessions.create('cli_state_' + state, '_pending_', '_pending_', '_pending_', Date.now() + 5 * 60 * 1000);
  res.json({ state, authUrl: `http://localhost:${PORT}/cli/auth/callback?state=${state}` });
});
app.get('/cli/auth/poll/:state', (req, res) => {
  const entry = Sessions.get('cli_state_' + req.params.state);
  if (!entry) return res.status(404).json({ error: 'Invalid state' });
  if (entry.user_id === '_pending_') return res.json({ status: 'pending' });
  res.json({ status: 'complete', token: entry.name, email: entry.email });
});
app.post('/cli/auth/complete', requireAuth, (req, res) => {
  const { state } = req.body;
  const entry = Sessions.get('cli_state_' + state);
  if (!entry || entry.user_id !== '_pending_') return res.status(400).json({ error: 'Invalid state' });
  const token = genToken();
  Sessions.create(token, req.user.user_id, req.user.email, req.user.name, Date.now() + 30 * 24 * 3600 * 1000);
  Sessions.delete('cli_state_' + state);
  Sessions.create('cli_state_' + state, 'done', req.user.email, token, Date.now() + 5 * 60 * 1000);
  res.json({ ok: true });
});

/* ── STATIC ── */
app.use(express.static(path.join(__dirname, 'public')));
const fs = require('fs');
app.get('*', (req, res) => {
  const reqPath = req.path === '/' ? '/index.html' : req.path;
  const htmlFile = path.join(__dirname, 'public', reqPath.endsWith('.html') ? reqPath : reqPath + '.html');
  if (fs.existsSync(htmlFile)) {
    res.sendFile(htmlFile);
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

/* ── START ── */
app.listen(PORT, () => {
  const p = getProvider();
  logger.success(`Server v2 on http://localhost:${PORT}`);
  logger.info(`Provider: ${p ? p.name : 'MOCK MODE'} | Waitlist: ${REQUIRE_APPROVAL ? 'ON' : 'OFF'} | Limits: ${HOURLY_LIMIT}/hr ${DAILY_LIMIT}/day`);
  console.log(`\n  🌱 Billing v2 → http://localhost:${PORT}\n  Provider: ${p ? p.name : 'MOCK'} | Waitlist: ${REQUIRE_APPROVAL ? 'ON' : 'OFF'}\n  ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? '✓' : '✗'}  OPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY ? '✓' : '✗'}\n`);
});

process.on('uncaughtException',  (e) => logger.error('Uncaught', { message: e.message, stack: e.stack }));
process.on('unhandledRejection', (r) => logger.error('Unhandled', { reason: String(r) }));
