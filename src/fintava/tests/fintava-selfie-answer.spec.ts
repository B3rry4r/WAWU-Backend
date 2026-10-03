import type { CannedAnswer } from '../../../test/fintava/fintava-double';
import {
  ACCEPTED_SELFIE_BODY,
  extraKeyBodies,
  SELFIE_MATCH_ANSWERS,
  SELFIE_NO_ANSWERS,
  SELFIE_UNREADABLE_ANSWERS,
} from '../../../test/fintava/selfie-answers';
import {
  parseStrictJson,
  readSelfieAnswer,
  SELFIE_ANSWER_MAX_BYTES,
  SELFIE_VERDICT_KEYS,
  SelfieAnswerUnreadable,
} from '../fintava-selfie-answer';

/**
 * The selfie answer reader on its own (task KYC-02, verifier round 2,
 * defect 1): an allowlist of exact shapes. The client and route specs send
 * the same answers over a socket.
 */

const JSON_TYPE = 'application/json; charset=utf-8';
const asAnswer = (a: CannedAnswer) => ({
  status: a.status,
  contentType: a.contentType === undefined ? JSON_TYPE : a.contentType,
  text:
    typeof a.body === 'string'
      ? a.body
      : a.body === undefined
        ? ''
        : JSON.stringify(a.body),
});
const read = (text: string) =>
  readSelfieAnswer({ status: 200, contentType: JSON_TYPE, text });

/** The reader's verdict, or `none` when the answer is unreadable. */
function verdict(text: string): 'yes' | 'no' | 'none' {
  try {
    return read(text).matched ? 'yes' : 'no';
  } catch (e) {
    if (e instanceof SelfieAnswerUnreadable) return 'none';
    throw e;
  }
}

describe('the selfie answer, read by allowlist', () => {
  it('the accepted body is a match', () => {
    expect(verdict(ACCEPTED_SELFIE_BODY)).toBe('yes');
  });

  it('the candidate verdict names stay a short list', () => {
    expect(SELFIE_VERDICT_KEYS.length).toBeLessThanOrEqual(8);
  });

  it.each(SELFIE_MATCH_ANSWERS)('a match: %s', (_name, a) => {
    expect(readSelfieAnswer(asAnswer(a))).toEqual({ matched: true });
  });

  it.each(SELFIE_NO_ANSWERS)('an explicit "no": %s', (_name, a) => {
    expect(readSelfieAnswer(asAnswer(a))).toEqual({ matched: false });
  });

  it.each(SELFIE_UNREADABLE_ANSWERS)('no verdict: %s', (_name, a) => {
    expect(() => readSelfieAnswer(asAnswer(a))).toThrow(SelfieAnswerUnreadable);
  });

  it('only HTTP 200 is read', () => {
    for (const status of [199, 201, 202, 204, 206, 299, 300, 400, 500]) {
      expect(() =>
        readSelfieAnswer({
          status,
          contentType: JSON_TYPE,
          text: ACCEPTED_SELFIE_BODY,
        }),
      ).toThrow(SelfieAnswerUnreadable);
    }
  });

  /**
   * The property: the accepted body plus any single extra key, at the top
   * or inside `data`, first or last, with any of 20 values, under 55 chosen
   * names and 300 random ones (a key already there is then named twice).
   */
  it('the accepted body plus any one extra key is never a match', () => {
    const bodies = extraKeyBodies();
    expect(bodies.length).toBeGreaterThan(25_000);
    const matched = bodies.filter((b) => verdict(b) === 'yes');
    expect(matched).toEqual([]);
    // And none is read as anything: an extra key makes it unreadable.
    const read = bodies.filter((b) => verdict(b) !== 'none');
    expect(read).toEqual([]);
  });

  /**
   * Verifier round 3: removing the failure envelope's key list survived.
   * The failure envelope is an explicit "no" only with its own four keys
   * (`status`, `timestamp`, `message`, `path`); any other key beside them
   * leaves it unreadable (a 503), however harmless the key looks.
   */
  it('the failure envelope plus any key of its own list is a "no"; plus any other key, unreadable', () => {
    const failure = {
      status: 400,
      timestamp: '2026-10-02T09:43:35.262Z',
      message: ['Request failed with status code 404'],
      path: '/api/dev/compliance/verify/bvn/selfie',
    };
    expect(verdict(JSON.stringify(failure))).toBe('no');
    expect(verdict(JSON.stringify({ status: 400 }))).toBe('no');
    for (const [key, value] of [
      ['match', true],
      ['matched', true],
      ['success', true],
      ['error', 'Bad Request'],
      ['statusCode', 400],
      ['code', 'E400'],
      ['details', {}],
      ['x', 1],
    ] as Array<[string, unknown]>) {
      const text = JSON.stringify({ ...failure, [key]: value });
      expect({ key, verdict: verdict(text) }).toEqual({ key, verdict: 'none' });
    }
  });

  /** Verifier round 3, defect 2: the reader refuses a text over the cap before parsing it. */
  it('a text over SELFIE_ANSWER_MAX_BYTES is unreadable, even the accepted shape padded with JSON whitespace', () => {
    const padded = (n: number) =>
      ACCEPTED_SELFIE_BODY.replace(
        '{',
        `{${' '.repeat(n - ACCEPTED_SELFIE_BODY.length)}`,
      );
    expect(padded(SELFIE_ANSWER_MAX_BYTES).length).toBe(
      SELFIE_ANSWER_MAX_BYTES,
    );
    expect(verdict(padded(SELFIE_ANSWER_MAX_BYTES))).toBe('yes');
    expect(verdict(padded(SELFIE_ANSWER_MAX_BYTES + 1))).toBe('none');
    // Counted in UTF-8 bytes, not characters: 2 bytes each.
    const wide = `{"data":{"match":true},"status":200,"message":"${'é'.repeat(SELFIE_ANSWER_MAX_BYTES / 2)}"}`;
    expect(wide.length).toBeLessThan(SELFIE_ANSWER_MAX_BYTES * 2);
    expect(() => read(wide)).toThrow(/over 4096 bytes/);
    // 50 MB is refused at once, without parsing.
    const huge = padded(50_000_000);
    const started = process.hrtime.bigint();
    expect(verdict(huge)).toBe('none');
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(200);
  });

  it('a "no" plus any one extra key is unreadable too (a 503, not a 422)', () => {
    const no = extraKeyBodies().map((b) =>
      b.replace('"match":true', '"match":false'),
    );
    expect(verdict(ACCEPTED_SELFIE_BODY.replace('true', 'false'))).toBe('no');
    expect(no.filter((b) => verdict(b) !== 'none')).toEqual([]);
  });
});

