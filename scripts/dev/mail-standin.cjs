#!/usr/bin/env node
/*
 * A local stand-in for Resend, for a stack that needs to see the email WAWU ID
 * sends (FIX-53: the data-export link). WAWU ID's mail service reads
 * RESEND_BASE_URL, so start this, then start the stack with
 *   RESEND_BASE_URL=http://127.0.0.1:<port> STACK_RESEND_API_KEY=re_local
 * and every mail WAWU ID sends lands here instead of a mail service.
 *
 *   node scripts/dev/mail-standin.cjs <port> <file>
 *
 * Each POST /emails is appended to <file> as one JSON line
 * { id, receivedAt, to, subject, html } and answered { id } like Resend does.
 * GET /recorded answers the lines so far. Binds 127.0.0.1 only.
 */
const http = require('node:http');
const fs = require('node:fs');

const port = Number(process.argv[2]);
const file = process.argv[3];
if (!Number.isInteger(port) || !file) {
  console.error('usage: mail-standin.cjs <port> <file>');
  process.exit(2);
}
let n = 0;

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/recorded') {
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(text);
      return;
    }
    if (req.method === 'POST' && req.url === '/emails') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'not JSON' }));
          return;
        }
        n += 1;
        const id = `standin_${Date.now()}_${n}`;
        const to = Array.isArray(body.to) ? body.to.join(',') : String(body.to);
        fs.appendFileSync(
          file,
          JSON.stringify({
            id,
            receivedAt: new Date().toISOString(),
            to,
            subject: body.subject,
            html: body.html,
          }) + '\n',
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  })
  .listen(port, '127.0.0.1', () =>
    console.log(`mail stand-in on 127.0.0.1:${port}, recording to ${file}`),
  );
