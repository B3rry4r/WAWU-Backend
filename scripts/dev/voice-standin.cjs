// A stand-in for the AI voice provider, on this machine only (AITOOLS-01,
// AITOOLS-02).
//
//   node scripts/dev/voice-standin.cjs <port|0> [--key <api key>] [--delay-ms <n>]
//
// It answers the calls the Hub's adapter makes, with the same wire shape, from
// ONE ROUTE TABLE (`ROUTES` below): one entry per provider route, each with
// its own markers. A later tool adds its route there and nothing else.
//
//   POST /v1/text-to-speech/<provider voice id>?output_format=mp3_44100_128
//     header xi-api-key, JSON body { text, model_id? }  ->  200 audio/mpeg
//     The model_id of every call is kept in state.models (the last one in
//     state.lastModel), so a spec can see which model ran (Quick voice).
//     The voices it knows are stand-in-ada and stand-in-tunde (give the Hub
//     AI_VOICE_VOICES that names them). It makes silent MP3 frames, a few per
//     20 characters of text. What the text can ask of it (the markers are this
//     stand-in's own):
//       [[fail]]      answer 500, as a provider that is down
//       [[reject]]    answer 422, as a provider that refuses the text
//       [[html]]      answer 200 with a web page, which is not audio
//       [[slow:1500]] wait that many milliseconds before answering
//   POST /v1/sound-generation?output_format=mp3_44100_128   (AITOOLS-03)
//     header xi-api-key, JSON body { text, duration_seconds? }  ->  200 audio/mpeg
//     duration_seconds outside 0.5 to 30 answers 422, as the provider does.
//     Silent MP3 frames of the asked length (2 seconds when none is asked).
//   POST /v1/music?output_format=mp3_44100_128   (AITOOLS-03)
//     header xi-api-key, JSON body { prompt, music_length_ms?, force_instrumental? }
//     ->  200 audio/mpeg. music_length_ms outside 3000 to 600000 answers 422.
//     Silent MP3 frames of the asked length (10 seconds when none is asked).
//     Both take the same markers in the text or prompt as the speech route
//     ([[fail]], [[reject]], [[html]], [[slow:n]]), and [[status:402]] (any
//     400 to 599) to answer that status, as a key or plan refusal does.
//     state.sfx and state.music list each call's asked length and switch
//     (never the words).
//   POST /v1/voices/add   multipart (name, files)  ->  200 { voice_id }
//   DELETE /v1/voices/<id>                         ->  200
//     The own-voice calls (VOICE-01); it then speaks with the voice it made.
//     What the SAMPLE file can ask of it (found in the file's bytes):
//     [[sample-fail]] answers 500, [[sample-reject]] answers 422.
//   POST /v1/speech-to-text   (AITOOLS-04)
//     header xi-api-key, multipart (model_id, file, language_code?,
//     timestamps_granularity?)  ->  200 JSON { language_code, text, words[],
//     audio_duration_secs, transcription_id }. The words are made up
//     (word1 word2 ...), one every half second of the file's length (read
//     from a WAV header, or from MP3 frames of 417 bytes). What the FILE can
//     ask of it (found in the file's bytes, as the voice sample markers are):
//       [[fail]] 500, [[reject]] 422, [[status:402]] (any 400 to 599),
//       [[html]] 200 with a web page, [[slow:1500]] wait, [[nospeech]] an
//       empty transcript, [[reported:SECS]] report that length instead,
//       [[noid]] no transcription_id.
//   DELETE /v1/speech-to-text/transcripts/<id>      ->  200, 404 when none
//     or not stored yet (the real provider answered 404 `transcript_not_found`
//     89 ms after the transcript, and 200 about 40 s later). The file can ask
//     for [[store-delay:MS]]: the copy is not deletable until MS after the
//     answer (the transcript, and the cleaned recording's item, alike).
//   POST /v1/audio-isolation   (AITOOLS-04)
//     header xi-api-key, multipart (audio)  ->  200 audio/mpeg (silent MP3
//     frames of the file's length) with an `audio-isolation-id` header (the
//     real provider's name; it sends no `history-item-id`). The file
//     takes the same [[fail]], [[reject]], [[status:n]], [[html]], [[slow:n]]
//     markers, plus [[iso-type:audio/ogg]] (answer that type) and
//     [[iso-nohistory]] (no audio-isolation-id header).
//   DELETE /v1/audio-isolation/history/<id>         ->  204, 404 when none
//     or not stored yet (as above)
//     state.deleteTries lists every delete try ({ kind, id, status }).
//     state.transcribe and state.isolate list each call (byte count, model,
//     language; never the file); state.deletedTranscripts and
//     state.deletedIsolations list the ids deleted.
//   GET /__standin/state lists the calls so far (never the text).
// Nothing of a real provider beyond these. The Hub never sees a control route.
// Nothing here leaves 127.0.0.1.
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
    /** The model_id of each speech call, in order (null when the Hub sent none). */
    models: [],
    lastModel: null,
    cloned: 0,
    deleted: 0,
    clones: [],
    /** Each Sound effect call: the duration_seconds asked (null when none). */
    sfx: [],
    /** Each Music call: music_length_ms asked (null when none) and force_instrumental. */
    music: [],
    /** Each speech to text call: the model, the language asked (null when none), the file's bytes and the field names sent. */
    transcribe: [],
    /** Each audio isolation call: the file's bytes. */
    isolate: [],
    deletedTranscripts: [],
    deletedIsolations: [],
    /** Every delete try on a transcript or cleaned item, with the status it was answered. */
    deleteTries: [],
  };
  // id -> the time (ms) from which the provider has the copy stored and a delete finds it.
  const transcripts = new Map();
  const isolations = new Map();
  let transcriptSeq = 0;
  let isolationSeq = 0;
  const clones = new Map();
  // MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding: 417 bytes of silence per frame.
  const frame = Buffer.alloc(417);
  frame.writeUInt32BE(0xfffb9004, 0);

  const json = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };

  /** The speech route: counted as a call, with its markers and its model recorded. */
  async function speech(req, res, m, raw) {
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
      if (!VOICES.has(voice) && !clones.has(voice))
        return done(404, 'application/json', '{"detail":"no such voice"}');
      let text = '';
      let model = null;
      try {
        const body = JSON.parse(raw.toString('utf8'));
        text = String(body.text ?? '');
        model = typeof body.model_id === 'string' ? body.model_id : null;
      } catch {
        return done(400, 'application/json', '{"detail":"bad body"}');
      }
      state.voices.push(voice);
      state.models.push(model);
      state.lastModel = model;
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
  }

  // One MP3 frame at 44.1 kHz is 1152 samples: 26.122 ms.
  const FRAME_SECONDS = 1152 / 44100;
  const silence = (seconds) =>
    Buffer.concat(
      Array.from(
        { length: Math.max(1, Math.round(seconds / FRAME_SECONDS)) },
        () => frame,
      ),
    );

  /**
   * The Sound effect and Music routes (AITOOLS-03): counted as calls like the
   * speech route, with the same markers; `kind` says which of the two it is.
   */
  function generation(kind) {
    return async (req, res, _m, raw) => {
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
        let body;
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return done(400, 'application/json', '{"detail":"bad body"}');
        }
        const sfx = kind === 'sfx';
        const text = String((sfx ? body.text : body.prompt) ?? '');
        if (text === '')
          return done(422, 'application/json', '{"detail":"no text"}');
        let seconds;
        if (sfx) {
          const d = body.duration_seconds;
          if (d !== undefined && (typeof d !== 'number' || d < 0.5 || d > 30))
            return done(422, 'application/json', '{"detail":"bad duration"}');
          state.sfx.push(d ?? null);
          seconds = d ?? 2;
        } else {
          const ms = body.music_length_ms;
          if (
            ms !== undefined &&
            (typeof ms !== 'number' || ms < 3000 || ms > 600000)
          )
            return done(422, 'application/json', '{"detail":"bad length"}');
          state.music.push({
            lengthMs: ms ?? null,
            instrumental: body.force_instrumental === true,
          });
          seconds = (ms ?? 10000) / 1000;
        }
        const slow = /\[\[slow:(\d{1,6})\]\]/.exec(text);
        const wait = slow ? Number(slow[1]) : delayMs;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (text.includes('[[fail]]'))
          return done(500, 'application/json', '{"detail":"down"}');
        if (text.includes('[[reject]]'))
          return done(422, 'application/json', '{"detail":"refused"}');
        const status = /\[\[status:(4\d\d|5\d\d)\]\]/.exec(text);
        if (status)
          return done(Number(status[1]), 'application/json', '{"detail":"no"}');
        if (text.includes('[[html]]'))
          return done(200, 'text/html', '<html>not audio</html>');
        return done(200, 'audio/mpeg', silence(seconds));
      } catch {
        return done(500, 'application/json', '{"detail":"stand-in fault"}');
      }
    };
  }

  /** A multipart body as { name -> { filename, type, data } }. */
  function parseMultipart(contentType, raw) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType ?? ''));
    if (!m) return null;
    const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
    const parts = new Map();
    let at = raw.indexOf(boundary);
    while (at >= 0) {
      const next = raw.indexOf(boundary, at + boundary.length);
      if (next < 0) break;
      const part = raw.subarray(at + boundary.length + 2, next - 2);
      const split = part.indexOf('\r\n\r\n');
      if (split >= 0) {
        const head = part.subarray(0, split).toString('latin1');
        const name = /name="([^"]*)"/.exec(head);
        if (name)
          parts.set(name[1], {
            filename: (/filename="([^"]*)"/.exec(head) ?? [])[1] ?? null,
            type: (/content-type:\s*([^\r\n]+)/i.exec(head) ?? [])[1] ?? null,
            data: part.subarray(split + 4),
          });
      }
      at = next;
    }
    return parts;
  }

  /** The length of a file the stand-in is sent, in seconds: a WAV header, MP3 frames, else 10. */
  function lengthOf(data) {
    if (data.length > 44 && data.toString('latin1', 0, 4) === 'RIFF') {
      const byteRate = data.readUInt32LE(28);
      const size = data.readUInt32LE(40);
      if (byteRate > 0) return size / byteRate;
    }
    if (data.length > 417 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0)
      return (data.length / 417) * FRAME_SECONDS;
    return 10;
  }

  /**
   * The file routes (AITOOLS-04): speech to text and audio isolation, counted
   * as calls like the others, with the markers read from the file's bytes.
   */
  function fileRoute(kind) {
    return async (req, res, _m, raw) => {
      state.calls += 1;
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      const done = (status, type, body, headers = {}) => {
        state.active -= 1;
        if (status === 200) state.ok += 1;
        else state.failed += 1;
        res.statusCode = status;
        res.setHeader('content-type', type);
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.end(body);
      };
      try {
        if (req.headers['xi-api-key'] !== key)
          return done(401, 'application/json', '{"detail":"bad key"}');
        const form = parseMultipart(req.headers['content-type'], raw);
        const stt = kind === 'stt';
        const file = form?.get(stt ? 'file' : 'audio');
        if (!form || !file || file.data.length === 0)
          return done(400, 'application/json', '{"detail":"no file"}');
        if (stt && !form.has('model_id'))
          return done(422, 'application/json', '{"detail":"no model"}');
        const bytes = file.data;
        const marks = bytes.toString('latin1');
        const language =
          form.get('language_code')?.data.toString('utf8') ?? null;
        if (stt)
          state.transcribe.push({
            model: form.get('model_id').data.toString('utf8'),
            languageCode: language,
            granularity:
              form.get('timestamps_granularity')?.data.toString('utf8') ?? null,
            bytes: bytes.length,
            fileType: file.type,
          });
        else state.isolate.push({ bytes: bytes.length, fileType: file.type });
        const slow = /\[\[slow:(\d{1,6})\]\]/.exec(marks);
        const wait = slow ? Number(slow[1]) : delayMs;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (marks.includes('[[fail]]'))
          return done(500, 'application/json', '{"detail":"down"}');
        if (marks.includes('[[reject]]'))
          return done(422, 'application/json', '{"detail":"refused"}');
        const status = /\[\[status:(4\d\d|5\d\d)\]\]/.exec(marks);
        if (status)
          return done(Number(status[1]), 'application/json', '{"detail":"no"}');
        if (marks.includes('[[html]]'))
          return done(200, 'text/html', '<html>not what was asked</html>');
        const seconds = lengthOf(bytes);
        if (stt) {
          const reported = /\[\[reported:(\d{1,6})\]\]/.exec(marks);
          const none = marks.includes('[[nospeech]]');
          const count = none
            ? 0
            : Math.min(400, Math.max(1, Math.round(seconds / 0.5)));
          const words = Array.from({ length: count }, (_, i) => ({
            text: `word${i + 1}${(i + 1) % 6 === 0 ? '.' : ''}`,
            type: 'word',
            start: i * 0.5,
            end: i * 0.5 + 0.4,
            speaker_id: 'speaker_0',
          }));
          const id = marks.includes('[[noid]]')
            ? undefined
            : `tr-${++transcriptSeq}`;
          if (id) transcripts.set(id, Date.now() + storeDelayOf(marks));
          return done(
            200,
            'application/json',
            JSON.stringify({
              language_code: language ?? 'en',
              language_probability: 0.99,
              text: words.map((w) => w.text).join(' '),
              words,
              audio_duration_secs: reported ? Number(reported[1]) : seconds,
              ...(id ? { transcription_id: id } : {}),
            }),
          );
        }
        const kindOverride = /\[\[iso-type:([a-z]+\/[a-z0-9.+-]+)\]\]/.exec(
          marks,
        );
        const id = `iso-${++isolationSeq}`;
        const headers = {};
        if (!marks.includes('[[iso-nohistory]]')) {
          isolations.set(id, Date.now() + storeDelayOf(marks));
          headers['audio-isolation-id'] = id;
        }
        return done(
          200,
          kindOverride ? kindOverride[1] : 'audio/mpeg',
          silence(seconds),
          headers,
        );
      } catch {
        return done(500, 'application/json', '{"detail":"stand-in fault"}');
      }
    };
  }

  /** How long after the answer the file asks the provider to take to store its copy ([[store-delay:MS]]). */
  function storeDelayOf(marks) {
    const m = /\[\[store-delay:(\d{1,7})\]\]/.exec(marks);
    return m ? Number(m[1]) : 0;
  }

  /**
   * DELETE of a transcript (200) or a cleaned item (204). A copy the provider
   * has not stored yet answers 404 like one that does not exist, and the try
   * can be made again.
   */
  function removeFrom(items, list, kind, okStatus) {
    return (req, res, m) => {
      if (req.headers['xi-api-key'] !== key)
        return json(res, 401, { detail: 'bad key' });
      const id = decodeURIComponent(m[1]);
      const storedAt = items.get(id);
      if (storedAt === undefined || Date.now() < storedAt) {
        state.deleteTries.push({ kind, id, status: 404 });
        return json(res, 404, { detail: 'no such item' });
      }
      items.delete(id);
      list.push(id);
      state.deleteTries.push({ kind, id, status: okStatus });
      if (okStatus === 204) {
        res.statusCode = 204;
        return res.end();
      }
      return json(res, okStatus, { status: 'ok' });
    };
  }

  /** The own-voice routes (VOICE-01). */
  function addVoice(req, res, _m, raw) {
    if (req.headers['xi-api-key'] !== key)
      return json(res, 401, { detail: 'bad key' });
    const type = String(req.headers['content-type'] ?? '');
    if (!type.startsWith('multipart/form-data') || raw.length === 0)
      return json(res, 400, { detail: 'bad body' });
    const text = raw.toString('latin1');
    if (!text.includes('name="files"'))
      return json(res, 400, { detail: 'no file' });
    state.cloned += 1;
    if (text.includes('[[sample-fail]]'))
      return json(res, 500, { detail: 'down' });
    if (text.includes('[[sample-reject]]'))
      return json(res, 422, { detail: 'refused' });
    const id = `clone-${state.cloned}`;
    clones.set(id, raw.length);
    state.clones.push(id);
    return json(res, 200, { voice_id: id });
  }

  function removeVoice(req, res, m) {
    if (req.headers['xi-api-key'] !== key)
      return json(res, 401, { detail: 'bad key' });
    const id = decodeURIComponent(m[1]);
    if (!clones.delete(id)) return json(res, 404, { detail: 'no such voice' });
    state.deleted += 1;
    return json(res, 200, { status: 'ok' });
  }

  function stateRoute(_req, res) {
    return json(res, 200, state);
  }

  // One entry per provider route the Hub calls: method, path pattern, handler
  // (req, res, match, raw body). A later tool adds its route here.
  const ROUTES = [
    { method: 'GET', path: /^\/__standin\/state$/, handle: stateRoute },
    { method: 'POST', path: /^\/v1\/text-to-speech\/([^/]+)$/, handle: speech },
    {
      method: 'POST',
      path: /^\/v1\/sound-generation$/,
      handle: generation('sfx'),
    },
    { method: 'POST', path: /^\/v1\/music$/, handle: generation('music') },
    {
      method: 'POST',
      path: /^\/v1\/speech-to-text$/,
      handle: fileRoute('stt'),
    },
    {
      method: 'DELETE',
      path: /^\/v1\/speech-to-text\/transcripts\/([^/]+)$/,
      handle: removeFrom(
        transcripts,
        state.deletedTranscripts,
        'transcript',
        200,
      ),
    },
    {
      method: 'POST',
      path: /^\/v1\/audio-isolation$/,
      handle: fileRoute('iso'),
    },
    {
      method: 'DELETE',
      path: /^\/v1\/audio-isolation\/history\/([^/]+)$/,
      handle: removeFrom(
        isolations,
        state.deletedIsolations,
        'isolation',
        204,
      ),
    },
    { method: 'POST', path: /^\/v1\/voices\/add$/, handle: addVoice },
    { method: 'DELETE', path: /^\/v1\/voices\/([^/]+)$/, handle: removeVoice },
  ];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let route = null;
    let match = null;
    for (const r of ROUTES) {
      if (r.method !== req.method) continue;
      match = r.path.exec(url.pathname);
      if (match) {
        route = r;
        break;
      }
    }
    if (!route) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      void route.handle(req, res, match, Buffer.concat(parts));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        server,
        port: server.address().port,
        state,
        /** Voices made and not yet removed. */
        openClones: () => clones.size,
        /** Transcripts and cleaned recordings the provider still holds (AITOOLS-04). */
        openTranscripts: () => transcripts.size,
        openIsolations: () => isolations.size,
      }),
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
