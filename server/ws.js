import { WebSocketServer } from 'ws';

let wss;

export function setupWebSocket(server) {
  const apiToken = process.env.APP_API_TOKEN;
  wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: apiToken
      ? ({ req }, done) => {
          // Check query param (for API/CLI consumers)
          const url = new URL(req.url, 'http://localhost');
          const qToken = url.searchParams.get('token');
          if (qToken === apiToken) return done(true);
          // Check HttpOnly cookie (for browser sessions)
          const cookieHeader = req.headers.cookie || '';
          const match = cookieHeader.split(';').find(c => c.trim().startsWith('platespinner_auth='));
          const cToken = match ? decodeURIComponent(match.split('=')[1].trim()) : null;
          done(cToken === apiToken);
        }
      : undefined,
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });

  // Heartbeat every 30s
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(interval));

  return wss;
}

export function broadcast(event, data) {
  if (!wss) return;
  const message = JSON.stringify({ event, data });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}
