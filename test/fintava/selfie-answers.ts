import type { CannedAnswer } from './fintava-double';
import { SELFIE_MATCHED, SELFIE_NOT_MATCHED } from './fintava-double';

/**
 * Selfie match answers (task KYC-02) for the client and route specs. The
 * client reads the answer by allowlist (src/fintava/fintava-selfie-answer.ts):
 * only the exact documented shapes carry a verdict. Every answer below that
 * the round-1 and round-2 verifiers sent is here, with the outcome it must
 * have now: never a match.
 */

const J = (v: unknown) => JSON.stringify(v);
const ok = (raw: string): CannedAnswer => ({ status: 200, body: raw });

/** `leaf` nested `depth` objects below where it is put. */
export function nest(depth: number, leaf: object): object {
  let o: object = leaf;
  for (let i = 0; i < depth; i += 1) o = { [`l${i}`]: o };
  return o;
}

/** The documented envelope around `data`. */
const env = (data: unknown) => J({ data, status: 200, message: 'successful' });

/** The answers read as a match: the exact shape, nothing else. */
export const SELFIE_MATCH_ANSWERS: Array<[string, CannedAnswer]> = [
  ['the envelope around match: true', ok(J(SELFIE_MATCHED))],
  ['the same without message', ok(J({ data: { match: true }, status: 200 }))],
  [
    'the same, keys in another order, with whitespace',
    ok(
      '{ "status" : 200 ,\n "message":"successful", "data" : {"match":true} }',
    ),
  ],
  [
    'charset=utf-8 in the content type',
    {
      status: 200,
      body: J(SELFIE_MATCHED),
      contentType: 'Application/JSON; Charset=UTF-8',
    },
  ],
  ...[
    'matched',
    'is_match',
    'isMatch',
    'face_match',
    'faceMatch',
    'selfie_match',
    'selfieMatch',
  ].map((k): [string, CannedAnswer] => [
    `the envelope around ${k}: true`,
    ok(env({ [k]: true })),
  ]),
];

/** Explicit "no"s: route 422 selfie_not_matched, counted. */
export const SELFIE_NO_ANSWERS: Array<[string, CannedAnswer]> = [
  ['the envelope around match: false', ok(J(SELFIE_NOT_MATCHED))],
  ['the envelope around faceMatch: false', ok(env({ faceMatch: false }))],
  [
    'the documented failure envelope (status 400) in an HTTP 200',
    ok(
      J({
        status: 400,
        timestamp: '2026-10-02T09:43:35.262Z',
        message: ['Request failed with status code 404'],
        path: '/api/dev/compliance/verify/bvn/selfie',
      }),
    ),
  ],
];

/**
 * Answers with no verdict: client `bad_response`, route 503
 * provider_unreachable, counted, never a match. Rounds 1 and 2, then more.
 */
