import { Logger } from '@nestjs/common';
import {
  NuvionAccountsStandin,
  standinId,
} from '../../../test/nuvion/accounts-standin';
import {
  envelope,
  errorBody,
  NuvionStandin,
  type StandinAnswer,
  type StandinRequest,
} from '../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import {
  NuvionPayoutsStandin,
  PARENT_ENTITY,
} from '../../../test/nuvion/payouts-standin';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { NuvionPayoutsArea } from '../areas/payouts';
import { NuvionClient } from '../nuvion-client';
import type { NuvionError } from '../nuvion-error';

/**
 * FIX-97: the three payout bugs the dev-key run found (mobile repo
 * docs/nuvion/DEV-RESULTS.md, NUV-06 rows and "Failures for fix tasks").
 * Every Nuvion answer below is what Nuvion's DEV answered on 23 Oct 2026 for
 * the sandbox test account at bank 044 ending 0031 (the number is Nuvion's
 * own docs example), copied field by field; nothing in this file is a guess.
 * This file does not lean on the stand-in's own name-check, counterparty or
 * entity routes: it answers them itself, so it says what dev says whatever
 * the stand-in does.
 *
 *  1. The name check body must carry `issuer: { code }`; dev answered 422
 *     "The 'issuer' field is required" to a `bank_code` body (01M5MC27).
 *  2. The holder is at `data.details.name` (01M5MCKK); a made-up number is
 *     404 `error_resource_not_found`, not `error_resolution_account_not_found`.
 *  3. A counterparty for an individual needs `profile.email` and
 *     `profile.address` (422 without, 01M5MCJF): the SENDING side's own, as
 *     its Nuvion entity holds them. Missing either stops the send before any
 *     counterparty is made.
 */

const KEY = 'nv_test_sk_FIX97devKEY000000000000000';
const NUMBER = '0690000031';
const HOLDER = 'Forrest Green';

/** Dev's 200 for bank 044 and the test account (01M5MCKK), verbatim in shape. */
const DEV_LOOKUP = {
  _id: '01M5MD7FK8S4JQPZQ4P9A79JZM',
  lookup_id: `${NUMBER}_044`,
  refresh_after: 1792760078779,
  details: {
    issuer: { code: '044', name: 'N/A', short_name: 'N/A' },
    account_number: NUMBER,
    name: HOLDER,
  },
  created: 1792760069736,
  updated: 1792760069736,
  meta: { routability: 'routable' },
  status: 'successful',
  status_reason: 'successfully_resolved',
};

const requiredField = (name: string) => ({
  type: 'error_validation_required_field_missing',
  message: `The '${name}' field is required. Please include it and try again.`,
});

/** Dev's 422 (01M5MC27 and 01M5MCJF): the `validations` list names each field. */
const devValidation = (fields: string[]): StandinAnswer => ({
  status: 422,
  body: {
    ...errorBody(
      'error_validation_error',
      'Validation failed for one or more fields',
    ),
    validations: fields.map((f) => ({ [f]: requiredField(f) })),
  },
});

/** What dev's `GET /entities/{id}` holds that a counterparty needs. */
const devAddress = (ownerId: string, ownerType: 'person' | 'business') => ({
  id: standinId('01ADR'),
  city: 'Victoria Island',
  state: 'Lagos',
  line_1: '11 Opebi Road',
  owner_id: ownerId,
  owner_type: ownerType,
  postal_code: '101241',
  country_code: 'NG',
  label: 'registered_address',
});

