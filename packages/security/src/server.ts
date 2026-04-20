/**
 * Security Service entrypoint.
 *
 * Minimal HTTP server exposing /health for container health checks.
 * The security service is consumed as a library by the API gateway;
 * this entrypoint provides liveness for Docker/Helm.
 */

import http from 'node:http';

const PORT = parseInt(process.env['PORT'] ?? '4004', 10);

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'security-service' }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.on('error', (err) => {
  console.error('Security Service server error:', err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.info(`Security Service listening on port ${PORT}`);
});