export const SELFIE_UNREADABLE_ANSWERS: Array<[string, CannedAnswer]> = [
  // Round 2, defect 1 (a): negative-named fields set to true.
  ...[
    'mismatch',
    'notMatched',
    'noMatch',
    'is_mismatch',
    'unverified',
    'faceMismatch',
  ].map((k): [string, CannedAnswer] => [
    `match: true + ${k}: true`,
    ok(J({ data: { match: true, [k]: true } })),
  ]),
  ...['mismatch', 'noMatch', 'unverified'].map((k): [string, CannedAnswer] => [
    `the envelope around match: true + ${k}: true`,
    ok(env({ match: true, [k]: true })),
  ]),
  // (b) a "no" nested deeper than round 2 read.
  [
    'match: true + a false 9 deep',
    ok(J({ data: { match: true, x: nest(7, { match: false }) } })),
  ],
  [
    'match: true + a false 8 deep',
    ok(J({ data: { match: true, x: nest(6, { match: false }) } })),
  ],
  [
    'match: true + status failed 12 deep',
    ok(J({ data: { match: true, x: nest(10, { status: 'failed' }) } })),
  ],
  [
    'match: true + success false 20 deep',
    ok(J({ data: { match: true, x: nest(18, { success: false }) } })),
  ],
  [
    'match: true + 50 deep match false',
    ok(J({ data: { match: true, x: nest(50, { match: false }) } })),
  ],
  [
    'envelope, match: true + a false 9 deep',
    ok(env({ match: true, x: nest(7, { match: false }) })),
  ],
  [
    'match: true + arrays 9 deep around false',
    ok(J({ data: { match: true, matches: [[[[[[[[[false]]]]]]]]] } })),
  ],
  [
    'match: true + [{ match: false }]',
    ok(J({ data: { match: true, r: [{ match: false }] } })),
  ],
  [
    'match: true + arrays around { match: false }',
    ok(J({ data: { match: true, r: [[[[[[[{ match: false }]]]]]]] } })),
  ],
  // (c) a "no" under a name round 2 did not list.
  ...[
    ['passed', false],
    ['valid', false],
    ['ok', false],
    ['error', true],
    ['error', 'Face mismatch'],
    ['errors', ['Face mismatch']],
  ].map(([k, v]): [string, CannedAnswer] => [
    `match: true + ${String(k)}: ${J(v)}`,
    ok(env({ match: true, [k as string]: v })),
  ]),
  [
    'envelope ok: false',
    ok(J({ ok: false, data: { match: true }, status: 200 })),
  ],
  [
    'envelope error: true',
    ok(J({ error: true, data: { match: true }, status: 200 })),
  ],
  [
    'envelope error "Face mismatch"',
    ok(J({ error: 'Face mismatch', data: { match: true }, status: 200 })),
  ],
  // Round 2 finding 1: a key named twice (JSON.parse keeps the last).
  [
    'match named twice, false then true',
    ok('{"data":{"match":false,"match":true},"status":200}'),
  ],
  [
    'match named twice, true then true',
    ok('{"data":{"match":true,"match":true},"status":200}'),
  ],
  [
    'data named twice, no then yes',
    ok('{"data":{"match":false},"data":{"match":true},"status":200}'),
  ],
  [
    'status named twice',
    ok('{"data":{"match":true},"status":400,"status":200}'),
  ],
  [
    'match named twice, one escaped',
    ok('{"data":{"match":false,"m\\u0061tch":true},"status":200}'),
  ],
  // Round 2 finding 2: not HTTP 200, or not labelled JSON.
  ...[201, 202, 203, 206, 299].map((status): [string, CannedAnswer] => [
    `HTTP ${status} around match: true`,
    { status, body: J(SELFIE_MATCHED) },
  ]),
  ['HTTP 204, no body', { status: 204 }],
  [
    'labelled text/html',
    { status: 200, body: J(SELFIE_MATCHED), contentType: 'text/html' },
  ],
  [
    'labelled text/plain',
    { status: 200, body: J(SELFIE_MATCHED), contentType: 'text/plain' },
  ],
  [
    'no content type',
    { status: 200, body: J(SELFIE_MATCHED), contentType: null },
  ],
  [
    'labelled application/json; charset=latin1',
    {
      status: 200,
      body: J(SELFIE_MATCHED),
      contentType: 'application/json; charset=latin1',
    },
  ],
  [
    'labelled application/jsonp',
    { status: 200, body: J(SELFIE_MATCHED), contentType: 'application/jsonp' },
  ],
  [
    'labelled application/problem+json',
    {
      status: 200,
      body: J(SELFIE_MATCHED),
      contentType: 'application/problem+json',
    },
  ],
  [
    'HTML labelled text/html',
    { status: 200, body: '<html>match: true</html>', contentType: 'text/html' },
  ],
  [
    'XML',
    {
      status: 200,
      body: '<data><match>true</match></data>',
      contentType: 'application/xml',
    },
  ],
  // Round 1's shapes (no verdict, or a "no" outside the exact shape).
  ['the documented {} in the envelope', ok(env({}))],
  [
    'status "failed" in the envelope, data {}',
    ok(J({ status: 'failed', message: 'Face does not match', data: {} })),
  ],
  ['data.status "failed"', ok(J({ data: { status: 'failed' } }))],
  ['match "false"', ok(env({ match: 'false' }))],
  ['match 0', ok(env({ match: 0 }))],
  ['match null', ok(env({ match: null }))],
  [
    'faceMatch false without the envelope status',
    ok(J({ data: { faceMatch: false } })),
  ],
  [
    'match false two levels down',
    ok(env({ result: { selfie_verification: { match: false } } })),
  ],
  ['confidence 0 alone', ok(env({ confidence: 0 }))],
  ['201 { data: {} }', { status: 201, body: J({ data: {} }) }],
  ['{}', ok('{}')],
  ['data null', ok(J({ data: null, status: 200 }))],
  ['data a string', ok(J({ data: 'ok', status: 200 }))],
  ['data an array', ok(J({ data: [], status: 200 }))],
  ['data [{ match: true }]', ok(J({ data: [{ match: true }], status: 200 }))],
  ['data true', ok(J({ data: true, status: 200 }))],
  // Round 2's held shapes (they must stay held).
  ['match: true without the envelope', ok(J({ data: { match: true } }))],
  ['match: [true]', ok(env({ match: [true] }))],
  ['match: "true"', ok(env({ match: 'true' }))],
  ['match: "TRUE"', ok(env({ match: 'TRUE' }))],
  ['match: " true "', ok(env({ match: ' true ' }))],
  ['match: "1"', ok(env({ match: '1' }))],
  ['match: 1', ok(env({ match: 1 }))],
  ['match: { value: true }', ok(env({ match: { value: true } }))],
  ['match: true one object down', ok(env({ x: { match: true } }))],
  ['match: true two objects down', ok(env({ x: { y: { match: true } } }))],
  [
    'match: true on the envelope only',
    ok(J({ match: true, data: {}, status: 200 })),
  ],
  [
    'match: true on the envelope, data null',
    ok(J({ data: null, match: true, status: 200 })),
  ],
  ['Match: true (another case)', ok(env({ Match: true }))],
  ['MATCH: false beside match: true', ok(env({ match: true, MATCH: false }))],
  ['two verdicts, both true', ok(env({ match: true, matched: true }))],
  ['two verdicts, true and false', ok(env({ match: true, isMatch: false }))],
  ['match: true + verified: true', ok(env({ match: true, verified: true }))],
  ['match: true + verified: false', ok(env({ match: true, verified: false }))],
  ['match: true + a score', ok(env({ match: true, confidence: 99 }))],
  ['match: true + confidence 0', ok(env({ match: true, confidence: 0 }))],
  [
    'match: true + confidence "12abc"',
    ok(env({ match: true, confidence: '12abc' })),
  ],
  [
    'match: true + confidence 1e400',
    ok('{"data":{"match":true,"confidence":1e400},"status":200}'),
  ],
  ['match: true + matchScore 0', ok(env({ match: true, matchScore: 0 }))],
  [
    'match: true + matchStatus "FAILED"',
    ok(env({ match: true, matchStatus: 'FAILED' })),
  ],
  [
    'match: true + verificationStatus "rejected"',
    ok(env({ match: true, verificationStatus: 'rejected' })),
  ],
  [
    'match: true + result "no_match"',
    ok(env({ match: true, result: 'no_match' })),
  ],
  ['match: true + state false', ok(env({ match: true, state: false }))],
  ['match: true + y.match "no"', ok(env({ match: true, y: { match: 'no' } }))],
  [
    'match: true + data.data { match: false }',
    ok(env({ match: true, data: { match: false } })),
  ],
  [
    'status "failed" around match: true',
    ok(J({ status: 'failed', data: { match: true } })),
  ],
  [
    'status "FAILED " around match: true',
    ok(J({ status: 'FAILED ', data: { match: true } })),
  ],
  [
    'status 400 around match: true',
    ok(J({ status: 400, data: { match: true } })),
  ],
  [
    'status "error" around match: true',
    ok(J({ status: 'error', data: { match: true } })),
  ],
  [
    'status "pending" around match: true',
    ok(J({ status: 'pending', data: { match: true } })),
  ],
  [
    'status "success" around match: true',
    ok(J({ status: 'success', data: { match: true } })),
  ],
  [
    'status "200" (a string) around match: true',
    ok(J({ status: '200', data: { match: true } })),
  ],
  [
    'status true around match: true',
    ok(J({ status: true, data: { match: true } })),
  ],
  [
    'success: true around match: true',
    ok(J({ success: true, status: 200, data: { match: true } })),
  ],
  [
    'success: false around match: true',
    ok(J({ success: false, status: 200, data: { match: true } })),
  ],
  [
    'message "Face does not match" around match: true',
    ok(
      J({ message: 'Face does not match', status: 200, data: { match: true } }),
    ),
  ],
  [
    'message ["successful"] around match: true',
    ok(J({ message: ['successful'], status: 200, data: { match: true } })),
  ],
  [
    'a timestamp and path around match: true',
    ok(J({ status: 200, timestamp: 'x', path: '/x', data: { match: true } })),
  ],
  [
    '__proto__ holding the verdict',
    ok('{"data":{"__proto__":{"match":true}},"status":200}'),
  ],
  [
    '__proto__ beside the verdict',
    ok('{"data":{"match":true,"__proto__":{"match":false}},"status":200}'),
  ],
  [
    'constructor holding the verdict',
    ok('{"data":{"constructor":{"match":true}},"status":200}'),
  ],
  [
    'constructor beside the verdict',
    ok('{"data":{"match":true,"constructor":{"match":false}},"status":200}'),
  ],
  [
    '__proto__ around data',
    ok('{"__proto__":{"data":{"match":true}},"status":200}'),
  ],
  [
    'envelope __proto__ success false',
    ok('{"__proto__":{"success":false},"data":{"match":true},"status":200}'),
  ],
  [
    'the failure envelope with data',
    ok(J({ status: 400, message: ['x'], data: { match: true } })),
  ],
  ['the failure envelope, status 401', ok(J({ status: 401, message: ['x'] }))],
  [
    'the failure envelope, a number in message',
    ok(J({ status: 400, message: [404] })),
  ],
  // Not JSON, or not one JSON value.
  ['truncated JSON', ok('{"data":{"match":true},"status":200')],
  ['JSON then trailing bytes', ok(`${J(SELFIE_MATCHED)} xx`)],
  ['two JSON values', ok(`${J(SELFIE_MATCHED)}${J(SELFIE_MATCHED)}`)],
  ['a trailing comma', ok('{"data":{"match":true,},"status":200}')],
  ['single quotes', ok("{'data':{'match':true},'status':200}")],
  ['a comment', ok('{"data":{"match":true /* yes */},"status":200}')],
  ['NaN', ok('{"data":{"match":true},"status":NaN}')],
  ['null', ok('null')],
  ['a string', ok('"match"')],
  ['a number', ok('1')],
  ['true', ok('true')],
  ['an array', ok(J([SELFIE_MATCHED]))],
  ['an empty body', ok('')],
  // Big and deep: refused quickly, no crash.
  [
    '100,000-deep arrays',
    ok(
      `{"data":{"match":true,"x":${'['.repeat(100_000)}${']'.repeat(100_000)}},"status":200}`,
    ),
  ],
  [
    '5,000-deep objects',
    ok(
      `{"data":{"match":true,"x":${'{"a":'.repeat(5000)}1${'}'.repeat(5000)}},"status":200}`,
    ),
  ],
  [
    '200,000 keys beside the verdict',
    ok(
      J({
        status: 200,
        data: Object.assign(
          { match: true },
          Object.fromEntries(
            Array.from({ length: 200_000 }, (_, i) => [`k${i}`, i]),
          ),
        ),
      }),
    ),
  ],
  [
    'a 2 MB string beside the verdict',
    ok(env({ match: true, pad: 'A'.repeat(2_000_000) })),
  ],
];