describe('FIX-97: the payout calls as Nuvion DEV answers them', () => {
  const standin = new NuvionStandin();
  const nuv = new NuvionAccountsStandin(standin);
  const pay = new NuvionPayoutsStandin(standin, nuv);
  let guard: OutboundGuard;
  let area: NuvionPayoutsArea;
  let seq = 0;
  /** Entity id to what dev's `GET /entities/{id}` answers for it. */
  const entities = new Map<string, Record<string, unknown> | 'fail'>();

  beforeAll(async () => {
    Logger.overrideLogger(false);
    guard = guardOutbound();
    await standin.start();
    nuv.install();
    pay.install();
    // Dev's routes win over the stand-in's own (the later registration wins).
    standin.on('POST', '/counterparty-lookups', (req: StandinRequest) => {
      pay.lookups.push(req.body);
      const b = (req.body ?? {}) as {
        account_number?: string;
        issuer?: { code?: string };
      };
      if (!b.issuer?.code) return devValidation(['issuer']);
      if (b.account_number === NUMBER && b.issuer.code === '044') {
        return {
          status: 200,
          body: envelope(DEV_LOOKUP, 'Account retrieved successfully'),
        };
      }
      return {
        status: 404,
        body: errorBody(
          'error_resource_not_found',
          "We couldn't find that accounts. It may have been deleted or the ID might be incorrect.",
        ),
      };
    });
    standin.on('POST', '/counterparties', (req: StandinRequest) => {
      pay.counterpartyRequests.push(req.body);
      const b = (req.body ?? {}) as {
        entity_id?: string;
        meta?: Record<string, string>;
        profile?: {
          first_name?: string;
          last_name?: string;
          email?: string;
          address?: { line1?: string; city?: string; country?: string };
        };
      };
      const profile = b.profile;
      const missing = [
        ...(profile?.address?.line1 &&
        profile.address.city &&
        profile.address.country
          ? []
          : ['address']),
        ...(profile?.email ? [] : ['email']),
      ];
      if (missing.length > 0) return devValidation(missing);
      const made = {
        id: standinId('01CPY'),
        entity_id: b.entity_id ?? PARENT_ENTITY,
        type: 'individual',
        nickname: `${profile?.first_name} ${profile?.last_name}`,
        status: 'active' as const,
        profile: profile ?? {},
        meta: b.meta ?? {},
        created: Date.now(),
        updated: Date.now(),
        deleted: 0,
      };
      // The stand-in's payment details and transfers look the counterparty up.
      pay.counterparties.set(made.id, made);
      return {
        status: 201,
        body: envelope(made, 'Counterparty created successfully'),
      };
    });
    standin.on('GET', /^\/entities\/[A-Za-z0-9]+$/, (req: StandinRequest) => {
      const answer = entities.get(req.path.split('/')[2]);
      if (answer === 'fail') {
        return { status: 500, body: errorBody('error_system_internal_error') };
      }
      return answer
        ? { status: 200, body: envelope(answer, 'Entity retrieved') }
        : {
            status: 404,
            body: errorBody('error_resource_not_found', 'not found'),
          };
    });
    area = new NuvionPayoutsArea(
      new NuvionClient(
        standin.settings({
          operationalAccountId: pay.operationalAccountId,
          moneyTimeoutMs: 1_500,
        }),
        KEY,
      ),
    );
  });
  afterAll(async () => {
    await standin.stop();
    guard.restore();
    expect(guard.violations).toEqual([]);
  });
  beforeEach(() => {
    standin.reset();
    entities.clear();
    pay.counterpartyRequests.length = 0;
    pay.lookups.length = 0;
    pay.paymentDetailRequests.length = 0;
    pay.transferRequests.length = 0;
  });

  const ref = () => {
    seq += 1;
    return `wawu-fix97-${Date.now().toString(36)}-${seq}`;
  };
  const fails = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(WalletProviderError);
      return e as NuvionError;
    }
    throw new Error('expected a WalletProviderError');
  };
  const postsTo = (path: string) =>
    standin.seen.filter((r) => r.method === 'POST' && r.path === path);

  /** A person with a naira account and the entity dev would answer for them. */
  const person = (
    over: { person?: Record<string, unknown>; address?: unknown } = {},
  ) => {
    const entityId = standinId('01ENT');
    nuv.addAccount(entityId, {
      balance: { available: 5_000_000, current: 5_000_000, overdraft_used: 0 },
    });
    const address = devAddress(entityId, 'person');
    entities.set(entityId, {
      entity: { id: entityId, type: 'individual', status: 'approved' },
      person: {
        id: standinId('01PER'),
        first_name: 'Test',
        last_name: 'Sender',
        email: 'test.sender@example.test',
        ...over.person,
      },
      address: 'address' in over ? over.address : address,
      addresses: 'address' in over ? [] : [address],
    });
    return entityId;
  };
  const send = (entityId: string | null) =>
    area.bankTransfer({
      from:
        entityId === null
          ? { kind: 'merchant' }
          : { kind: 'customer', customerId: entityId },
      accountNumber: NUMBER,
      accountName: HOLDER,
      bankCode: '044',
      amountKobo: 250_000n,
      reference: ref(),
    });

  describe('fix 1: the name check asks with the bank as `issuer`', () => {
    it('sends { country, account_number, issuer: { code } } and no bank_code', async () => {
      await area.checkAccountName({ accountNumber: NUMBER, bankCode: '044' });
      expect(postsTo('/counterparty-lookups')[0].body).toEqual({
        country: 'NG',
        account_number: NUMBER,
        issuer: { code: '044' },
      });
    });
  });

  describe('fix 2: the name check reads the name from `details.name`', () => {
    it('bank 044 and the test account answer Forrest Green', async () => {
      expect(
        await area.checkAccountName({ accountNumber: NUMBER, bankCode: '044' }),
      ).toEqual({
        matched: true,
        accountName: HOLDER,
        accountNumber: NUMBER,
        bankCode: '044',
        outcome: 'matched',
      });
    });

    it('a made-up number is 404 error_resource_not_found, which is "not found"', async () => {
      expect(
        await area.checkAccountName({
          accountNumber: '1234567890',
          bankCode: '044',
        }),
      ).toMatchObject({
        matched: false,
        accountName: null,
        outcome: 'not_found',
      });
    });
  });

  describe("fix 3: a counterparty carries the sending side's own email and address", () => {
    it("a person's send gives their email and address, read from their entity", async () => {
      const entityId = person();
      const r = await send(entityId);
      expect(r.payee?.counterpartyId).toMatch(/^01CPY/);
      expect(pay.counterpartyRequests).toHaveLength(1);
      expect(pay.counterpartyRequests[0]).toMatchObject({
        type: 'individual',
        entity_id: entityId,
        profile: {
          relationship: 'vendor',
          email: 'test.sender@example.test',
          address: {
            line1: '11 Opebi Road',
            city: 'Victoria Island',
            country: 'NG',
          },
        },
      });
      expect(postsTo('/payment-details')).toHaveLength(1);
      expect(postsTo('/transfers')).toHaveLength(1);
    });

    it("an address that is only in `addresses` (the docs' shape) is read too", async () => {
      const entityId = person();
      const e = entities.get(entityId) as Record<string, unknown>;
      entities.set(entityId, { ...e, address: undefined });
      await send(entityId);
      expect(pay.counterpartyRequests[0]).toMatchObject({
        profile: { address: { line1: '11 Opebi Road', country: 'NG' } },
      });
    });

    it("WAWU's own send gives the operational account's entity email and address", async () => {
      entities.set(PARENT_ENTITY, {
        entity: { id: PARENT_ENTITY, type: 'business', status: 'approved' },
        business: {
          id: standinId('01BUS'),
          email: 'finance@wawu.example.test',
        },
        address: devAddress(PARENT_ENTITY, 'business'),
        addresses: [devAddress(PARENT_ENTITY, 'business')],
      });
      await send(null);
      expect(pay.counterpartyRequests).toHaveLength(1);
      expect(pay.counterpartyRequests[0]).toMatchObject({
        profile: {
          email: 'finance@wawu.example.test',
          address: { line1: '11 Opebi Road', city: 'Victoria Island' },
        },
      });
      expect('entity_id' in (pay.counterpartyRequests[0] as object)).toBe(
        false,
      );
    });

    it('no email on file stops the send before any counterparty, payment detail or transfer', async () => {
      const entityId = person({ person: { email: undefined } });
      const e = await fails(send(entityId));
      expect(e.kind).toBe('validation');
      expect(e.recordMayExist).toBe(false);
      expect(postsTo('/counterparties')).toHaveLength(0);
      expect(postsTo('/payment-details')).toHaveLength(0);
      expect(postsTo('/transfers')).toHaveLength(0);
    });

    it('no address on file stops the send the same way, and none is made up', async () => {
      for (const address of [
        null,
        { id: 'x', city: 'Lagos', country_code: 'NG' },
        { id: 'x', line_1: '1 Road', city: 'Lagos', country_code: 'NGA' },
      ]) {
        standin.reset();
        const entityId = person({ address });
        const e = await fails(send(entityId));
        expect(e.kind).toBe('validation');
        expect(postsTo('/counterparties')).toHaveLength(0);
        expect(postsTo('/transfers')).toHaveLength(0);
      }
    });

    it('an entity that cannot be read is a send that did not start, never a guessed address', async () => {
      const entityId = person();
      entities.set(entityId, 'fail');
      const e = await fails(send(entityId));
      expect(e.requestNotSent).toBe(true);
      expect(e.recordMayExist).toBe(false);
      expect(postsTo('/counterparties')).toHaveLength(0);
      expect(postsTo('/transfers')).toHaveLength(0);
    });

    it('a second send to the same account reuses its counterparty and reads no entity', async () => {
      const entityId = person();
      const first = await send(entityId);
      const entityReads = standin.seen.filter(
        (r) => r.method === 'GET' && r.path.startsWith('/entities/'),
      ).length;
      expect(entityReads).toBe(1);
      const again = await area.bankTransfer({
        from: { kind: 'customer', customerId: entityId },
        accountNumber: NUMBER,
        accountName: HOLDER,
        bankCode: '044',
        amountKobo: 100_000n,
        reference: ref(),
        payee: first.payee,
      });
      expect(again.payee).toEqual(first.payee);
      expect(postsTo('/counterparties')).toHaveLength(1);
      expect(
        standin.seen.filter(
          (r) => r.method === 'GET' && r.path.startsWith('/entities/'),
        ),
      ).toHaveLength(entityReads);
    });
  });
});
