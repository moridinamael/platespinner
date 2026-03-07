import express from 'express';
import { createServer } from 'http';
import https from 'https';
import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { setupWebSocket } from './ws.js';
import projectRoutes, { checkRailwayHealth } from './routes/projects.js';
import taskRoutes from './routes/tasks.js';
import templateRoutes from './routes/templates.js';
import agentRoutes from './routes/agents.js';
import autoclickerRoutes from './routes/autoclicker.js';
import notificationRoutes from './routes/notifications.js';
import * as state from './state.js';
import { broadcast } from './ws.js';
import { startDigestScheduler, stopDigestScheduler } from './digest.js';
import pluginRoutes from './routes/plugins.js';
import { loadPlugins } from './plugins/loader.js';
import { rehydratePRTracking } from './prStatus.js';
import { resolveAndValidate } from './netguard.js';

const MAX_REDIRECT_DEPTH = 5;

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '..', 'dist');

const app = express();
const server = createServer(app);

app.use(express.json());

// Optional token auth for mutating API routes
const API_TOKEN = process.env.APP_API_TOKEN;
if (API_TOKEN) {
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }
    const auth = req.headers.authorization;
    if (auth === `Bearer ${API_TOKEN}`) {
      return next();
    }
    res.status(401).json({ error: 'Invalid or missing API token' });
  });
}

// API routes
app.use('/api', projectRoutes);
app.use('/api', taskRoutes);
app.use('/api', templateRoutes);
app.use('/api', agentRoutes);
app.use('/api', autoclickerRoutes);
app.use('/api', notificationRoutes);
app.use('/api', pluginRoutes);

// Proxy for iframe preview — strips X-Frame-Options / CSP frame-ancestors
app.get('/api/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'url query param required' });

  const depth = parseInt(req.query.depth, 10) || 0;
  if (depth >= MAX_REDIRECT_DEPTH) {
    return res.status(502).json({ error: 'Too many redirects' });
  }

  let parsed, resolvedAddress;
  try {
    ({ parsed, resolvedAddress } = await resolveAndValidate(target));
  } catch (err) {
    const status = err.message.includes('private') || err.message.includes('internal') ? 403 : 400;
    return res.status(status).json({ error: err.message });
  }

  const mod = parsed.protocol === 'https:' ? https : http;
  const options = {
    hostname: resolvedAddress,
    port: parsed.port,
    path: parsed.pathname + parsed.search,
    headers: { 'Accept': 'text/html,*/*', 'Host': parsed.hostname },
    rejectUnauthorized: process.env.PROXY_ALLOW_INSECURE_TLS === '1' ? false : true,
    servername: parsed.hostname,
  };

  const proxyReq = mod.get(options, (upstream) => {
    // Follow redirects — validate target against SSRF before redirecting
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
      const redirectUrl = new URL(upstream.headers.location, target).href;
      resolveAndValidate(redirectUrl)
        .then(() => res.redirect(`/api/proxy?url=${encodeURIComponent(redirectUrl)}&depth=${depth + 1}`))
        .catch(() => res.status(403).json({ error: 'Redirect target is not allowed' }));
      return;
    }

    const ct = upstream.headers['content-type'] || '';
    res.set('Content-Type', ct);
    // Don't forward frame-blocking headers
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');

    if (ct.includes('text/html')) {
      const chunks = [];
      upstream.on('data', (c) => chunks.push(c));
      upstream.on('end', () => {
        let html = Buffer.concat(chunks).toString();
        // Inject <base> so relative URLs resolve against the original site
        const origin = `${parsed.protocol}//${parsed.host}`;
        const baseTag = `<base href="${origin}/">`;
        html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
        res.send(html);
      });
    } else {
      upstream.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    res.status(502).json({ error: `Proxy error: ${err.message}` });
  });
});

// Serve built frontend
app.use(express.static(distPath));
app.get('*', (req, res) => {
  if (API_TOKEN) {
    try {
      let html = readFileSync(join(distPath, 'index.html'), 'utf-8');
      html = html.replace(
        '<head>',
        `<head><script>window.__APP_API_TOKEN__=${JSON.stringify(API_TOKEN)}</script>`
      );
      res.type('html').send(html);
    } catch {
      res.sendFile(join(distPath, 'index.html'));
    }
  } else {
    res.sendFile(join(distPath, 'index.html'));
  }
});

// WebSocket
setupWebSocket(server);

// Periodic Railway health checks (every 90 seconds)
setInterval(async () => {
  const projects = state.getProjects().filter(p => p.railwayProject);
  for (const project of projects) {
    try {
      broadcast('project:railway-checking', { projectId: project.id });
      const result = await checkRailwayHealth(project);
      const railwayResult = { healthy: result.healthy, message: result.message, timestamp: result.timestamp };
      state.updateProject(project.id, { lastRailwayResult: railwayResult });
      broadcast('project:railway-status', { projectId: project.id, ...railwayResult });
    } catch (err) {
      const failResult = { healthy: false, message: err.message, timestamp: Date.now() };
      broadcast('project:railway-status', { projectId: project.id, ...failResult });
    }
  }
}, 90_000);

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';

// Load plugins before starting server
const pluginResult = await loadPlugins();
if (pluginResult.loaded > 0) {
  console.log(`Loaded ${pluginResult.loaded} plugin(s)`);
}
if (pluginResult.errors.length > 0) {
  console.warn(`${pluginResult.errors.length} plugin(s) failed to load`);
}

rehydratePRTracking();

server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`WebSocket available on ws://${HOST}:${PORT}`);
  if (HOST === '127.0.0.1' || HOST === 'localhost') {
    console.log('Listening on localhost only. Set HOST=0.0.0.0 to expose on all interfaces.');
  }
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1' && !API_TOKEN) {
    console.warn('\u26a0 Server is exposed on the network without APP_API_TOKEN. Set APP_API_TOKEN to require auth for mutating requests.');
  }
  startDigestScheduler();
});

process.on('SIGINT', () => { stopDigestScheduler(); process.exit(0); });
process.on('SIGTERM', () => { stopDigestScheduler(); process.exit(0); });
