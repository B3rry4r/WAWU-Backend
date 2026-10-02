import { createHash, createHmac } from 'node:crypto';
import {
  accountFunded,
  cardPayment,
  customerBankTransfer,
  debitTransferReversal,
  virtualWalletPayment,
  walletToWallet,
} from '../../../../test/fintava/fintava-webhook-payloads';
import {
  FINTAVA_WEBHOOK_EVENTS,
  jsonWithoutNul,
  readFintavaWebhook,
  withoutNul,
} from '../fintava-webhook-event';
import { fintavaSignatureMatches, signFintavaBody } from '../fintava-signature';

/** MONEY-07: the pure parts of the Fintava webhook (no database, no HTTP). */

const SECRET = 'whsec_local_only_7Hq2Lm9Pz4Rt6Vx8';
const RUN = 'unit';

function read(text: string) {
  const raw = Buffer.from(text, 'utf8');
  return readFintavaWebhook(JSON.parse(text) as unknown, raw);
}

describe('the signature: HMAC-SHA512 of the raw body, hex', () => {
  const raw = Buffer.from(accountFunded(RUN), 'utf8');

  it('is what Fintava documents (createHmac sha512 over the raw bytes, hex)', () => {
    const documented = createHmac('sha512', SECRET).update(raw).digest('hex');
    expect(signFintavaBody(SECRET, raw)).toBe(documented);
    expect(documented).toMatch(/^[0-9a-f]{128}$/);
  });

  it('matches its own body under its own secret, either hex case, with spaces trimmed', () => {
    const sig = signFintavaBody(SECRET, raw);
    expect(fintavaSignatureMatches(SECRET, raw, sig)).toBe(true);
    expect(fintavaSignatureMatches(SECRET, raw, sig.toUpperCase())).toBe(true);
    expect(fintavaSignatureMatches(SECRET, raw, ` ${sig} `)).toBe(true);
  });

  it('refuses another secret, one changed byte, a truncated or padded value, non-hex and empty', () => {
    const sig = signFintavaBody(SECRET, raw);
    expect(fintavaSignatureMatches(`${SECRET}x`, raw, sig)).toBe(false);
    const tampered = Buffer.from(raw);
    tampered[tampered.length - 3] ^= 1;
    expect(fintavaSignatureMatches(SECRET, tampered, sig)).toBe(false);
    expect(fintavaSignatureMatches(SECRET, raw, sig.slice(0, 127))).toBe(false);
    expect(fintavaSignatureMatches(SECRET, raw, `${sig}0`)).toBe(false);
    expect(fintavaSignatureMatches(SECRET, raw, `sha512=${sig}`)).toBe(false);
    expect(fintavaSignatureMatches(SECRET, raw, 'z'.repeat(128))).toBe(false);
    expect(fintavaSignatureMatches(SECRET, raw, '')).toBe(false);
    // The SHA-256 of the body is 64 hex digits: refused before comparing.
    const sha256 = createHash('sha256').update(raw).digest('hex');
    expect(fintavaSignatureMatches(SECRET, raw, sha256)).toBe(false);
  });

  it('is over the bytes, not the JSON: the same object re-serialised does not match', () => {
    const sig = signFintavaBody(SECRET, raw);
    const reserialised = Buffer.from(
      JSON.stringify(JSON.parse(raw.toString('utf8'))),
      'utf8',
    );
    expect(fintavaSignatureMatches(SECRET, reserialised, sig)).toBe(false);
  });
});

