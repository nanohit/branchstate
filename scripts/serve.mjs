// Статический сервер для dist/: оболочка и комплекты версий, как на своём домене и CDN.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.bin': 'application/octet-stream' };

export function serve(dist, port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x').pathname;
    const file = path.join(dist, url === '/' ? 'index.html' : url);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    // Файлы комплектов неизменяемы; оболочка и latest.json всегда сверяются.
    const immutable = url.startsWith('/cdn/') && !url.endsWith('latest.json');
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 5173);
  await serve(path.resolve(import.meta.dirname, '../dist'), port);
  console.log(`http://localhost:${port}`);
}
