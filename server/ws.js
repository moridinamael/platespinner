import { WebSocketServer } from 'ws';

let wss;

export function setupWebSocket(server) {
  const apiToken = process.env.APP_API_TOKEN;
  wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: apiToken
      ? ({ req }, done) => {
          const url = new URL(req.url, 'http://localhost');
          const token = url.searchParams.get('token');
          done(token === apiToken);
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
