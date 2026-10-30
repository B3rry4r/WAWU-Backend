// A stand-in for the AI voice provider, on this machine only (AITOOLS-01,
// AITOOLS-02).
//
//   node scripts/dev/voice-standin.cjs <port|0> [--key <api key>] [--delay-ms <n>] [--dub-delay-ms <n>] [--gen-delay-ms <n>]
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
//     AITOOLS-07: a sample that holds [[remove-fail]] makes the voice it
//     becomes undeletable (DELETE answers 500, counted in state.removeRefused)
//     until the handle's releaseStubborn() is called, as a provider that is down
//     when the Hub tries to drop a person's voice.
//   GET /v1/voices?page_size=100   (AITOOLS-07, the provider's own list)
//     header xi-api-key  ->  200 { voices: [{ voice_id, name, category,
//     preview_url }] } for stand-in-ada and stand-in-tunde. The real answer
//     (24 Oct 2026, 24 voices) has those four fields and more; preview_url is an
//     https link there and an http link on this machine.
//   GET /__standin/sample/<voice>.mp3   a sample's audio (silent frames), no key.
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
//     [[ack-then-appear:MS]] (transcripts only): a DELETE sent before MS after
//     the answer answers 200 and does nothing, and the copy is still there
//     afterwards (what 4 of 6 real runs showed, 24 Oct 2026): only a DELETE
//     after MS removes it.
//     [[get404-after-delete:MS]] (with ack-then-appear): after such a DELETE
//     that removed nothing, a GET answers 404 for MS and the copy then shows
//     again (200). What the real provider did for 8 of 9 transcripts.
//   GET /v1/speech-to-text/transcripts/<id>         ->  200 { transcription_id,
//     text } while the provider holds the copy (from the answer on, even while
//     a DELETE still answers 404: the real provider returned 200 with the full
//     text 89 ms after the answer), 404 once it is deleted or never existed.
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
//   POST /v1/dubbing/project   (AITOOLS-05)
//     header xi-api-key, multipart (file, target_language, source_language?,
//     model_id?)  ->  201 JSON { project_id, status: queued, language_ids: [one]
//     (the target_language shortcut), ... }. A missing or malformed
//     target_language is 422. What the FILE can ask of it (found in its bytes):
//       [[fail]] 500, [[reject]] 422, [[status:402]] (any 400 to 599), [[html]]
//       200 with a web page, [[slow:1500]] wait, [[dub-nolang]] answer no
//       language_ids, [[dub-delay:MS]] how long until the dub is completed
//       (the project is `queued` for the first third and `processing` for the
//       rest; the default is --dub-delay-ms, 0: completed at the first read),
//       [[dub-failed]] the language ends `failed` (with an error text), [[dub-stale]]
//       the language reads `stale`, [[dub-stuck]] it stays `processing` forever,
//       [[dub-noaudio]] completed with no lossless_audio link, [[dub-nosubs]] no
//       subtitles link, [[dub-outfail]] the audio link answers 500, [[dub-notflac]]
//       the audio is not a FLAC file, [[dub-badvtt]] the subtitles are not WebVTT,
//       [[dub-bytes:N]] the audio is N bytes, [[store-delay:MS]],
//       [[ack-then-appear:MS]] and [[get404-after-delete:MS]] as for a transcript
//       (a dub project is deletable from MS after the answer, and so on).
//   GET /v1/dubbing/project/<id>/language/<id>   ->  200 JSON { language_id,
//     project_id, target_language, status: queued | processing | completed |
//     stale | failed, outputs: { lossless_audio, subtitles } | null, error }.
//     The two links are absolute links back to this stand-in
//     (/__standin/dub-out/<project>/audio and /subtitles); they are fetched with
//     no key (state.dubKeyLeaks counts a fetch that sent one) and every fetch is
//     listed in state.dubDownloads. 404 for a project that is deleted or unknown.
//   GET /v1/dubbing/project/<id>   ->  200 { project_id, status: ready } while
//     the provider holds the project, 404 once deleted (the hidden window above
//     applies). DELETE /v1/dubbing/project/<id>  ->  204, 404 when none or not
//     stored yet. state.dubs lists each start (target, source, bytes, type,
//     model; never the file); state.dubReads each language read;
//     state.deletedDubs the project ids deleted.
//   POST /v1/assets   (AITOOLS-09, AITOOLS-10)
//     header xi-api-key, multipart (asset, name)  ->  200 JSON { asset_id, name,
//     mime_type, created_at_unix, content_url: null }. A missing asset or name
//     is 422. What the FILE can ask of it (found in its bytes): [[asset-fail]]
//     500, [[asset-reject]] 422, [[asset-delete-fail]] the asset cannot be
//     deleted (DELETE answers 500) until the handle's releaseStubborn().
//   DELETE /v1/assets/<id>   ->  204, 404 when none. state.assets lists each
//     upload (bytes and type, never the file); state.deletedAssets the ids
//     deleted; openAssets() the assets the provider still holds.
//   POST /v1/flows/image   (AITOOLS-09)
//     header xi-api-key, JSON { model_id, prompt, aspect_ratio?, resolution?,
//     images? [{ type: asset, asset_id }] }  ->  200 { id, status: pending }.
//     An unknown model, an empty prompt, a shape or size outside the model's
//     lists, or an image that names an asset the stand-in does not hold is 422.
//   POST /v1/flows/video   (AITOOLS-10)
//     Veo: { model_id, prompt, duration_secs: "4" | "6" | "8", aspect_ratio?,
//     resolution?, generate_audio?, start_frame? }. Aurora: { model_id,
//     image: { type: asset, asset_id }, audio: { type: asset, asset_id },
//     resolution? }.  ->  200 { id, status: pending }.
//     What the PROMPT (a clip and a picture) or the ASSET FILES (an edit and a
//     talking photo) can ask of it (found in their bytes):
//       [[reject]] the POST answers 422, [[start-fail]] 500, [[status:402]]
//       (any 400 to 599), [[fail]] the generation ends failed (model_error),
//       [[moderated]] failed (moderated), [[invalid]] failed
//       (invalid_parameters), [[slow:MS]] how long until it is completed (the
//       generation is pending for the first third and generating for the rest;
//       the default is --gen-delay-ms, 0: completed at the first read),
//       [[stuck]] it stays generating forever, [[type:MIME]] the file's type,
//       [[bytes:N]] the file is N bytes (streamed, never built whole),
//       [[nolink]] completed with no link, [[outfail]] the link answers 500.
//   GET /v1/flows/image/<id> and /v1/flows/video/<id>  ->  200 { status:
//     pending | generating | completed | failed, id, content_url,
//     content_mime_type | failure_reason, error_message }. The link is
//     absolute and back to this stand-in (/__standin/gen-out/<id>); it is
//     fetched with no key (state.genKeyLeaks counts a fetch that sent one).
//     state.images and state.videos list each start (model, shape, size,
//     length, the assets named; never the words), state.genReads each read and
//     state.genDownloads each fetch of a link.
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
  dubDelayMs = 0,
  genDelayMs = 0,
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
    /** Deletes of a voice refused on purpose (a sample with [[remove-fail]]). */
    removeRefused: 0,
    /** Reads of the provider's voice list. */
    voiceListReads: 0,
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
    /** Every read of a transcript or dub project copy by id, with the status it was answered. */
    reads: [],
    /** Each Dubbing start (AITOOLS-05): the target and source language, the model, the file's bytes and type. */
    dubs: [],
    /** Each read of a dub's language target: the project, the language and the status answered. */
    dubReads: [],
    /** Each fetch of a dub's signed link: the project, `audio` or `subtitles`, the status, and whether the fetch sent the provider's key. */
    dubDownloads: [],
    /** Fetches of a signed link that carried the provider's key (the Hub must never send it). */
    dubKeyLeaks: 0,
    deletedDubs: [],
    /** Each asset upload (AITOOLS-09, AITOOLS-10): the id, bytes and type; never the file. */
    assets: [],
    deletedAssets: [],
    /** Each picture start: the model, shape, size, the assets named and the description's length. */
    images: [],
    /** Each video start: a clip or a talking photo, the model, shape, length, size, sound and the assets named. */
    videos: [],
    /** Each read of a generation and the status answered. */
    genReads: [],
    /** Each fetch of a generation's link, the status, and whether it carried the provider's key. */
    genDownloads: [],
    genKeyLeaks: 0,
  };
  // asset id -> { bytes, type, marks }.
  const assets = new Map();
  let assetSeq = 0;
  // generation id -> what it was asked for and when it began.
  const gens = new Map();
  let genSeq = 0;
  // project id -> the dub: its language, when it began, how long it takes, what its file asked for, and the delete fields shared with the transcripts.
  const dubProjects = new Map();
  let dubSeq = 0;
  // id -> { storedAt: the time (ms) from which a delete finds the copy, ackUntil: before it a delete answers 200 and removes nothing }.
  const transcripts = new Map();
  const isolations = new Map();
  let transcriptSeq = 0;
  let isolationSeq = 0;
  const clones = new Map();
  /** Voices that refuse to be deleted (a sample with [[remove-fail]]), until released. */
  const stubborn = new Set();
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
          if (id)
            transcripts.set(id, {
              storedAt: Date.now() + storeDelayOf(marks),
              ackUntil: Date.now() + ackDelayOf(marks),
              hideMs: hideDelayOf(marks),
              hiddenUntil: 0,
            });
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
          isolations.set(id, {
            storedAt: Date.now() + storeDelayOf(marks),
            ackUntil: 0,
          });
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

  /** How long after the answer a DELETE is only acknowledged ([[ack-then-appear:MS]]). */
  function ackDelayOf(marks) {
    const m = /\[\[ack-then-appear:(\d{1,7})\]\]/.exec(marks);
    return m ? Number(m[1]) : 0;
  }

  /** How long a read answers 404 after a DELETE that removed nothing, before the copy shows again ([[get404-after-delete:MS]]). */
  function hideDelayOf(marks) {
    const m = /\[\[get404-after-delete:(\d{1,7})\]\]/.exec(marks);
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
      const item = items.get(id);
      if (item === undefined || Date.now() < item.storedAt) {
        state.deleteTries.push({ kind, id, status: 404 });
        return json(res, 404, { detail: 'no such item' });
      }
      if (Date.now() < item.ackUntil) {
        // Acknowledged, nothing removed: the copy is still there afterwards
        // (hidden from a read for the first hideMs, if the file asked).
        item.hiddenUntil = Date.now() + (item.hideMs || 0);
        state.deleteTries.push({ kind, id, status: okStatus, kept: true });
        if (okStatus === 204) {
          res.statusCode = 204;
          return res.end();
        }
        return json(res, okStatus, { status: 'ok' });
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

  /** GET of a transcript by id: 200 while the provider holds the copy, else 404. */
  function readTranscript(req, res, m) {
    if (req.headers['xi-api-key'] !== key)
      return json(res, 401, { detail: 'bad key' });
    const id = decodeURIComponent(m[1]);
    const item = transcripts.get(id);
    // Held but hidden: a read answers 404 for hideMs after a delete that
    // removed nothing, and the copy then shows again (the real provider,
    // 24 Oct 2026: 8 of 9 transcripts).
    const hidden = item !== undefined && Date.now() < item.hiddenUntil;
    const status = item !== undefined && !hidden ? 200 : 404;
    state.reads.push({ kind: 'transcript', id, status, ...(hidden ? { hidden: true } : {}) });
    if (status === 404) return json(res, 404, { detail: 'no such item' });
    return json(res, 200, { transcription_id: id, text: 'stand-in words' });
  }

  /** A FLAC file for a dub: the marker, a STREAMINFO block for `seconds` of 44.1 kHz stereo, then filler. */
  function flacOf(seconds, size) {
    const head = Buffer.alloc(8 + 34);
    head.write('fLaC', 0, 'latin1');
    head[4] = 0x80; // last metadata block, type STREAMINFO
    head.writeUIntBE(34, 5, 3);
    const total = Math.round(seconds * 44100);
    // 16-bit min and max block size, 24-bit min and max frame size, then
    // 20 bits of sample rate, 3 of channels - 1, 5 of bits per sample - 1, 36 of total samples.
    head.writeUInt16BE(4096, 8);
    head.writeUInt16BE(4096, 10);
    const packed = (BigInt(44100) << 44n) | (1n << 41n) | (15n << 36n) | BigInt(total);
    head.writeBigUInt64BE(packed, 18);
    return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 7)]);
  }

  function vttOf(seconds) {
    const cues = Math.min(60, Math.max(1, Math.round(seconds / 2)));
    const at = (t) => {
      const ms = Math.round(t * 1000);
      const p = (n, w) => String(n).padStart(w, '0');
      return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor(ms / 60000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)}.${p(ms % 1000, 3)}`;
    };
    let out = 'WEBVTT\n\n';
    for (let i = 0; i < cues; i++)
      out += `${at(i * 2)} --> ${at(i * 2 + 1.8)}\ndubbed line ${i + 1}\n\n`;
    return out;
  }

  /** POST /v1/dubbing/project: counted as a call, with the markers read from the file's bytes. */
  async function dubStart(req, res, _m, raw) {
    state.calls += 1;
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    const done = (status, type, body) => {
      state.active -= 1;
      if (status === 200 || status === 201) state.ok += 1;
      else state.failed += 1;
      res.statusCode = status;
      res.setHeader('content-type', type);
      res.end(body);
    };
    try {
      if (req.headers['xi-api-key'] !== key)
        return done(401, 'application/json', '{"detail":"bad key"}');
      const form = parseMultipart(req.headers['content-type'], raw);
      const file = form?.get('file');
      if (!form || !file || file.data.length === 0)
        return done(400, 'application/json', '{"detail":"no file"}');
      const tag = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
      const target = form.get('target_language')?.data.toString('utf8') ?? '';
      const source = form.get('source_language')?.data.toString('utf8') ?? null;
      if (!tag.test(target) || (source !== null && !tag.test(source)))
        return done(422, 'application/json', '{"detail":"bad language"}');
      const marks = file.data.toString('latin1');
      state.dubs.push({
        target,
        source,
        model: form.get('model_id')?.data.toString('utf8') ?? null,
        bytes: file.data.length,
        fileType: file.type,
      });
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
      const n = ++dubSeq;
      const id = `dub-${n}`;
      const delay = /\[\[dub-delay:(\d{1,8})\]\]/.exec(marks);
      const bytes = /\[\[dub-bytes:(\d{1,9})\]\]/.exec(marks);
      const seconds = lengthOf(file.data);
      dubProjects.set(id, {
        languageId: `lang-${n}`,
        target,
        beganAt: Date.now(),
        delayMs: delay ? Number(delay[1]) : dubDelayMs,
        seconds,
        audioBytes: bytes ? Number(bytes[1]) : Math.min(5_000_000, Math.round(seconds * 2000) + 64),
        marks,
        storedAt: Date.now() + storeDelayOf(marks),
        ackUntil: Date.now() + ackDelayOf(marks),
        hideMs: hideDelayOf(marks),
        hiddenUntil: 0,
      });
      return done(
        201,
        'application/json',
        JSON.stringify({
          project_id: id,
          status: 'queued',
          revision: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          source_language: source,
          model_id: 'dubbing_v2',
          language_ids: marks.includes('[[dub-nolang]]') ? [] : [`lang-${n}`],
          webhook_ids: [],
          warnings: [],
        }),
      );
    } catch {
      return done(500, 'application/json', '{"detail":"stand-in fault"}');
    }
  }

  /** GET /v1/dubbing/project/<id>/language/<id>. */
  function dubLanguage(req, res, m) {
    if (req.headers['xi-api-key'] !== key)
      return json(res, 401, { detail: 'bad key' });
    const id = decodeURIComponent(m[1]);
    const lang = decodeURIComponent(m[2]);
    const p = dubProjects.get(id);
    if (p === undefined || p.languageId !== lang) {
      state.dubReads.push({ project: id, language: lang, status: 404 });
      return json(res, 404, { detail: 'no such language' });
    }
    const elapsed = Date.now() - p.beganAt;
    let st;
    if (p.marks.includes('[[dub-stuck]]')) st = elapsed < 1 ? 'queued' : 'processing';
    else if (elapsed < p.delayMs / 3) st = 'queued';
    else if (elapsed < p.delayMs) st = 'processing';
    else if (p.marks.includes('[[dub-failed]]')) st = 'failed';
    else if (p.marks.includes('[[dub-stale]]')) st = 'stale';
    else st = 'completed';
    state.dubReads.push({ project: id, language: lang, status: 200, dub: st });
    const base = `http://127.0.0.1:${req.socket.localPort}/__standin/dub-out/${id}`;
    return json(res, 200, {
      language_id: lang,
      project_id: id,
      target_language: p.target,
      status: st,
      revision: 1,
      created_at: new Date(p.beganAt).toISOString(),
      updated_at: new Date().toISOString(),
      model_id: 'dubbing_v2',
      voice_settings: null,
      outputs:
        st === 'completed'
          ? {
              lossless_audio: p.marks.includes('[[dub-noaudio]]') ? null : base + '/audio',
              subtitles: p.marks.includes('[[dub-nosubs]]') ? null : base + '/subtitles',
            }
          : null,
      output_revision: st === 'completed' ? 1 : null,
      error: st === 'failed' ? { message_type: 'error', error: 'the dub could not be made' } : null,
      warnings: [],
    });
  }

  /** The signed links of a finished dub: no key is needed, and one that is sent is counted. */
  function dubOut(req, res, m) {
    const id = decodeURIComponent(m[1]);
    const kind = m[2];
    const leaked = req.headers['xi-api-key'] !== undefined;
    if (leaked) state.dubKeyLeaks += 1;
    const p = dubProjects.get(id);
    if (p === undefined || p.marks.includes('[[dub-stuck]]')) {
      state.dubDownloads.push({ project: id, kind, status: 404, leaked });
      return json(res, 404, { detail: 'no such file' });
    }
    if (kind === 'audio' && p.marks.includes('[[dub-outfail]]')) {
      state.dubDownloads.push({ project: id, kind, status: 500, leaked });
      return json(res, 500, { detail: 'down' });
    }
    state.dubDownloads.push({ project: id, kind, status: 200, leaked });
    res.statusCode = 200;
    if (kind === 'audio') {
      res.setHeader('content-type', 'audio/flac');
      return res.end(
        p.marks.includes('[[dub-notflac]]')
          ? Buffer.alloc(p.audioBytes, 7)
          : flacOf(p.seconds, p.audioBytes),
      );
    }
    res.setHeader('content-type', 'text/vtt');
    return res.end(
      p.marks.includes('[[dub-badvtt]]') ? 'not subtitles\n' : vttOf(p.seconds),
    );
  }

  /** GET /v1/dubbing/project/<id>: 200 while the provider holds the project, else 404 (hidden for a moment after a delete that removed nothing, as for a transcript). */
  function dubProject(req, res, m) {
    if (req.headers['xi-api-key'] !== key)
      return json(res, 401, { detail: 'bad key' });
    const id = decodeURIComponent(m[1]);
    const item = dubProjects.get(id);
    const hidden = item !== undefined && Date.now() < item.hiddenUntil;
    const status = item !== undefined && !hidden ? 200 : 404;
    state.reads.push({ kind: 'dub', id, status, ...(hidden ? { hidden: true } : {}) });
    if (status === 404) return json(res, 404, { detail: 'no such project' });
    return json(res, 200, { project_id: id, status: 'ready', language_ids: [item.languageId] });
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
    if (text.includes('[[remove-fail]]')) stubborn.add(id);
    state.clones.push(id);
    return json(res, 200, { voice_id: id });
  }

  function removeVoice(req, res, m) {
    if (req.headers['xi-api-key'] !== key)
      return json(res, 401, { detail: 'bad key' });
    const id = decodeURIComponent(m[1]);
    if (stubborn.has(id)) {
      state.removeRefused += 1;
      return json(res, 500, { detail: 'down' });
    }
    if (!clones.delete(id)) return json(res, 404, { detail: 'no such voice' });
    state.deleted += 1;
    return json(res, 200, { status: 'ok' });
  }


  // ---- Studio pictures and video (AITOOLS-09, AITOOLS-10) -------------------

  const IMAGE_MODELS = new Set([
    'bytedance-seedream-5-lite',
    'bytedance-seedream-5-pro',
    'gemini-2.5-flash-image',
    'gemini-3-pro-image',
    'gemini-3.1-flash-image',
    'gemini-3.1-flash-lite-image',
    'gpt-image-1',
    'gpt-image-1.5',
  ]);
  const IMAGE_SHAPES = new Set([
    'auto', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1',
  ]);
  const IMAGE_SIZES = new Set(['512', '1K', '2K', '4K']);
  const VIDEO_MODELS = new Set(['veo-3.1-fast-generate-001', 'veo-3.1-generate-001', 'creatify-aurora']);

  function assetUpload(req, res, _m, raw) {
    if (req.headers['xi-api-key'] !== key) return json(res, 401, { detail: 'bad key' });
    const form = parseMultipart(req.headers['content-type'], raw);
    const file = form?.get('asset');
    if (!form || !file || file.data.length === 0 || !form.has('name'))
      return json(res, 422, { detail: 'no asset' });
    const marks = file.data.toString('latin1');
    if (marks.includes('[[asset-fail]]')) return json(res, 500, { detail: 'down' });
    if (marks.includes('[[asset-reject]]')) return json(res, 422, { detail: 'refused' });
    assetSeq += 1;
    const id = `asset-${assetSeq}`;
    assets.set(id, { bytes: file.data.length, type: file.type, marks });
    state.assets.push({ id, bytes: file.data.length, type: file.type, name: form.get('name').data.toString('utf8') });
    if (marks.includes('[[asset-delete-fail]]')) stubborn.add(id);
    return json(res, 200, {
      asset_id: id,
      name: form.get('name').data.toString('utf8'),
      mime_type: file.type,
      created_at_unix: Math.floor(Date.now() / 1000),
      content_url: null,
    });
  }

  function assetDelete(req, res, m) {
    if (req.headers['xi-api-key'] !== key) return json(res, 401, { detail: 'bad key' });
    const id = decodeURIComponent(m[1]);
    if (stubborn.has(id)) {
      state.removeRefused += 1;
      return json(res, 500, { detail: 'down' });
    }
    if (!assets.delete(id)) return json(res, 404, { detail: 'no such asset' });
    state.deletedAssets.push(id);
    res.statusCode = 204;
    return res.end();
  }

  /** The asset a reference names, or null when it names none the stand-in holds. */
  function assetOf(ref) {
    if (!ref || ref.type !== 'asset' || typeof ref.asset_id !== 'string') return null;
    return assets.has(ref.asset_id) ? ref.asset_id : null;
  }

  async function genStart(req, res, m, raw) {
    const kind = m[1];
    if (req.headers['xi-api-key'] !== key) return json(res, 401, { detail: 'bad key' });
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return json(res, 400, { detail: 'bad body' });
    }
    const bad = (why) => json(res, 422, { detail: [{ loc: ['body'], msg: why, type: 'value_error' }] });
    const named = [];
    let marks = '';
    const take = (ref) => {
      const id = assetOf(ref);
      if (id === null) return false;
      named.push(id);
      marks += assets.get(id).marks;
      return true;
    };
    let record;
    if (kind === 'image') {
      if (!IMAGE_MODELS.has(body.model_id)) return bad('model_id');
      if (typeof body.prompt !== 'string' || body.prompt === '') return bad('prompt');
      if (body.aspect_ratio !== undefined && !IMAGE_SHAPES.has(body.aspect_ratio)) return bad('aspect_ratio');
      if (body.resolution !== undefined && !IMAGE_SIZES.has(body.resolution)) return bad('resolution');
      for (const ref of body.images ?? []) if (!take(ref)) return bad('images');
      marks += body.prompt;
      record = {
        model: body.model_id,
        shape: body.aspect_ratio ?? null,
        resolution: body.resolution ?? null,
        assetIds: named,
        promptChars: body.prompt.length,
      };
      state.images.push(record);
    } else {
      if (!VIDEO_MODELS.has(body.model_id)) return bad('model_id');
      if (body.model_id === 'creatify-aurora') {
        if (!take(body.image) || !take(body.audio)) return bad('image or audio');
        if (body.resolution !== undefined && !['480p', '720p'].includes(body.resolution)) return bad('resolution');
        record = { kind: 'talking', model: body.model_id, resolution: body.resolution ?? null, assetIds: named };
      } else {
        if (typeof body.prompt !== 'string' || body.prompt === '') return bad('prompt');
        if (!['4', '6', '8'].includes(body.duration_secs)) return bad('duration_secs');
        if (body.aspect_ratio !== undefined && !['16:9', '9:16'].includes(body.aspect_ratio)) return bad('aspect_ratio');
        if (body.resolution !== undefined && !['720p', '1080p', '4K'].includes(body.resolution)) return bad('resolution');
        if (body.start_frame !== undefined && body.start_frame !== null && !take(body.start_frame)) return bad('start_frame');
        marks += body.prompt;
        record = {
          kind: 'clip',
          model: body.model_id,
          shape: body.aspect_ratio ?? null,
          seconds: body.duration_secs,
          resolution: body.resolution ?? null,
          withSound: body.generate_audio ?? null,
          assetIds: named,
          promptChars: body.prompt.length,
        };
      }
      state.videos.push(record);
    }
    if (marks.includes('[[reject]]')) return json(res, 422, { detail: 'refused' });
    if (marks.includes('[[start-fail]]')) return json(res, 500, { detail: 'down' });
    const status = /\[\[status:(4\d\d|5\d\d)\]\]/.exec(marks);
    if (status) return json(res, Number(status[1]), { detail: 'no' });
    genSeq += 1;
    const id = `gen-${genSeq}`;
    const slow = /\[\[slow:(\d{1,7})\]\]/.exec(marks);
    const bytes = /\[\[bytes:(\d{1,10})\]\]/.exec(marks);
    const type = /\[\[type:([a-z0-9.+\/-]{3,40})\]\]/.exec(marks);
    gens.set(id, {
      kind,
      marks,
      startedAt: Date.now(),
      delay: slow ? Number(slow[1]) : genDelayMs,
      bytes: bytes ? Number(bytes[1]) : kind === 'image' ? 2048 : 4096,
      type: type ? type[1] : kind === 'image' ? 'image/png' : 'video/mp4',
    });
    return json(res, 200, { id, status: 'pending' });
  }

  function genRead(req, res, m) {
    if (req.headers['xi-api-key'] !== key) return json(res, 401, { detail: 'bad key' });
    const id = decodeURIComponent(m[2]);
    const g = gens.get(id);
    if (!g || g.kind !== m[1]) {
      state.genReads.push({ id, status: 404 });
      return json(res, 404, { detail: 'no such generation' });
    }
    const elapsed = Date.now() - g.startedAt;
    let st;
    if (g.marks.includes('[[stuck]]')) st = elapsed < g.delay / 3 ? 'pending' : 'generating';
    else if (elapsed >= g.delay) st = 'terminal';
    else st = elapsed < g.delay / 3 ? 'pending' : 'generating';
    if (st === 'terminal') {
      if (g.marks.includes('[[fail]]') || g.marks.includes('[[moderated]]') || g.marks.includes('[[invalid]]')) {
        const reason = g.marks.includes('[[moderated]]')
          ? 'moderated'
          : g.marks.includes('[[invalid]]')
            ? 'invalid_parameters'
            : 'model_error';
        state.genReads.push({ id, status: 200, answered: 'failed', reason });
        return json(res, 200, { status: 'failed', id, failure_reason: reason, error_message: 'the generation could not be made' });
      }
      state.genReads.push({ id, status: 200, answered: 'completed' });
      if (g.marks.includes('[[nolink]]')) return json(res, 200, { status: 'completed', id });
      return json(res, 200, {
        status: 'completed',
        id,
        content_url: `http://${req.headers.host}/__standin/gen-out/${encodeURIComponent(id)}`,
        content_mime_type: g.type,
      });
    }
    state.genReads.push({ id, status: 200, answered: st });
    return json(res, 200, { status: st, id });
  }

  /** The signed link of a finished generation: no key is needed, and one that is sent is counted. The file is streamed, never built whole. */
  async function genOut(req, res, m) {
    const id = decodeURIComponent(m[1]);
    const leaked = req.headers['xi-api-key'] !== undefined;
    if (leaked) state.genKeyLeaks += 1;
    const g = gens.get(id);
    if (!g) {
      state.genDownloads.push({ id, status: 404, leaked });
      return json(res, 404, { detail: 'no such file' });
    }
    if (g.marks.includes('[[outfail]]')) {
      state.genDownloads.push({ id, status: 500, leaked });
      return json(res, 500, { detail: 'down' });
    }
    state.genDownloads.push({ id, status: 200, leaked });
    res.statusCode = 200;
    res.setHeader('content-type', g.type);
    res.setHeader('content-length', String(g.bytes));
    // A real header at the front (a PNG signature and header, or an MP4 'ftyp' box), then zeros.
    const head =
      g.type === 'video/mp4'
        ? Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)])
        : Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
            Buffer.from('IHDR'),
            Buffer.from([0, 0, 0, 16, 0, 0, 0, 16, 8, 2, 0, 0, 0]),
            Buffer.alloc(4),
          ]);
    let left = g.bytes;
    const first = head.subarray(0, Math.min(head.length, left));
    left -= first.length;
    res.write(first);
    const chunk = Buffer.alloc(64 * 1024);
    while (left > 0) {
      const part = left >= chunk.length ? chunk : chunk.subarray(0, left);
      left -= part.length;
      if (!res.write(part)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  }

  function stateRoute(_req, res) {
    return json(res, 200, state);
  }

  /** The provider's voice list (AITOOLS-07): the voices this stand-in knows, each with a sample link. */
  function listVoices(req, res) {
    if (req.headers['xi-api-key'] !== key)
      return json(res, 401, { detail: 'bad key' });
    state.voiceListReads += 1;
    const base = `http://${req.headers.host}`;
    return json(res, 200, {
      voices: [...VOICES].map((id) => ({
        voice_id: id,
        name: id,
        category: 'premade',
        preview_url: `${base}/__standin/sample/${encodeURIComponent(id)}.mp3`,
      })),
    });
  }

  function sampleAudio(_req, res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'audio/mpeg');
    res.end(Buffer.concat(Array.from({ length: 8 }, () => frame)));
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
      method: 'GET',
      path: /^\/v1\/speech-to-text\/transcripts\/([^/]+)$/,
      handle: readTranscript,
    },
    {
      method: 'POST',
      path: /^\/v1\/audio-isolation$/,
      handle: fileRoute('iso'),
    },
    {
      method: 'DELETE',
      path: /^\/v1\/audio-isolation\/history\/([^/]+)$/,
      handle: removeFrom(isolations, state.deletedIsolations, 'isolation', 204),
    },
    { method: 'GET', path: /^\/v1\/voices$/, handle: listVoices },
    {
      method: 'GET',
      path: /^\/__standin\/sample\/([^/]+)\.mp3$/,
      handle: sampleAudio,
    },
    { method: 'POST', path: /^\/v1\/dubbing\/project$/, handle: dubStart },
    {
      method: 'GET',
      path: /^\/v1\/dubbing\/project\/([^/]+)\/language\/([^/]+)$/,
      handle: dubLanguage,
    },
    {
      method: 'GET',
      path: /^\/v1\/dubbing\/project\/([^/]+)$/,
      handle: dubProject,
    },
    {
      method: 'DELETE',
      path: /^\/v1\/dubbing\/project\/([^/]+)$/,
      handle: removeFrom(dubProjects, state.deletedDubs, 'dub', 204),
    },
    {
      method: 'GET',
      path: /^\/__standin\/dub-out\/([^/]+)\/(audio|subtitles)$/,
      handle: dubOut,
    },
    { method: 'POST', path: /^\/v1\/assets$/, handle: assetUpload },
    { method: 'DELETE', path: /^\/v1\/assets\/([^/]+)$/, handle: assetDelete },
    { method: 'POST', path: /^\/v1\/flows\/(image|video)$/, handle: genStart },
    {
      method: 'GET',
      path: /^\/v1\/flows\/(image|video)\/([^/]+)$/,
      handle: genRead,
    },
    {
      method: 'GET',
      path: /^\/__standin\/gen-out\/([^/]+)$/,
      handle: genOut,
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
        /** Lets the voices a [[remove-fail]] sample made be deleted from now on. */
        releaseStubborn: () => stubborn.clear(),
        /** Transcripts and cleaned recordings the provider still holds (AITOOLS-04). */
        openTranscripts: () => transcripts.size,
        openIsolations: () => isolations.size,
        /** Dub projects the provider still holds (AITOOLS-05). */
        openDubs: () => dubProjects.size,
        /** Assets (a person's photo or voice) the provider still holds (AITOOLS-09, AITOOLS-10). */
        openAssets: () => assets.size,
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
    dubDelayMs: Number(opt('--dub-delay-ms', 0)),
    genDelayMs: Number(opt('--gen-delay-ms', 0)),
  }).then(({ port }) => {
    console.log(`LISTENING ${port}`);
  });
}
