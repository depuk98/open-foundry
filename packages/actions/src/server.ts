/**
 * Action Executor service entrypoint.
 *
 * Minimal HTTP server exposing /health for container health checks.
 * The action executor is consumed as a library by the API gateway;
 * this entrypoint provides liveness for Docker/Helm.
 */

import http from 'node:http';

const PORT = parseInt(process.env['PORT'] ?? '4002', 10);

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'action-executor' }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.on('error', (err) => {
  console.error('Action Executor server error:', err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.info(`Action Executor listening on port ${PORT}`);
});
