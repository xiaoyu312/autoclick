'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const fixture = fs.readFileSync(path.join(__dirname, 'smoke-fixture.html'));
const smokeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclick-desktop-smoke-'));
const fixtureSockets = new Set();

const server = http.createServer((request, response) => {
  if (request.url?.includes('/inactive-opener-fail')) {
    request.socket.destroy();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': fixture.length });
  response.end(fixture);
});
server.on('connection', (socket) => {
  fixtureSockets.add(socket);
  socket.on('close', () => fixtureSockets.delete(socket));
});

server.listen(0, '127.0.0.1', () => {
  const { address, port } = server.address();
  const electronPath = require('electron');
  const child = spawn(electronPath, ['.'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AUTOCLICK_SMOKE: '1',
      AUTOCLICK_SMOKE_USER_DATA: smokeUserData,
      AUTOCLICK_SMOKE_URL: `http://${address}:${port}/fixture`,
      ELECTRON_DISABLE_GPU: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let finished = false;
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
    finish(1, `${output}\nSmoke timeout after 30 seconds`);
  }, 30000);
  child.on('exit', (code, signal) => {
    clearTimeout(timeout);
    finish(code === 0 ? 0 : 1, output + (signal ? `\nSignal: ${signal}` : ''));
  });
  child.on('error', (error) => finish(1, `${output}\nSmoke child error: ${error.message}`));

  function finish(code, text) {
    if (finished) return;
    finished = true;
    for (const socket of fixtureSockets) socket.destroy();
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    server.close(() => {
      fs.rmSync(smokeUserData, { recursive: true, force: true });
      process.stdout.write(text);
      process.exitCode = code;
    });
  }
});
