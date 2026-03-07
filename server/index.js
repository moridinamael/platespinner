import express from 'express';
import { createServer } from 'http';
import https from 'https';
import http from 'http';
import dns from 'dns';
import net from 'net';
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

function isPrivateIP(ip) {
  // Handle IPv4-mapped IPv6 (::ffff:x.x.x.x)
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  if (net.isIPv4(ip)) {
    const octets = ip.split('.').map(Number);
    const [a, b] = octets;
    if (a === 0) return true;         // 0.0.0.0/8
    if (a === 10) return true;        // 10.0.0.0/8
    if (a === 127) return true;       // 127.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16
    return false;
  }

  if (net.isIPv6(ip)) {
    if (ip === '::1') return true;    // loopback
    const groups = ip.split(':');
    const first = groups[0].toLowerCase();
    if (first.length > 0) {
      const val = parseInt(first, 16);
      if (val >= 0xfc00 && val <= 0xfdff) return true; // fc00::/7
      if (val >= 0xfe80 && val <= 0xfebf) return true; // fe80::/10
    }
    return false;
  }

  return true; // Unknown format — reject to be safe
}

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

  let parsed;
  try { parsed = new URL(target); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'Only http and https URLs are allowed' });
  }

  let resolvedAddress;
  try {
    const { address } = await dns.promises.lookup(parsed.hostname);
    if (isPrivateIP(address)) {
      return res.status(403).json({ error: 'Access to private/internal addresses is not allowed' });
    }
    resolvedAddress = address;
  } catch (err) {
    return res.status(400).json({ error: `Cannot resolve hostname: ${err.message}` });
  }

  const mod = parsed.protocol === 'https:' ? https : http;
  const options = {
    hostname: resolvedAddress,
    port: parsed.port,
    path: parsed.pathname + parsed.search,
    headers: { 'Accept': 'text/html,*/*', 'Host': parsed.hostname },
    rejectUnauthorized: false,
    servername: parsed.hostname,
  };

  const proxyReq = mod.get(options, (upstream) => {
    // Follow redirects
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
      const redirectUrl = new URL(upstream.headers.location, target).href;
      return res.redirect(`/api/proxy?url=${encodeURIComponent(redirectUrl)}`);
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
