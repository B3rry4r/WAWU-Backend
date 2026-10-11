import {
  FintavaDouble,
  fintavaConfig,
  fintavaError,
} from '../../../test/fintava/fintava-double';
import { FintavaClient } from '../fintava-client';
import { FintavaError } from '../fintava-error';
import {
  COMPANY_FORM_WORDS,
  PLACEHOLDER_WORDS,
  isNotAnOwner,
  nameWordsOf,
  readMeterAnswer,
} from '../fintava-meter-answer';
import {
  NOT_GREEN_BODIES,
  PLACEHOLDER_NAMES,
} from '../../../test/bills/not-green-bodies';
import {
  COMPANY_FORM_COUNT,
  CONTROL_FLAG_BODIES,
  FAILURE_FLAG_BODIES,
  PLACEHOLDER_NAMES_125,
  REAL_OWNERS,
} from '../../../test/bills/not-an-owner';

/**
 * How the Fintava client reads a meter preview (BILLS-01 round 2, D2). The success body has never been seen (question
 * 11), so "found" needs an owner's name under a key a person's name is kept under, in the `data` object, and nothing
 * else counts: not a 2xx that carries Fintava's own failure, not a body that names no one, not a body the client
 * cannot read. Fintava styles a failure inside a 2xx (`sandbox/21-`: `201 { status: 200, message: "service not
 * currently available" }`; a `200` whose body says `status: 400`).
 */

describe('readMeterAnswer: the body of a 2xx preview', () => {
  const owner = (data: Record<string, unknown>, more = {}) => ({
    status: 200,
    message: 'Meter details fetched',
    data,
    ...more,
  });

  it.each([
    ['Customer_Name', { Customer_Name: 'Ada Eze' }],
    ['customerName', { customerName: 'Ada Eze' }],
    ['name', { name: 'Ada Eze' }],
    ['CUSTOMER NAME', { 'CUSTOMER NAME': 'Ada Eze' }],
    ['accountName', { accountName: 'Ada Eze' }],
    ['consumer-name', { 'consumer-name': 'Ada Eze' }],
    ['fullName', { fullName: 'Ada Eze' }],
    ['customerFullName', { customerFullName: 'Ada Eze' }],
  ])('names an owner from the key %s', (_k, data) => {
    expect(readMeterAnswer(owner(data))).toMatchObject({
      kind: 'owner',
      name: 'Ada Eze',
      address: null,
    });
  });

  it.each([
    ['address', { address: '1 Road' }],
    ['customerAddress', { customerAddress: '1 Road' }],
    ['Consumer_Address', { Consumer_Address: '1 Road' }],
    ['service address', { 'service address': '1 Road' }],
  ])('reads the address from the key %s', (_k, extra) => {
    expect(readMeterAnswer(owner({ name: 'Ada Eze', ...extra }))).toMatchObject(
      { kind: 'owner', name: 'Ada Eze', address: '1 Road' },
    );
  });

  it('trims the name and the address, and an empty address is none', () => {
    expect(
      readMeterAnswer(owner({ name: '  Ada Eze ', address: '   ' })),
    ).toMatchObject({ kind: 'owner', name: 'Ada Eze', address: null });
  });

  it.each([
    ['a string', 'x'],
    ['a number', 1],
    ['an array', [{ name: 'A' }]],
    ['true', true],
  ])('cannot read data that is %s', (_k, data) => {
    expect(readMeterAnswer({ status: 200, data })).toEqual({
      kind: 'unreadable',
    });
  });

  it.each([
    ['no data at all', { status: 200, message: 'ok' }],
    ['an owner beside, not inside, data', { status: 200, name: 'Ada Eze' }],
    ['an object with no name key', owner({ meter: '0412', units: 5 })],
    ['a nested owner', owner({ customer: { name: 'Ada Eze' } })],
    ['a name that is a number', owner({ name: 12345 })],
    ['a name that is an object', owner({ name: { first: 'Ada' } })],
    ['a name that is blank', owner({ name: '   ' })],
  ])('cannot read a body with %s', (_k, body) => {
    expect(readMeterAnswer(body)).toEqual({ kind: 'unreadable' });
  });

  it.each([
    ['null', null],
    ['text', '<html>nope</html>'],
    ['an array', [1]],
    ['a number', 7],
  ])('cannot read a body that is %s', (_k, body) => {
    expect(readMeterAnswer(body)).toEqual({ kind: 'unreadable' });
  });

  it.each([
    ['null', { status: 200, data: null }],
    ['an empty object', { status: 200, data: {} }],
  ])(
    'names no one when data is %s: Fintava has no one on that meter',
    (_k, body) => {
      expect(readMeterAnswer(body)).toEqual({ kind: 'not_found' });
    },
  );

  it.each([
    ['"service not currently available"', 'service not currently available'],
    ['"Service Not Currently Available."', 'Service Not Currently Available.'],
    ['"service unavailable"', 'service unavailable'],
    ['"temporarily unavailable"', 'This is temporarily unavailable'],
  ])('is the bills service saying it is off: %s', (_k, message) => {
    expect(readMeterAnswer({ status: 200, message })).toEqual({
      kind: 'service_unavailable',
    });
    // Even with an owner beside it: a body that contradicts itself is not green.
    expect(
      readMeterAnswer({ status: 200, message, data: { name: 'Ada Eze' } }),
    ).toEqual({ kind: 'service_unavailable' });
  });

  it.each([
    [
      'status 400 "Meter not found"',
      { status: 400, message: 'Meter not found' },
    ],
    [
      'a message "Meter not found" beside status 200',
      { status: 200, message: 'Meter not found', data: null },
    ],
    ['a message list', { status: 200, message: ['Invalid meter number'] }],
    [
      'an owner beside "meter not found"',
      { status: 200, message: 'meter not found', data: { name: 'Ada Eze' } },
    ],
    ['status 404 "no such meter"', { status: 404, message: 'no such meter' }],
  ])('is no such meter: %s', (_k, body) => {
    expect(readMeterAnswer(body)).toEqual({ kind: 'not_found' });
  });

  it.each([
    ['a status 400 "Http Exception"', 400, 'Http Exception', 'refused'],
    ['a status 401', 401, 'Invalid API key', 'auth'],
    ['a status 403', 403, 'Merchant is not active', 'merchant_inactive'],
    ['a status 429', 429, 'Too many requests', 'rate_limited'],
    ['a status 500', 500, 'read ECONNRESET', 'unavailable'],
  ])(
    'is the failure Fintava would have sent as a real status: %s',
    (_k, status, message, failure) => {
      const got = readMeterAnswer({ status, message: [message] });
      expect(got).toMatchObject({ kind: 'failed', failure, status });
    },
  );

  it('reads a status that is text too', () => {
    expect(
      readMeterAnswer({ status: '401', message: ['Invalid API key'] }),
    ).toMatchObject({ kind: 'failed', failure: 'auth' });
  });

  it('does not take a status below 400 for a failure', () => {
    expect(
      readMeterAnswer({ status: 201, data: { name: 'Ada Eze' } }),
    ).toMatchObject({ kind: 'owner' });
  });
});