describe('reading a delivery: event, key and status', () => {
  it('account_funded is keyed on data.reference', () => {
    expect(read(accountFunded(RUN))).toEqual({
      event: 'account_funded',
      eventRaw: 'account_funded',
      known: true,
      reference: `000014231211154211281900319598-${RUN}`,
      referenceField: 'data.reference',
      fintavaStatus: 'SUCCESS',
      dataReference: `000014231211154211281900319598-${RUN}`,
      dataCustomerReference: null,
    });
  });

  it('VIRTUAL_WALLET_PAYMENT under `type` is virtual_wallet_payment, keyed on our merchantReference', () => {
    expect(read(virtualWalletPayment(RUN))).toMatchObject({
      event: 'virtual_wallet_payment',
      eventRaw: 'VIRTUAL_WALLET_PAYMENT',
      known: true,
      reference: `9TTEER288282882818-${RUN}`,
      referenceField: 'data.merchantReference',
      fintavaStatus: 'PAID',
    });
  });

  it('customer_bank_transfer is keyed on data.customerReference and keeps both references as sent', () => {
    expect(read(customerBankTransfer(RUN))).toMatchObject({
      event: 'customer_bank_transfer',
      known: true,
      reference: `FIO241106308911000370001675-${RUN}`,
      referenceField: 'data.customerReference',
      fintavaStatus: 'SUCCESS',
      dataReference: `2e076e1-019a-4a3c-b1a6-65b0d98-${RUN}`,
      dataCustomerReference: `FIO241106308911000370001675-${RUN}`,
    });
  });

  it('wallet_to_wallet_transfer_v2 carries only `reference` in the docs and is keyed on it; no status', () => {
    expect(read(walletToWallet(RUN))).toMatchObject({
      event: 'wallet_to_wallet_transfer_v2',
      known: true,
      reference: `48VYIuIAZTSVQlZ8O900JdcUJ0imoVZ1L-${RUN}`,
      referenceField: 'data.reference',
      fintavaStatus: '',
      dataCustomerReference: null,
    });
  });

  it('debit_transfer_reversal is keyed on its reversalRef; data.type "CREDIT" is not the event', () => {
    expect(read(debitTransferReversal(RUN))).toMatchObject({
      event: 'debit_transfer_reversal',
      eventRaw: 'debit_transfer_reversal',
      known: true,
      reference: `r-tyqwA0xLFh2ifNhDX9BWSgzGb0C-${RUN}`,
      referenceField: 'data.reversalRef',
      fintavaStatus: 'SUCCESS',
      dataCustomerReference: `FIO241106308911000370001675-${RUN}`,
    });
  });

  it('a delivery with no reference is keyed on the sha256 of its raw body', () => {
    const text = cardPayment(RUN);
    const digest = createHash('sha256')
      .update(Buffer.from(text, 'utf8'))
      .digest('hex');
    expect(read(text)).toMatchObject({
      event: 'card_payment',
      known: true,
      reference: `sha256:${digest}`,
      referenceField: 'body.sha256',
      fintavaStatus: '',
    });
  });

  it('reads `event` before `type`, and the field name in any case', () => {
    expect(
      read(
        '{"type":"account_funded","event":"wallet_to_wallet_transfer_v2","data":{"reference":"R1"}}',
      ).event,
    ).toBe('wallet_to_wallet_transfer_v2');
    expect(
      read('{"Event":" Account_Funded ","data":{"reference":"R1"}}'),
    ).toMatchObject({
      event: 'account_funded',
      eventRaw: 'Account_Funded',
      known: true,
    });
    expect(
      read('{"TYPE":"DEBIT_TRANSFER_REVERSAL","data":{"reversalRef":"R2"}}')
        .event,
    ).toBe('debit_transfer_reversal');
  });

  it('an unknown or missing event is kept, as unrecognised, never refused', () => {
    expect(
      read('{"event":"transfer_success","data":{"reference":"R3"}}'),
    ).toMatchObject({
      event: 'transfer_success',
      known: false,
      reference: 'R3',
    });
    expect(read('{"data":{"reference":"R4"}}')).toMatchObject({
      event: '',
      eventRaw: null,
      known: false,
      reference: 'R4',
    });
    expect(read('{"event":"has spaces; and more","data":{}}')).toMatchObject({
      event: '',
      eventRaw: 'has spaces; and more',
      known: false,
      referenceField: 'body.sha256',
    });
    const arr = read('[1,2,3]');
    expect(arr).toMatchObject({
      event: '',
      known: false,
      referenceField: 'body.sha256',
    });
  });

  it('a name like "constructor" is not an event we know', () => {
    expect(
      read('{"event":"constructor","data":{"reference":"R5"}}').known,
    ).toBe(false);
  });

  it('numbers are references too; empty, too long and object values are skipped', () => {
    expect(
      read('{"event":"account_funded","data":{"reference":12345}}'),
    ).toMatchObject({
      reference: '12345',
      referenceField: 'data.reference',
    });
    expect(
      read(
        `{"event":"account_funded","data":{"reference":"  ","sessionID":"S1"}}`,
      ),
    ).toMatchObject({ reference: 'S1', referenceField: 'data.sessionID' });
    expect(
      read(
        `{"event":"account_funded","data":{"reference":"${'x'.repeat(201)}","sessionID":{"a":1}}}`,
      ),
    ).toMatchObject({ referenceField: 'body.sha256', dataReference: null });
  });

  it('every documented event has a consumer and at least one reference field', () => {
    expect(Object.keys(FINTAVA_WEBHOOK_EVENTS).sort()).toEqual([
      'account_funded',
      'card_payment',
      'customer_bank_transfer',
      'debit_transfer_reversal',
      'dynamic_card_payment',
      'virtual_wallet_payment',
      'wallet_to_wallet_transfer_v2',
    ]);
    for (const spec of Object.values(FINTAVA_WEBHOOK_EVENTS)) {
      expect(spec.consumers.length).toBeGreaterThan(0);
      expect(spec.references.length).toBeGreaterThan(0);
    }
  });
});

describe('NUL, which Postgres text and json cannot hold', () => {
  it('becomes U+FFFD in every string and key, the same way every time', () => {
    expect(withoutNul('a\u0000b\u0000')).toBe('a\uFFFDb\uFFFD');
    expect(withoutNul('plain')).toBe('plain');
    expect(
      jsonWithoutNul({
        'k\u0000': ['x\u0000', 1, null, true, { y: 'z\u0000' }],
      }),
    ).toEqual({ 'k\uFFFD': ['x\uFFFD', 1, null, true, { y: 'z\uFFFD' }] });
  });

  it('a NUL in a reference or an event name is replaced before it becomes the key', () => {
    const text =
      '{"event":"account_funded","data":{"reference":"R\\u0000X","status":"succ\\u0000ess"}}';
    const a = read(text);
    expect(a).toMatchObject({
      reference: 'R\uFFFDX',
      dataReference: 'R\uFFFDX',
      fintavaStatus: 'SUCC\uFFFDESS',
    });
    expect(read(text)).toEqual(a);
    expect(read('{"event":"acc\\u0000ount","data":{}}')).toMatchObject({
      event: '',
      eventRaw: 'acc\uFFFDount',
      known: false,
    });
  });
});
