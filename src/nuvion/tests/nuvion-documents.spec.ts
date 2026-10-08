import { DocumentsNuvion, ulid } from '../../../test/nuvion/documents-standin';
import { envelope, NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import {
  NUVION_DOCUMENT_MAX_BYTES,
  NUVION_LIVENESS_REFUSAL_MEMO_MS,
  NuvionDocumentsArea,
} from '../areas/documents';
import { NuvionClient } from '../nuvion-client';
import {
  NUVION_CONFIG_KEYS,
  NuvionConfigError,
  readNuvionSettings,
} from '../nuvion-config';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { sniffDocument } from '../documents/document-file';
import { fingerprintOf } from '../documents/documents-flow';

/**
 * NUV-03, the parts that need no database: the file sniff, the fingerprint,
 * the two new settings, and the documents area against the stand-in (its
 * request bodies and what it makes of each answer).
 */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('sniffDocument: what an upload really is', () => {
  const pdfBody = (tail: string) =>
    Buffer.from(`%PDF-1.7\n1 0 obj<<>>endobj\n${tail}`);

  it.each([
    ['a PNG', Buffer.concat([PNG_SIG, Buffer.alloc(40, 1)]), 'image/png'],
    [
      'a JPEG',
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]),
      'image/jpeg',
    ],
    [
      'a JPEG that is an EXIF one',
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]),
      'image/jpeg',
    ],
    [
      'a PDF with its end marker',
      pdfBody('trailer<<>>\n%%EOF\n'),
      'application/pdf',
    ],
    [
      'a PDF with junk after the end marker',
      pdfBody(`%%EOF\n${'\0'.repeat(1_500)}`),
      'application/pdf',
    ],
  ])('%s', (_name, bytes, type) => {
    expect(sniffDocument(bytes)).toBe(type);
  });

  it.each([
    ['nothing', Buffer.alloc(0)],
    ['one byte', Buffer.from([0xff])],
    ['a PNG signature cut short', PNG_SIG.subarray(0, 7)],
    ['two JPEG marker bytes only', Buffer.from([0xff, 0xd8])],
    ['a GIF', Buffer.from('GIF89a......')],
    ['a WebP', Buffer.from('RIFF....WEBPVP8 ')],
    ['HTML', Buffer.from('<!doctype html><html></html>')],
    ['a ZIP', Buffer.from('PK\x03\x04....')],
    [
      'a Word file',
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    ],
    ['text that mentions %PDF-', Buffer.from(' %PDF-1.4 %%EOF')],
    ['a PDF with no end marker', pdfBody('x'.repeat(6_000))],
    [
      'a PDF whose end marker is far from the end',
      pdfBody(`%%EOF\n${'x'.repeat(6_000)}`),
    ],
  ])('%s is not accepted', (_name, bytes) => {
    expect(sniffDocument(bytes)).toBeNull();
  });
});

describe('fingerprintOf: the same file once', () => {
  const a = Buffer.from('front-a');
  const b = Buffer.from('back-b');

  it('is a SHA-256 hex, the same for the same bytes', () => {
    expect(fingerprintOf(a, null)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf(a, null)).toBe(
      fingerprintOf(Buffer.from('front-a'), null),
    );
  });

  it('differs for another file, for a back, and for the same bytes as a back', () => {
    const base = fingerprintOf(a, null);
    expect(fingerprintOf(b, null)).not.toBe(base);
    expect(fingerprintOf(a, b)).not.toBe(base);
    // front "ab" + no back is not front "a" + back "b".
    expect(fingerprintOf(Buffer.from('ab'), null)).not.toBe(
      fingerprintOf(Buffer.from('a'), Buffer.from('b')),
    );
  });
});

