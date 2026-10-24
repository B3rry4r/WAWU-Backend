// A stand-in for the Hub's object storage, on this machine only (AITOOLS-01).
//
//   node scripts/dev/storage-standin.cjs <port> [bucket]
//
// Path-style S3 for what the Hub does with a file it makes itself: PUT, GET,
// HEAD and DELETE of /<bucket>/<key>. It does not check signatures. Point a
// stack at it with STACK_STORAGE_ENDPOINT=http://127.0.0.1:<port> and
// STACK_STORAGE_PATH_STYLE=true (README, "Local test stack"). Objects are kept
// in memory, and a GET with a Range header answers 206 with those bytes only.
// GET /__standin/state lists the keys held. Nothing leaves 127.0.0.1.
'use strict';

const http = require('node:http');

const port = Number(process.argv[2] ?? 0);
const bucket = process.argv[3] ?? 'stack-bucket';
const objects = new Map();

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/__standin/state') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [...objects.keys()] }));
      return;
    }
    const prefix = `/${bucket}/`;
    if (!url.pathname.startsWith(prefix)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'PUT') {
        objects.set(key, {
          body: Buffer.concat(chunks),
          type: req.headers['content-type'] || 'application/octet-stream',
        });
        res.statusCode = 200;
        res.end();
      } else if (req.method === 'DELETE') {
        objects.delete(key);
        res.statusCode = 204;
        res.end();
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        const o = objects.get(key);
        if (!o) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('content-type', url.searchParams.get('response-content-type') || o.type);
        res.setHeader('accept-ranges', 'bytes');
        // A ranged read (bytes=a-b, bytes=a-, bytes=-n) answers 206 with only
        // those bytes, like a real store (AITOOLS-04 round 4: without this
        // every 16 KB head read on the stack downloaded the whole object).
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
        if (range && (range[1] !== '' || range[2] !== '')) {
          const total = o.body.length;
          let from = range[1] === '' ? Math.max(0, total - Number(range[2])) : Number(range[1]);
          let to = range[1] === '' || range[2] === '' ? total - 1 : Math.min(Number(range[2]), total - 1);
          if (from >= total || from > to) {
            res.statusCode = 416;
            res.setHeader('content-range', `bytes */${total}`);
            res.end();
            return;
          }
          res.statusCode = 206;
          res.setHeader('content-range', `bytes ${from}-${to}/${total}`);
          res.setHeader('content-length', to - from + 1);
          res.end(req.method === 'HEAD' ? undefined : o.body.subarray(from, to + 1));
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-length', o.body.length);
        res.end(req.method === 'HEAD' ? undefined : o.body);
      } else {
        res.statusCode = 405;
        res.end();
      }
    });
  })
  .listen(port, '127.0.0.1', function () {
    console.log(`LISTENING ${this.address().port}`);
  });