/** The one body read as a match, as text. */
export const ACCEPTED_SELFIE_BODY =
  '{"data":{"match":true},"status":200,"message":"successful"}';

/** A fixed pseudo-random sequence (the property cases are the same every run). */
function sequence(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x;
  };
}

/** Names a "no" or a verdict might hide under, and names already present. */
const EXTRA_KEY_NAMES = [
  'match',
  'matched',
  'is_match',
  'isMatch',
  'face_match',
  'faceMatch',
  'selfie_match',
  'selfieMatch',
  'Match',
  'MATCH',
  'match ',
  ' match',
  'mаtch',
  'mismatch',
  'noMatch',
  'notMatched',
  'is_mismatch',
  'faceMismatch',
  'unverified',
  'verified',
  'verification',
  'status',
  'message',
  'data',
  'success',
  'successful',
  'ok',
  'passed',
  'valid',
  'error',
  'errors',
  'reason',
  'result',
  'outcome',
  'state',
  'confidence',
  'score',
  'similarity',
  'timestamp',
  'path',
  'meta',
  'statusCode',
  'code',
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  '',
  ' ',
  '0',
  'image',
  'bvn',
  'photo',
  'selfie_verification',
];

const EXTRA_VALUES = [
  'true',
  'false',
  'null',
  '0',
  '1',
  '-1',
  '200',
  '400',
  '""',
  '"x"',
  '"false"',
  '"true"',
  '"failed"',
  '"successful"',
  '[]',
  '[false]',
  '{}',
  '{"match":false}',
  '{"match":true}',
  '{"a":{"b":false}}',
];