describe('the two settings of the hosted selfie', () => {
  const ENV: Record<string, string> = {
    NUVION_BASE_URL: 'https://api.nuvion.dev',
    NUVION_API_KEY: 'nv_test_sk_unit000000000000000000',
    NUVION_WEBHOOK_SECRET: 'whsec_unit',
    NUVION_OPERATIONAL_ACCOUNT_ID: '01HXYZOPERATIONAL000000001',
  };
  const read = (extra: Record<string, string | undefined>) =>
    readNuvionSettings((k) => ({ ...ENV, ...extra })[k]).settings;

  it.each([
    [undefined, false],
    ['', false],
    ['off', false],
    ['OFF', false],
    ['on', true],
    [' On ', true],
  ])('NUVION_HOSTED_LIVENESS=%j is %s', (value, expected) => {
    expect(read({ NUVION_HOSTED_LIVENESS: value }).hostedLiveness).toBe(
      expected,
    );
  });

  it.each(['yes', 'true', '1', 'auto'])(
    'NUVION_HOSTED_LIVENESS=%s stops the server naming the setting',
    (value) => {
      expect(() => read({ NUVION_HOSTED_LIVENESS: value })).toThrow(
        new NuvionConfigError(
          `${NUVION_CONFIG_KEYS.hostedLiveness} must be on or off.`,
        ),
      );
    },
  );

  it('NUVION_LIVENESS_REDIRECT_ORIGINS: none, or a list of https origins', () => {
    expect(read({}).livenessRedirectOrigins).toEqual([]);
    expect(
      read({
        NUVION_LIVENESS_REDIRECT_ORIGINS:
          ' https://wawuafrica.example , https://app.wawu.example/, https://wawuafrica.example ',
      }).livenessRedirectOrigins,
    ).toEqual(['https://wawuafrica.example', 'https://app.wawu.example']);
  });

  it.each([
    'http://wawuafrica.example',
    'https://wawuafrica.example/path',
    'https://user:pw@wawuafrica.example',
    'wawuafrica.example',
    'javascript:alert(1)',
    'https://ok.example, nope',
  ])(
    'NUVION_LIVENESS_REDIRECT_ORIGINS=%s stops the server naming the setting',
    (value) => {
      expect(() => read({ NUVION_LIVENESS_REDIRECT_ORIGINS: value })).toThrow(
        new NuvionConfigError(
          `${NUVION_CONFIG_KEYS.livenessRedirectOrigins} must list https origins.`,
        ),
      );
    },
  );
});