describe('readMeterAnswer: what is never a green found meter (BILLS-01 round 3, R2-1)', () => {
  const owner = (data: Record<string, unknown>, more = {}) => ({
    status: 200,
    message: 'Meter details fetched',
    data,
    ...more,
  });

  it('has the verifier’s 22 bodies, no more and no fewer', () => {
    expect(NOT_GREEN_BODIES).toHaveLength(22);
  });

  it.each(NOT_GREEN_BODIES)(
    'cannot read %s as a meter found',
    (_label, body) => {
      expect(readMeterAnswer(body)).toEqual({ kind: 'unreadable' });
    },
  );

  describe('a name that is a placeholder or a failure word', () => {
    it.each(PLACEHOLDER_NAMES)('%s', (name) => {
      expect(readMeterAnswer(owner({ Customer_Name: name }))).toEqual({
        kind: 'unreadable',
      });
    });

    it.each([
      ['capitals', 'N/a'],
      ['all capitals', 'UNKNOWN'],
      ['all small', 'meter not found'],
      ['spaces round it', '   Unknown   '],
      ['spaces inside it', 'Customer   not   found'],
      ['a full stop after it', 'Unknown.'],
      ['an exclamation mark after it', 'N/A!'],
      ['a question mark after it', 'Unknown?'],
      ['a colon after it', 'Unknown:'],
      ['a semicolon after it', 'Unknown;'],
      ['a comma after it', 'Unknown,'],
      ['several marks after it', 'Unknown...'],
      ['a failure word', 'Failed'],
      ['a long gap between words', 'Not        Available'],
      ['a tab between words', 'Not\tAvailable'],
      ['an invisible character inside it', 'Un\u200bknown'],
      ['a no-break space', 'Not\u00a0Available'],
      ['"none"', 'None'],
      ['"nil"', 'nil'],
      ['a failure sentence', 'Invalid meter number supplied'],
      ['"service not currently available"', 'Service not currently available'],
    ])('is a placeholder with %s', (_k, name) => {
      expect(readMeterAnswer(owner({ name }))).toEqual({ kind: 'unreadable' });
    });

    it.each([
      'Ada Unknown Eze',
      'Nil Okoro',
      'Null Obi',
      'Chidinma Okoro',
      'Ọlá Adéwálé',
    ])('still names the owner %s', (name) => {
      expect(readMeterAnswer(owner({ name }))).toMatchObject({
        kind: 'owner',
        name,
      });
    });
  });

  describe('a name that is blank once invisible characters are taken out', () => {
    it.each([
      ['a zero-width space', '\u200b'],
      ['a zero-width non-joiner', '\u200c'],
      ['a zero-width joiner', '\u200d'],
      ['a byte order mark', '\ufeff'],
      ['a soft hyphen', '\u00ad'],
      ['a word joiner', '\u2060'],
      ['a no-break space', '\u00a0'],
      ['a line separator', '\u2028'],
      ['a tab and a newline', '\t\n'],
      ['a Braille blank', '\u2800'],
      ['a Hangul filler', '\u3164'],
      ['a Hangul choseong filler', '\u115f'],
      ['a Hangul jungseong filler', '\u1160'],
      ['a halfwidth Hangul filler', '\uffa0'],
      ['a combining grapheme joiner', '\u034f'],
      ['several kinds together', ' \u200b\u2800\u3164\ufeff\u00a0 '],
    ])('%s is no name', (_k, name) => {
      expect(readMeterAnswer(owner({ name }))).toEqual({ kind: 'unreadable' });
    });

    it('an address of invisible characters is no address', () => {
      expect(
        readMeterAnswer(owner({ name: 'Ada Eze', address: '\u200b\u2800' })),
      ).toMatchObject({ kind: 'owner', name: 'Ada Eze', address: null });
    });

    it('skips a blank name key and reads the next one that holds a name', () => {
      expect(
        readMeterAnswer(owner({ Customer_Name: '\u200b', name: 'Ada Eze' })),
      ).toMatchObject({ kind: 'owner', name: 'Ada Eze' });
    });
  });

  describe('a body that flags a failure beside a name', () => {
    const named = { name: 'Ada Eze' };
    it.each([
      ['success false', { success: false, data: named }],
      ['success "false"', { success: 'false', data: named }],
      ['error true', { error: true, data: named }],
      ['error text', { error: 'oops', data: named }],
      ['error object', { error: { code: 1 }, data: named }],
      ['error 1', { error: 1, data: named }],
      ['data.error true', { data: { ...named, error: true } }],
      ['data.error text', { data: { ...named, error: 'oops' } }],
      ['statusCode 400', { statusCode: 400, data: named }],
      ['statusCode 404', { statusCode: 404, data: named }],
      ['statusCode 499', { statusCode: 499, data: named }],
      ['statusCode 500', { statusCode: 500, data: named }],
      ['statusCode 599', { statusCode: 599, data: named }],
      ['statusCode "500" as text', { statusCode: '500', data: named }],
      ['data.statusCode 500', { data: { ...named, statusCode: 500 } }],
      ['status "failed"', { status: 'failed', data: named }],
      ['status "Failed" in capitals', { status: 'Failed', data: named }],
      ['status " failure "', { status: ' failure ', data: named }],
      ['status "error"', { status: 'ERROR', data: named }],
      ['data.status "failed"', { data: { ...named, status: 'failed' } }],
      ['data.status "error"', { data: { ...named, status: 'Error' } }],
      ['data.status 400', { data: { ...named, status: 400 } }],
      ['data.status 500', { data: { ...named, status: 500 } }],
    ])('%s is not green', (_k, body) => {
      expect(readMeterAnswer(body)).toEqual({ kind: 'unreadable' });
    });

    it.each([
      ['success true', { success: true, data: named }],
      ['error false', { error: false, data: named }],
      ['error null', { error: null, data: named }],
      ['error empty text', { error: '', data: named }],
      ['error 0', { error: 0, data: named }],
      ['data.error null', { data: { ...named, error: null } }],
      ['statusCode 200', { statusCode: 200, data: named }],
      ['statusCode 399', { statusCode: 399, data: named }],
      ['status "success"', { status: 'success', data: named }],
      ['status "ok"', { status: 'ok', data: named }],
      ['data.status "active"', { data: { ...named, status: 'active' } }],
      ['data.status 200', { data: { ...named, status: 200 } }],
      ['data.status 399', { data: { ...named, status: 399 } }],
    ])('%s is still green', (_k, body) => {
      expect(readMeterAnswer(body)).toMatchObject({
        kind: 'owner',
        name: 'Ada Eze',
      });
    });

    it('answers "no such meter" or "service off" first when the body says so too', () => {
      expect(
        readMeterAnswer({
          error: true,
          message: 'Meter not found',
          data: named,
        }),
      ).toEqual({ kind: 'not_found' });
      expect(
        readMeterAnswer({
          success: false,
          message: 'service not currently available',
          data: named,
        }),
      ).toEqual({ kind: 'service_unavailable' });
    });
  });

  describe('a rule, not a list (BILLS-01 round 4, R3-1 and R3-2)', () => {
    it('has the verifier’s 125 spellings, 55 flag shapes (48 failures, 7 controls)', () => {
      expect(PLACEHOLDER_NAMES_125).toHaveLength(125);
      expect(FAILURE_FLAG_BODIES).toHaveLength(48);
      expect(CONTROL_FLAG_BODIES).toHaveLength(7);
    });

    it.each(PLACEHOLDER_NAMES_125.slice(COMPANY_FORM_COUNT))(
      'the verifier’s placeholder %j names no one',
      (name) => {
        expect(
          readMeterAnswer(owner({ Customer_Name: name, Address: '1 Road' })),
        ).toEqual({
          kind: 'unreadable',
        });
      },
    );

    it.each(REAL_OWNERS)('still names the owner %s', (name) => {
      expect(readMeterAnswer(owner({ Customer_Name: name }))).toMatchObject({
        kind: 'owner',
        name,
      });
    });

    it.each(FAILURE_FLAG_BODIES)(
      'the verifier’s flag %s is not a meter found',
      (_label, body) => {
        expect(readMeterAnswer(body)).toEqual({ kind: 'unreadable' });
      },
    );

    it.each(CONTROL_FLAG_BODIES)(
      'the verifier’s control %s is still a meter found',
      (_label, body) => {
        expect(readMeterAnswer(body)).toMatchObject({
          kind: 'owner',
          name: 'Ada Eze',
        });
      },
    );

    it.each([
      ['Plc', 'Plc'],
      ['PLC.', 'PLC.'],
      ['Limited', 'Limited'],
      ['Ltd', 'Ltd'],
      ['Distribution Company', 'Distribution Company'],
      ['Disco', 'Disco'],
      ['Electric', 'Electric'],
      ['Electricity', 'Electricity'],
      ['a form with nothing else', 'Electric Distribution Company Limited'],
      ['placeholder words and a form', 'Unknown Plc'],
    ])('is not an owner when the name is only %s', (_k, name) => {
      expect(readMeterAnswer(owner({ name }))).toEqual({ kind: 'unreadable' });
    });

    it.each([
      ['one word of a person among placeholders', 'Customer Ada'],
      ['a number is not a name', 'Ada 2'],
      ['a form beside a person’s name', 'Ada Okoro Ltd'],
      ['the words of a placeholder in a longer name', 'Meter Okoro Number'],
    ])('is an owner when it holds a word that is neither: %s', (_k, name) => {
      expect(readMeterAnswer(owner({ name }))).toMatchObject({
        kind: 'owner',
        name,
      });
    });

    it('reads only the start of a very long name, so a hostile one costs no more than a short one', () => {
      const started = Date.now();
      // Five megabytes of "null": nothing but placeholders in the part that is read.
      expect(
        readMeterAnswer(owner({ name: 'null '.repeat(1_000_000) })),
      ).toEqual({ kind: 'unreadable' });
      // A real name followed by five megabytes of spaces is still the owner.
      const padded = readMeterAnswer(
        owner({ name: `Ada Eze${' '.repeat(5_000_000)}` }),
      );
      // (Not compared as whole objects: a failure would print five megabytes.)
      expect(padded.kind).toBe('owner');
      expect(padded.kind === 'owner' && padded.name === 'Ada Eze').toBe(true);
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it.each([...PLACEHOLDER_WORDS, ...COMPANY_FORM_WORDS].map((w) => [w]))(
      'the word %s alone names no one, and the word twice names no one',
      (word) => {
        for (const name of [word, `${word} ${word}`, word.toUpperCase()]) {
          expect(readMeterAnswer(owner({ name }))).toEqual({
            kind: 'unreadable',
          });
        }
      },
    );

    it('one word of a person among the placeholder and company words makes an owner', () => {
      for (const w of [...PLACEHOLDER_WORDS, ...COMPANY_FORM_WORDS]) {
        expect(readMeterAnswer(owner({ name: `${w} Okonkwo` }))).toMatchObject({
          kind: 'owner',
          name: `${w} Okonkwo`,
        });
      }
    });

    it('reads a name as words: case, width, spaces of every kind and every n/a spelling folded', () => {
      expect(nameWordsOf('  Ada\t\u00a0 EZE ')).toEqual(['ada', 'eze']);
      expect(nameWordsOf('\uff21\uff44\uff41')).toEqual(['ada']);
      expect(nameWordsOf('A\u200bda')).toEqual(['ada']);
      for (const na of [
        'n/a',
        'N/A',
        'n / a',
        'N\\A',
        'n.a',
        'N.A.',
        '#N/A',
        'NA',
      ]) {
        expect(nameWordsOf(na)).toEqual(['na']);
      }
      expect(nameWordsOf('Ada n/a Eze')).toEqual(['ada', 'na', 'eze']);
      expect(nameWordsOf('Ian/Anna')).toEqual(['ian', 'anna']);
      expect(nameWordsOf('')).toEqual([]);
      expect(nameWordsOf('...')).toEqual([]);
    });

    it('reads no more than the first 2,000 characters of a name', () => {
      expect(nameWordsOf('x '.repeat(5000))).toHaveLength(1000);
      expect(nameWordsOf(`${'y'.repeat(1994)} zz abc`)).toEqual([
        'y'.repeat(1994),
        'zz',
        'ab',
      ]);
    });

    it('takes the extra words a caller adds, and only whole words', () => {
      const company = new Set(['ikeja', 'ikedc']);
      expect(isNotAnOwner('IKEDC', company)).toBe(true);
      expect(isNotAnOwner('Ikeja Plc', company)).toBe(true);
      expect(isNotAnOwner('Ikejaland', company)).toBe(false);
      expect(isNotAnOwner('Ikeja Ada', company)).toBe(false);
      expect(isNotAnOwner('Ikeja Plc')).toBe(false);
    });

    it.each([
      'success',
      'successful',
      'isSuccess',
      'isSuccessful',
      'valid',
      'isValid',
      'verified',
      'isVerified',
      'found',
      'isFound',
      'exists',
      'exist',
      'ok',
      'status',
      'Is_Valid',
      'SUCCESS',
    ])(
      'an explicit no under %s is a failure, at the top and in data',
      (key) => {
        expect(
          readMeterAnswer({ [key]: false, data: { name: 'Ada Eze' } }),
        ).toEqual({
          kind: 'unreadable',
        });
        expect(
          readMeterAnswer({ data: { name: 'Ada Eze', [key]: false } }),
        ).toEqual({
          kind: 'unreadable',
        });
      },
    );

    it.each([
      false,
      0,
      'false',
      'FALSE',
      ' False ',
      '0',
      'no',
      'No',
      'n',
      'f',
      'off',
    ])('%j is a no', (no) => {
      expect(
        readMeterAnswer({ success: no, data: { name: 'Ada Eze' } }),
      ).toEqual({
        kind: 'unreadable',
      });
    });

    it.each([
      true,
      1,
      'true',
      'yes',
      'ok',
      'success',
      200,
      '200',
      'on',
      null,
      '',
    ])('%j is not a no', (yes) => {
      expect(
        readMeterAnswer({ success: yes, data: { name: 'Ada Eze' } }),
      ).toMatchObject({
        kind: 'owner',
      });
    });

    it.each([
      'status',
      'message',
      'messages',
      'error',
      'errors',
      'errorMessage',
      'error_msg',
      'reason',
    ])('failure words under %s are a failure, as text and in a list', (key) => {
      expect(
        readMeterAnswer({ [key]: 'It failed', data: { name: 'Ada Eze' } }),
      ).toEqual({
        kind: 'unreadable',
      });
      expect(
        readMeterAnswer({
          [key]: ['fine', 'it failed'],
          data: { name: 'Ada Eze' },
        }),
      ).toEqual({
        kind: 'unreadable',
      });
      expect(
        readMeterAnswer({ data: { name: 'Ada Eze', [key]: 'It failed' } }),
      ).toEqual({
        kind: 'unreadable',
      });
    });

    it.each([
      'failed',
      'failure',
      'Failures',
      'it fails',
      'error',
      'errors',
      'invalid',
      'unable to do it',
      'unsuccessful',
      'unsuccessfully done',
      'unauthorized',
      'Unauthorised',
      'forbidden',
      'denied',
      'rejected',
      'reject',
      'declined',
      'decline',
      'refused',
      'refusal',
      'inactive',
      'expired',
      'exception',
      'bad request',
      'timed out',
      'time out',
      'timeout',
      'not found',
      'not available',
      'not registered',
      'not valid',
      'not successful',
      'unavailable',
      'no such thing',
      'does not exist',
      'did not exist',
      "doesn't exist",
      'doesn\u2019t exist',
      'could not',
      "couldn't",
      'couldn\u2019t',
      'cannot',
      "can't",
      'can\u2019t',
    ])('the words "%s" in a message are a failure', (said) => {
      expect(
        readMeterAnswer({ data: { name: 'Ada Eze', message: said } }),
      ).toEqual({
        kind: 'unreadable',
      });
    });

    it.each([
      'Meter details fetched',
      'Customer details retrieved successfully',
      'ok',
      'success',
      'Successful',
      'active',
      'pending',
      'verified',
      'Records fetched',
      'fine',
    ])('the message "%s" is not a failure', (said) => {
      expect(
        readMeterAnswer({ message: said, data: { name: 'Ada Eze' } }),
      ).toMatchObject({
        kind: 'owner',
      });
    });

    it.each(['error', 'errors', 'errorMessage', 'errorMsg'])(
      'anything in %s is a failure, and nothing in it is not',
      (key) => {
        for (const held of [true, 1, 'x', ' x ', ['x'], { a: 1 }, 'false']) {
          expect(
            readMeterAnswer({ [key]: held, data: { name: 'Ada Eze' } }),
          ).toEqual({
            kind: 'unreadable',
          });
        }
        for (const empty of [false, 0, null, undefined, '', '   ', [], {}]) {
          expect(
            readMeterAnswer({ [key]: empty, data: { name: 'Ada Eze' } }),
          ).toMatchObject({
            kind: 'owner',
          });
        }
      },
    );

    it.each([
      'statusCode',
      'responseCode',
      'responseStatus',
      'httpStatus',
      'httpCode',
    ])(
      'a result code under %s: 0, 00 and 200 to 399 pass, the rest and the words do not',
      (key) => {
        for (const good of [
          0,
          '0',
          '00',
          '000',
          200,
          '200',
          201,
          299,
          300,
          399,
          '399',
          'success',
          'OK',
          'approved',
        ]) {
          expect(
            readMeterAnswer({ [key]: good, data: { name: 'Ada Eze' } }),
          ).toMatchObject({
            kind: 'owner',
          });
        }
        for (const bad of [
          1,
          '01',
          99,
          '99',
          100,
          199,
          400,
          '400',
          404,
          500,
          599,
          999,
          'x',
          'declined',
          'Internal',
          true,
        ]) {
          expect(
            readMeterAnswer({ [key]: bad, data: { name: 'Ada Eze' } }),
          ).toEqual({
            kind: 'unreadable',
          });
        }
        for (const none of [null, undefined, '']) {
          expect(
            readMeterAnswer({ [key]: none, data: { name: 'Ada Eze' } }),
          ).toMatchObject({
            kind: 'owner',
          });
        }
      },
    );

    it('a plain code is a result code only as a number of up to three digits', () => {
      for (const bad of [1, '01', '99', 150, 400, '500', 999]) {
        expect(
          readMeterAnswer({ code: bad, data: { name: 'Ada Eze' } }),
        ).toEqual({
          kind: 'unreadable',
        });
      }
      for (const good of [
        0,
        '00',
        200,
        '201',
        399,
        1000,
        '1000',
        '12345',
        'AEDC',
        'x',
        4.5,
        null,
      ]) {
        expect(
          readMeterAnswer({ code: good, data: { name: 'Ada Eze' } }),
        ).toMatchObject({
          kind: 'owner',
        });
      }
    });

    it('looks for a failure four levels down and ten items into a list, and not further', () => {
      const deep = (n: number): Record<string, unknown> =>
        n === 0 ? { error: 'x' } : { next: deep(n - 1) };
      // The body is level 0 and data level 1: an object four levels below the body is read, one five levels below is not.
      expect(
        readMeterAnswer({ data: { name: 'Ada Eze', ...deep(3) } }),
      ).toEqual({
        kind: 'unreadable',
      });
      expect(
        readMeterAnswer({ data: { name: 'Ada Eze', ...deep(4) } }),
      ).toMatchObject({
        kind: 'owner',
      });
      const list = (at: number) =>
        Array.from({ length: 12 }, (_v, i) =>
          i === at ? { valid: false } : { valid: true },
        );
      expect(
        readMeterAnswer({ data: { name: 'Ada Eze', checks: list(9) } }),
      ).toEqual({
        kind: 'unreadable',
      });
      expect(
        readMeterAnswer({ data: { name: 'Ada Eze', checks: list(10) } }),
      ).toMatchObject({
        kind: 'owner',
      });
      expect(
        readMeterAnswer({
          data: {
            name: 'Ada Eze',
            notes: [...Array(9).fill('fine'), 'it failed'],
          },
        }),
      ).toMatchObject({ kind: 'owner' });
      expect(
        readMeterAnswer({
          message: [...Array(9).fill('fine'), 'it failed'],
          data: { name: 'Ada Eze' },
        }),
      ).toEqual({ kind: 'unreadable' });
      expect(
        readMeterAnswer({
          message: [...Array(10).fill('fine'), 'it failed'],
          data: { name: 'Ada Eze' },
        }),
      ).toMatchObject({ kind: 'owner' });
    });

    it.each([
      ['success "No"', { success: 'No' }],
      ['ok false', { ok: false }],
      ['ok "0"', { ok: '0' }],
      ['valid "false"', { valid: 'false' }],
      ['status "F"', { status: 'f' }],
      [
        'a result code "00" is a success and "55" a failure',
        { responseCode: '55' },
      ],
      ['a result code in words', { responseCode: 'error' }],
      ['a 3 digit code of 150', { code: 150 }],
      [
        'a failure two levels down',
        { data: { name: 'Ada Eze', meta: { error: 'x' } } },
      ],
      [
        'a failure in a list in data',
        { data: { name: 'Ada Eze', checks: [{ valid: false }] } },
      ],
      ['message "Could not verify"', { message: 'Could not verify the meter' }],
      ['message "Request timed out"', { message: 'Request timed out' }],
      ['message "Not authorized"', { message: 'Unauthorized' }],
      ['message "Bad request"', { message: 'Bad Request' }],
      [
        'a message list holding a failure',
        { message: ['ok', 'Meter is not valid'] },
      ],
    ])('flags a failure beside a name: %s', (_k, extra) => {
      const body =
        'data' in extra ? extra : { ...extra, data: { name: 'Ada Eze' } };
      expect(readMeterAnswer(body)).toEqual({ kind: 'unreadable' });
    });

    it.each([
      ['a result code "00"', { responseCode: '00' }],
      ['a result code 0', { responseCode: 0 }],
      ['a result code "200"', { responseCode: '200' }],
      ['a result code "success"', { responseCode: 'success' }],
      ['code a disco code', { data: { name: 'Ada Eze', code: 'AEDC' } }],
      [
        'code a customer code of four digits',
        { data: { name: 'Ada Eze', code: '12345' } },
      ],
      ['success "yes"', { success: 'yes' }],
      ['status "pending"', { status: 'pending' }],
      [
        'message "Meter details fetched successfully"',
        { message: 'Meter details fetched successfully' },
      ],
      ['an empty error list', { errors: [] }],
      ['valid true, found true', { valid: true, found: true }],
    ])('does not flag %s', (_k, extra) => {
      const body =
        'data' in extra ? extra : { ...extra, data: { name: 'Ada Eze' } };
      expect(readMeterAnswer(body)).toMatchObject({ kind: 'owner' });
    });
  });

  describe('which name key wins, and what an empty data array is (round 2 test gaps V5 and V6)', () => {
    it('an empty data array is unreadable, not nobody', () => {
      expect(readMeterAnswer({ status: 200, data: [] })).toEqual({
        kind: 'unreadable',
      });
    });

    it('takes the first of the name keys in this order: customer name, name, account name, consumer name, full name', () => {
      const order = [
        ['Customer_Name', 'Ada'],
        ['name', 'Bola'],
        ['accountName', 'Chika'],
        ['consumerName', 'Dayo'],
        ['fullName', 'Efe'],
        ['customerFullName', 'Femi'],
      ] as const;
      for (let i = 0; i < order.length; i += 1) {
        const data = Object.fromEntries(order.slice(i));
        // Written in reverse, so the object’s own order cannot be what decides.
        const reversed = Object.fromEntries(Object.entries(data).reverse());
        expect(readMeterAnswer(owner(reversed))).toMatchObject({
          kind: 'owner',
          name: order[i][1],
        });
      }
    });

    it('takes the first of the address keys in this order', () => {
      const keys = [
        'address',
        'customerAddress',
        'consumerAddress',
        'serviceAddress',
      ];
      for (let i = 0; i < keys.length; i += 1) {
        // Written in reverse, so the object’s own order cannot be what decides.
        const data = Object.fromEntries(
          keys
            .slice(i)
            .map((k, j) => [k, String(i + j + 1)])
            .reverse(),
        ) as Record<string, string>;
        expect(
          readMeterAnswer(owner({ name: 'Ada Eze', ...data })),
        ).toMatchObject({ address: String(i + 1) });
      }
    });
  });
});

describe('FintavaClient.previewMeter reads the answer over the wire', () => {
  const double = new FintavaDouble();
  const client = () =>
    new FintavaClient(
      fintavaConfig({
        FINTAVA_BASE_URL: double.baseUrl,
        FINTAVA_API_KEY: 'live_test_meter_0123456789FAKEKEY',
      }),
    );
  const ask = () =>
    client().previewMeter({
      meterNumber: '04123456789',
      disco: 'AEDC',
      planType: 'prepaid',
    });
  const answer = (status: number, body: unknown) =>
    double.on('POST', '/billing/preview-meter', { status, body });
  const failure = async (p: Promise<unknown>): Promise<FintavaError> => {
    try {
      await p;
    } catch (e) {
      return e as FintavaError;
    }
    throw new Error('expected a FintavaError');
  };

  beforeAll(() => double.start());
  afterAll(() => double.stop());
  beforeEach(() => double.reset());

  it('gives the owner and the address for a body that names one', async () => {
    answer(200, {
      data: { Customer_Name: 'Chidinma Okoro', Address: '14 Admiralty Way' },
      status: 200,
    });
    expect(await ask()).toMatchObject({
      ownerName: 'Chidinma Okoro',
      ownerAddress: '14 Admiralty Way',
    });
  });

  it('keeps the address out of `details`, which drops address fields on purpose', async () => {
    answer(200, {
      data: { customerName: 'Ada Eze', address: '14 Admiralty Way', units: 5 },
      status: 200,
    });
    expect((await ask())?.details).toEqual({
      customerName: 'Ada Eze',
      units: 5,
    });
  });

  it('is null for a 2xx that says no such meter, as for the bare 400', async () => {
    answer(200, { status: 400, message: 'Meter not found', data: null });
    expect(await ask()).toBeNull();
  });

  it('is null for a 2xx that names no one', async () => {
    answer(200, { status: 200, data: {} });
    expect(await ask()).toBeNull();
  });

  it('is a FintavaError marked `serviceNotAvailable` for a 201 "service not currently available"', async () => {
    answer(201, { status: 201, message: 'service not currently available' });
    const e = await failure(ask());
    expect(e).toBeInstanceOf(FintavaError);
    expect(e.kind).toBe('unavailable');
    expect(e.serviceNotAvailable).toBe(true);
    expect(e.httpStatus).toBe(201);
  });

  it('marks nothing else as `serviceNotAvailable`', async () => {
    answer(500, fintavaError(500, 'read ECONNRESET'));
    const e = await failure(ask());
    expect(e.kind).toBe('unavailable');
    expect(e.serviceNotAvailable).toBe(false);
  });

  it.each([
    ['data a string', 200, { data: 'x', status: 200 }],
    ['data an array', 200, { data: [{ name: 'A' }], status: 200 }],
    ['an object with no name', 200, { data: { units: 4 }, status: 200 }],
    ['no data', 200, { status: 200, message: 'ok' }],
    ['an HTML page', 200, '<html>bad gateway</html>'],
    ['JSON cut short', 200, '{"data": {"name": "Brok'],
    ['an empty body', 200, ''],
  ])(
    'is `bad_response` for %s, and logs nothing of it',
    async (_k, status, body) => {
      answer(status, body);
      const e = await failure(ask());
      expect(e.kind).toBe('bad_response');
      expect(e.messages.join(' ')).not.toMatch(/Brok|bad gateway/);
    },
  );

  it('turns a body that carries a real failure status into that failure', async () => {
    answer(200, { status: 403, message: ['Merchant is not active'] });
    expect((await failure(ask())).kind).toBe('merchant_inactive');
    answer(200, { status: 401, message: ['Invalid API key'] });
    expect((await failure(ask())).kind).toBe('auth');
    answer(200, { status: 500, message: ['read ECONNRESET'] });
    expect((await failure(ask())).kind).toBe('unavailable');
  });

  it('is null for a body that carries status 400 "Http Exception", as for the bare 400', async () => {
    answer(200, { status: 400, message: ['Http Exception'] });
    expect(await ask()).toBeNull();
  });
});
