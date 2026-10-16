// A small static file server for a single-page web export (the mobile app's
// `expo export --platform web` output). Unknown paths answer index.html, as a
// single-page app expects. Usage: node static-serve.cjs <dir> <port>
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const [dir, portArg] = process.argv.slice(2);
if (!dir || !portArg) {
  console.error('usage: static-serve.cjs <dir> <port>');
  process.exit(2);
}
const root = path.resolve(dir);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

http
  .createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    let file = path.join(root, path.normalize(rel));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) file = path.join(root, 'index.html');
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
  })
  .listen(Number(portArg), () => console.log(`static-serve: ${root} on :${portArg}`));
