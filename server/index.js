import express from 'express';
import { createServer } from 'http';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { setupWebSocket } from './ws.js';
import projectRoutes from './routes/projects.js';
import taskRoutes from './routes/tasks.js';
import templateRoutes from './routes/templates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '..', 'dist');

const app = express();
const server = createServer(app);

app.use(express.json());

// API routes
app.use('/api', projectRoutes);
app.use('/api', taskRoutes);
app.use('/api', templateRoutes);

// Proxy for iframe preview — strips X-Frame-Options / CSP frame-ancestors
app.get('/api/proxy', (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'url query param required' });

  let parsed;
  try { parsed = new URL(target); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const mod = parsed.protocol === 'https:' ? https : http;
  const options = {
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.pathname + parsed.search,
    headers: { 'Accept': 'text/html,*/*', 'Host': parsed.hostname },
    rejectAuthorized: false,
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
  res.sendFile(join(distPath, 'index.html'));
});

// WebSocket
setupWebSocket(server);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket available on ws://localhost:${PORT}`);
});
