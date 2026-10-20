// A stand-in for the AI voice provider, on this machine only (AITOOLS-01).
//
//   node scripts/dev/voice-standin.cjs <port|0> [--key <api key>] [--delay-ms <n>]
//
// It answers the one call the Hub's adapter makes, with the same wire shape:
//   POST /v1/text-to-speech/<provider voice id>?output_format=mp3_44100_128
//   header xi-api-key, JSON body { text, model_id? }  ->  200 audio/mpeg
// and nothing else of a real provider. The voices it knows are
// stand-in-ada and stand-in-tunde (give the Hub AI_VOICE_VOICES that names them).
// It makes silent MP3 frames, a few per 20 characters of text.
//
// What the text can ask of it (the markers are this stand-in's own):
//   [[fail]]      answer 500, as a provider that is down
//   [[reject]]    answer 422, as a provider that refuses the text
//   [[html]]      answer 200 with a web page, which is not audio
//   [[slow:1500]] wait that many milliseconds before answering
// GET /__standin/state lists the calls so far (never the text).
// The Hub never sees a control route. Nothing here leaves 127.0.0.1.
'use strict';

const http = require('node:http');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

function startVoiceStandin({
  port = 0,
  key = 'standin-key',
  delayMs = 0,
} = {}) {
  const VOICES = new Set(['stand-in-ada', 'stand-in-tunde']);
  const state = {
    calls: 0,
    ok: 0,
    failed: 0,
    active: 0,
    maxActive: 0,
    voices: [],
  };
  // MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding: 417 bytes of silence per frame.
  const frame = Buffer.alloc(417);
  frame.writeUInt32BE(0xfffb9004, 0);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/__standin/state') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(state));
      return;
    }
    const m = /^\/v1\/text-to-speech\/([^/]+)$/.exec(url.pathname);
    if (req.method !== 'POST' || !m) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      state.calls += 1;
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      const done = (status, type, body) => {
        state.active -= 1;
        if (status === 200) state.ok += 1;
        else state.failed += 1;
        res.statusCode = status;
        res.setHeader('content-type', type);
        res.end(body);
      };
      try {
        if (req.headers['xi-api-key'] !== key)
          return done(401, 'application/json', '{"detail":"bad key"}');
        const voice = decodeURIComponent(m[1]);
        if (!VOICES.has(voice))
          return done(404, 'application/json', '{"detail":"no such voice"}');
        let text = '';
        try {
          text = String(
            JSON.parse(Buffer.concat(chunks).toString('utf8')).text ?? '',
          );
        } catch {
          return done(400, 'application/json', '{"detail":"bad body"}');
        }
        state.voices.push(voice);
        const slow = /\[\[slow:(\d{1,6})\]\]/.exec(text);
        const wait = slow ? Number(slow[1]) : delayMs;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (text.includes('[[fail]]'))
          return done(500, 'application/json', '{"detail":"down"}');
        if (text.includes('[[reject]]'))
          return done(422, 'application/json', '{"detail":"refused"}');
        if (text.includes('[[html]]'))
          return done(200, 'text/html', '<html>not audio</html>');
        const frames = Math.max(4, Math.ceil(text.length / 20));
        return done(
          200,
          'audio/mpeg',
          Buffer.concat(Array.from({ length: frames }, () => frame)),
        );
      } catch {
        return done(500, 'application/json', '{"detail":"stand-in fault"}');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({ server, port: server.address().port, state }),
    );
  });
}

module.exports = { startVoiceStandin };

if (require.main === module) {
  startVoiceStandin({
    port: Number(args[0] ?? 0),
    key: opt('--key', 'standin-key'),
    delayMs: Number(opt('--delay-ms', 0)),
  }).then(({ port }) => {
    console.log(`LISTENING ${port}`);
  });
}