describe('the documents area against the Nuvion stand-in', () => {
  const standin = new NuvionStandin();
  const nuvion = new DocumentsNuvion(standin);
  let client: NuvionClient;
  let area: NuvionDocumentsArea;
  const on = () => {
    (client.settings as { hostedLiveness?: boolean }).hostedLiveness = true;
  };

  beforeAll(async () => {
    await standin.start();
  });
  afterAll(() => standin.stop());
  beforeEach(() => {
    standin.reset();
    nuvion.reset();
    nuvion.install();
    client = new NuvionClient(
      standin.settings({ hostedLiveness: false }),
      'nv_test_sk_unit000000000000000000',
    );
    area = new NuvionDocumentsArea(client);
  });

  const upload = (entityId: string, personId: string, over = {}) => ({
    entityId,
    personId,
    kind: 'identity' as const,
    front: Buffer.from('front-bytes'),
    back: null,
    mimeType: 'image/png' as const,
    ...over,
  });

  describe('uploadDocument', () => {
    it('sends the documented body, with the back in the same call', async () => {
      const e = nuvion.addEntity();
      const receipt = await area.uploadDocument(
        upload(e.id, e.personId, { back: Buffer.from('back-bytes') }),
      );
      expect(receipt.documentId).toBe(e.documents[0].id);
      expect(standin.seen).toHaveLength(1);
      expect(standin.seen[0]).toMatchObject({
        method: 'POST',
        path: '/documents',
        body: {
          entity_id: e.id,
          key: 'identity',
          description: 'Identity document',
          file: Buffer.from('front-bytes').toString('base64'),
          file_back: Buffer.from('back-bytes').toString('base64'),
          meta: { file_type: 'image/png' },
          link_to_identity: { person_id: e.personId },
        },
      });
    });

    it('a proof of address has its own key and description, and no back', async () => {
      const e = nuvion.addEntity();
      await area.uploadDocument(
        upload(e.id, e.personId, {
          kind: 'proof_of_address',
          mimeType: 'application/pdf',
        }),
      );
      const b = standin.seen[0].body as Record<string, unknown>;
      expect(b.key).toBe('proof_of_address');
      expect(b.description).toBe('Proof of address');
      expect(b).not.toHaveProperty('file_back');
    });

    it.each([
      ['an empty file', { front: Buffer.alloc(0) }],
      ['an entity id that is not one', { entityId: '../admin' }],
      ['an entity id with a slash', { entityId: 'a/b' }],
      ['a person id that is not one', { personId: 'x y' }],
      ['an entity id that is empty', { entityId: '' }],
    ])('%s is refused before anything is sent', async (_name, over) => {
      const e = nuvion.addEntity();
      await expect(
        area.uploadDocument(upload(e.id, e.personId, over)),
      ).rejects.toMatchObject({ kind: 'validation', recordMayExist: false });
      expect(standin.seen).toEqual([]);
    });

    it.each([
      ['no document in the answer', { data: {} }],
      ['a document with no id', { data: { document: { key: 'identity' } } }],
      [
        'an id that is not one',
        { data: { document: { id: 'a b', key: 'identity' } } },
      ],
      [
        'a document of the other kind',
        { data: { document: { id: 'D'.repeat(26), key: 'proof_of_address' } } },
      ],
      [
        'a document of another entity',
        {
          data: {
            document: {
              id: 'D'.repeat(26),
              key: 'identity',
              entity_id: 'OTHER00000000000000000001',
            },
          },
        },
      ],
    ])(
      '%s is not proof: not_confirmed, and the document may exist',
      async (_name, answer) => {
        const e = nuvion.addEntity();
        standin.next({ status: 201, body: envelope(answer.data) });
        await expect(
          area.uploadDocument(upload(e.id, e.personId)),
        ).rejects.toMatchObject({
          kind: 'not_confirmed',
          recordMayExist: true,
        });
      },
    );

    it('a lost answer is an unknown outcome, never a refusal', async () => {
      const e = nuvion.addEntity();
      standin.loseNext();
      const err: unknown = await area
        .uploadDocument(upload(e.id, e.personId))
        .catch((x: unknown) => x);
      expect(err).toBeInstanceOf(WalletProviderError);
      expect(err).toMatchObject({
        kind: 'outcome_unknown',
        recordMayExist: true,
      });
    });
  });

  describe('readDocuments', () => {
    it('reads the review word, the person and the documents, and skips a row it cannot read', async () => {
      const e = nuvion.addEntity({ status: 'pending' });
      await area.uploadDocument(upload(e.id, e.personId));
      standin.next(() => ({
        status: 200,
        body: envelope({
          entity: {
            id: e.id,
            type: 'individual',
            status: 'Pending',
            person_id: e.personId,
          },
          person: { id: e.personId },
          documents: [
            {
              id: e.documents[0].id,
              key: 'identity',
              created: 1_700_000_000_000,
            },
            { id: 'bad id', key: 'identity' },
            { id: ulid('01DOC'), key: 7 },
            'text',
            null,
            { id: ulid('01DOC'), key: 'proof_of_address' },
          ],
        }),
      }));
      const read = await area.readDocuments(e.id);
      expect(read.status).toBe('pending');
      expect(read.personId).toBe(e.personId);
      expect(read.documents.map((d) => d.key)).toEqual([
        'identity',
        'proof_of_address',
      ]);
      expect(read.documents[0].created).toBe(1_700_000_000_000);
      expect(read.documents[1].created).toBeNull();
      expect(standin.seen[1].query).toEqual({ entity_id: e.id });
    });

    it('an answer for another entity is bad_response', async () => {
      const e = nuvion.addEntity();
      const other = nuvion.addEntity();
      standin.next(() => ({
        status: 200,
        body: envelope({
          entity: { id: other.id, type: 'individual', status: 'incomplete' },
        }),
      }));
      await expect(area.readDocuments(e.id)).rejects.toMatchObject({
        kind: 'bad_response',
      });
    });

    it('refuses an id with traversal in it before sending', async () => {
      await expect(area.readDocuments('%2e%2e')).rejects.toMatchObject({
        kind: 'validation',
      });
      expect(standin.seen).toEqual([]);
    });
  });

  describe('submitOnboarding and the seam’s submitKyc', () => {
    it('sends the entity and answers its new status', async () => {
      const e = nuvion.addEntity();
      expect(await area.submitOnboarding(e.id)).toEqual({ status: 'pending' });
      expect(standin.seen[0]).toMatchObject({
        method: 'POST',
        path: '/onboarding-submissions',
        body: { entity_id: e.id },
      });
    });

    it.each([
      ['pending', 'submitted'],
      ['approved', 'approved'],
      ['rejected', 'rejected'],
      ['incomplete', 'pending'],
    ])(
      'submitKyc maps Nuvion saying %s to %s, and reads nothing else of the submission',
      async (status, state) => {
        const e = nuvion.addEntity();
        nuvion.submitStatus = status;
        const kyc = {
          customerId: e.id,
          // Never sent: the entity already holds the person (NUV-02).
          bvn: '22200000001',
          nin: '33300000002',
        } as never;
        expect(await area.submitKyc(kyc)).toEqual({ customerId: e.id, state });
        expect(JSON.stringify(standin.seen[0].body)).not.toContain(
          '22200000001',
        );
        expect(standin.seen[0].body).toEqual({ entity_id: e.id });
      },
    );

    it('an answer that does not name the entity is not proof', async () => {
      const e = nuvion.addEntity();
      standin.next({ status: 201, body: envelope({}) });
      await expect(area.submitOnboarding(e.id)).rejects.toMatchObject({
        kind: 'not_confirmed',
        recordMayExist: true,
      });
    });

    it('Nuvion saying the entity is no longer incomplete keeps its type, for the caller to read', async () => {
      const e = nuvion.addEntity({ status: 'pending' });
      const err: unknown = await area
        .submitOnboarding(e.id)
        .catch((x: unknown) => x);
      expect(err).toMatchObject({
        kind: 'refused',
        nuvionType: 'error_entity_status_not_incomplete',
        recordMayExist: false,
      });
    });
  });

  describe('the hosted selfie', () => {
    it('is off by default: nothing is sent, not_supported', async () => {
      expect(area.hostedLiveness).toBe(false);
      for (const call of [
        () => area.startLiveness('E'.repeat(26), null),
        () => area.readLiveness('S'.repeat(26), null),
        () => area.linkLiveness('E'.repeat(26), 'S'.repeat(26)),
        () => area.startLivenessSession({ customerId: 'E'.repeat(26) }),
        () => area.getLivenessResult('S'.repeat(26)),
      ]) {
        await expect(call()).rejects.toMatchObject({
          kind: 'not_supported',
          recordMayExist: false,
        });
      }
      expect(standin.seen).toEqual([]);
    });

    it('on, it starts a session for the child entity and reads and links it', async () => {
      on();
      const e = nuvion.addEntity();
      const started = await area.startLiveness(e.id, 'https://back.example/x');
      expect(started.url).toMatch(/^https:\/\//);
      expect(standin.seen[0]).toMatchObject({
        method: 'POST',
        path: '/kyc/liveness/sessions',
        body: { entity_id: e.id, redirect_url: 'https://back.example/x' },
      });
      const read = await area.readLiveness(started.sessionId, e.id);
      expect(read).toMatchObject({
        state: 'pending',
        captureStatus: 'pending',
        verificationStatus: 'pending',
        captureUrl: started.url,
      });
      await area.linkLiveness(e.id, started.sessionId);
      expect(standin.seen[2]).toMatchObject({
        method: 'PATCH',
        path: `/individual-entities/${e.id}`,
        body: {
          entity_id: e.id,
          meta: { liveness_check_id: started.sessionId },
        },
      });
    });

    it.each([
      ['pending', 'pending', 'pending'],
      ['completed', 'pending', 'pending'],
      ['completed', 'approved', 'passed'],
      ['pending', 'approved', 'pending'],
      ['completed', 'not-approved', 'not_passed'],
      ['image-error', 'pending', 'not_passed'],
      ['internal-error', 'pending', 'not_passed'],
      ['pending', 'not-approved', 'not_passed'],
      ['something-new', 'something-new', 'pending'],
    ])(
      'capture %s and verification %s read as %s',
      async (capture, verification, state) => {
        on();
        const e = nuvion.addEntity();
        const started = await area.startLiveness(e.id, null);
        const s = nuvion.sessions.get(started.sessionId)!;
        s.captureStatus = capture;
        s.verificationStatus = verification;
        expect((await area.readLiveness(started.sessionId, e.id)).state).toBe(
          state,
        );
      },
    );

    it('no return address is sent when none is given; a session the answer does not name is not proof', async () => {
      on();
      const e = nuvion.addEntity();
      await area.startLiveness(e.id, null);
      expect(standin.seen[0].body).toEqual({ entity_id: e.id });
      for (const data of [
        {},
        { url: 'https://x.example/a' },
        { query_id: 'Q'.repeat(20) },
        { url: 'http://insecure.example/a', query_id: 'Q'.repeat(20) },
        { url: 'javascript:alert(1)', query_id: 'Q'.repeat(20) },
        { url: 'https://u:p@x.example/a', query_id: 'Q'.repeat(20) },
        { url: 'https://x.example/a', query_id: 'bad id' },
      ]) {
        standin.next({ status: 201, body: envelope(data) });
        await expect(area.startLiveness(e.id, null)).rejects.toMatchObject({
          kind: 'not_confirmed',
          recordMayExist: true,
        });
      }
    });

    it('a status answer with neither word is bad_response; a resume address that is not https is dropped', async () => {
      on();
      const e = nuvion.addEntity();
      standin.next({ status: 200, body: envelope({}) });
      await expect(
        area.readLiveness('S'.repeat(20), e.id),
      ).rejects.toMatchObject({
        kind: 'bad_response',
      });
      standin.next({
        status: 200,
        body: envelope({
          capture_status: 'pending',
          verification_status: 'pending',
          capture_url: 'http://insecure.example/x',
        }),
      });
      expect(
        (await area.readLiveness('S'.repeat(20), e.id)).captureUrl,
      ).toBeNull();
    });

    it('refuses an id with traversal in it before sending', async () => {
      on();
      await expect(area.readLiveness('%2e%2e', null)).rejects.toMatchObject({
        kind: 'validation',
      });
      await expect(
        area.linkLiveness('E'.repeat(20), '../x'),
      ).rejects.toMatchObject({
        kind: 'validation',
      });
      expect(standin.seen).toEqual([]);
    });

    it('a refusal turns it off for an hour, then Nuvion is believed again', () => {
      on();
      let t = 1_000_000;
      area.now = () => t;
      expect(area.hostedLiveness).toBe(true);
      area.noteLivenessRefused();
      expect(area.hostedLiveness).toBe(false);
      t += NUVION_LIVENESS_REFUSAL_MEMO_MS - 1;
      expect(area.hostedLiveness).toBe(false);
      t += 1;
      expect(area.hostedLiveness).toBe(true);
    });

    it('off in the settings it stays off whatever the memo says', () => {
      expect(area.hostedLiveness).toBe(false);
      area.noteLivenessRefused();
      expect(area.hostedLiveness).toBe(false);
    });
  });

  it('the documented size limit is 10 MB', () => {
    expect(NUVION_DOCUMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});