describe('strict JSON', () => {
  it('reads what JSON.parse reads, for documents with no key named twice', () => {
    const docs = [
      '{}',
      '[]',
      '{"a":[1,-2.5e3,0.25,true,false,null,"x\\n\\u00e9\\"\\\\\\/"]}',
      ' \n\t{ "a" : { "b" : "c" } } \r\n',
      '"\\ud83d\\ude00"',
      '0',
      '-0',
      '1E+2',
    ];
    for (const doc of docs) {
      expect(parseStrictJson(doc, 2)).toEqual(JSON.parse(doc));
    }
  });

  it('refuses a key named twice at any level, however it is spelt', () => {
    for (const doc of [
      '{"a":1,"a":1}',
      '{"a":{"b":1,"b":2}}',
      '{"a":1,"\\u0061":2}',
      '{"__proto__":1,"__proto__":2}',
    ]) {
      expect(() => parseStrictJson(doc, 2)).toThrow(SelfieAnswerUnreadable);
    }
  });

  it('refuses anything deeper than it reads, without walking it', () => {
    expect(() => parseStrictJson('{"a":{"b":{}}}', 2)).toThrow(
      SelfieAnswerUnreadable,
    );
    const deep = `${'['.repeat(1_000_000)}${']'.repeat(1_000_000)}`;
    const started = Date.now();
    expect(() => parseStrictJson(deep, 2)).toThrow(SelfieAnswerUnreadable);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('refuses what JSON does not allow', () => {
    for (const doc of [
      '',
      ' ',
      '{',
      '{"a":1,}',
      '[1,]',
      "{'a':1}",
      '{a:1}',
      '01',
      '1.',
      '.5',
      '+1',
      'NaN',
      'Infinity',
      '1e400',
      'tru',
      '"\u0001"',
      '"\\x41"',
      '"\\u12"',
      '{} {}',
      '{"a":1} x',
      '﻿{}',
    ]) {
      expect({ doc, ok: tryParse(doc) }).toEqual({ doc, ok: false });
    }
  });

  it('keys like __proto__ are plain keys, and set no prototype', () => {
    const o = parseStrictJson('{"__proto__":{"match":true}}', 2) as Record<
      string,
      unknown
    >;
    expect(Object.keys(o)).toEqual(['__proto__']);
    expect((o as { match?: unknown }).match).toBeUndefined();
  });
});

function tryParse(doc: string): boolean {
  try {
    parseStrictJson(doc, 2);
    return true;
  } catch (e) {
    if (e instanceof SelfieAnswerUnreadable) return false;
    throw e;
  }
}