/**
 * The accepted body with one extra key added, at the top or inside `data`,
 * first or last, with each value: every name above and 300 random ones.
 * Names already there (match, status, data, message) make a key named twice.
 */
export function extraKeyBodies(): string[] {
  const next = sequence(20261003);
  const alphabet =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-0123456789$';
  const random = Array.from({ length: 300 }, () => {
    const n = 1 + (next() % 16);
    let k = '';
    for (let i = 0; i < n; i += 1) k += alphabet[next() % alphabet.length];
    return k;
  });
  const top = ACCEPTED_SELFIE_BODY.indexOf('{');
  const data = ACCEPTED_SELFIE_BODY.indexOf('{', 1);
  const dataEnd = ACCEPTED_SELFIE_BODY.indexOf('}');
  const end = ACCEPTED_SELFIE_BODY.length - 1;
  const out: string[] = [];
  for (const key of [...EXTRA_KEY_NAMES, ...random]) {
    for (const value of EXTRA_VALUES) {
      const pair = `${JSON.stringify(key)}:${value}`;
      for (const [at, text] of [
        [top + 1, `${pair},`],
        [end, `,${pair}`],
        [data + 1, `${pair},`],
        [dataEnd, `,${pair}`],
      ] as const) {
        out.push(
          ACCEPTED_SELFIE_BODY.slice(0, at) +
            text +
            ACCEPTED_SELFIE_BODY.slice(at),
        );
      }
    }
  }
  return out;
}
