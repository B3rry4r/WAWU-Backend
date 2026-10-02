import {
  BANKS,
  BVN_200,
  CABLE_201_UNAVAILABLE,
  CABLE_PLANS,
  CABLE_PROVIDERS,
  CREATE_201,
  CUSTOMER_A,
  CUSTOMER_BY_ID,
  CUSTOMER_DETAILS,
  CUSTOMER_LIST,
  customerHistory,
  DATA_BUNDLES,
  DISCOS,
  FintavaDouble,
  fintavaConfig,
  fintavaError,
  fintavaValidation,
  FREEZE_200,
  historyRow,
  LOMA_NAME,
  MERCHANT_ACCOUNT,
  MERCHANT_BALANCE,
  merchantHistory,
  NAME_ENQUIRY,
  RECORD_BY_ID,
  recordByReference,
  SELFIE_200,
  SELFIE_400,
  selfieAnswer,
  W2W_200,
  WALLET_BALANCE,
} from '../../../test/fintava/fintava-double';
import { FintavaClient } from '../fintava-client';
import { FintavaError } from '../fintava-error';
import { FintavaModule } from '../fintava.module';

/**
 * MONEY-06 contract tests: each call in docs/PLAN.md items 1 to 12 (item 13,
 * webhooks, is MONEY-07's receiving end; nothing is called), driven over a
 * real socket against a local double that answers with the bodies the
 * sandbox really sent. Every quirk in the mobile repo's
 * `docs/fintava/naira-api.md` has a test here or in fintava-units.spec.ts.
 */

const KEY = 'live_test_0123456789abcdefFAKEKEY';
const double = new FintavaDouble();

function client(extra: Record<string, string> = {}): FintavaClient {
  return new FintavaClient(
    fintavaConfig({
      FINTAVA_BASE_URL: double.baseUrl,
      FINTAVA_API_KEY: KEY,
      ...extra,
    }),
  );
}

async function failure(p: Promise<unknown>): Promise<FintavaError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FintavaError) return e;
    throw e;
  }
  throw new Error('expected a FintavaError');
}

beforeAll(() => double.start());
afterAll(() => double.stop());
beforeEach(() => double.reset());

describe('every request', () => {
  it('carries the Bearer key and nothing signs it', async () => {
    double.on('GET', '/merchant/balance', {
      status: 200,
      body: MERCHANT_BALANCE,
    });
    await client().getMerchantBalance();
    const req = double.seen[0];
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.headers.accept).toBe('application/json');
    expect(Object.keys(req.headers).filter((h) => /sign/i.test(h))).toEqual([]);
  });

  it('with no key in config, fails as not_configured and sends nothing', async () => {
    const c = new FintavaClient(
      fintavaConfig({ FINTAVA_BASE_URL: double.baseUrl }),
    );
    const e = await failure(c.getMerchantBalance());
    expect(e.kind).toBe('not_configured');
    expect(double.seen).toHaveLength(0);
  });

  it('a bad key is a clear typed error whatever the status (401, 400, 404)', async () => {
    for (const [status, text] of [
      [401, 'API Key is required'],
      [400, 'Invalid API key'],
      [404, 'Invalid API Key'],
    ] as const) {
      double.reset();
      double.on('GET', '/merchant/balance', {
        status,
        body: fintavaError(status, text),
      });
      const e = await failure(client().getMerchantBalance());
      expect(e.kind).toBe('auth');
      expect(e.httpStatus).toBe(status);
    }
    // A 404 bad key on a lookup is NOT read as "transaction absent".
    double.reset();
    double.on('GET', /^\/transaction\/reference\//, {
      status: 404,
      body: fintavaError(404, 'Invalid API Key'),
    });
    const e = await failure(client().getTransactionByReference('MONEY06-X'));
    expect(e.kind).toBe('auth');
  });

  it('a read that times out is unavailable; a send that times out is outcome_unknown', async () => {
    const c = client({
      FINTAVA_TIMEOUT_MS: '100',
      FINTAVA_MONEY_TIMEOUT_MS: '100',
    });
    double.on('GET', '/merchant/balance', {
      status: 200,
      body: MERCHANT_BALANCE,
      delayMs: 400,
    });
    double.on('POST', '/transaction/wallet-to-wallet', {
      status: 200,
      body: W2W_200,
      delayMs: 400,
    });
    expect((await failure(c.getMerchantBalance())).kind).toBe('unavailable');
    const e = await failure(
      c.walletToWallet({
        senderAccountNumber: MERCHANT_ACCOUNT,
        receiverAccountNumber: CUSTOMER_A.accountNumber,
        amountKobo: 1000,
        customerReference: 'MONEY06-T-1',
      }),
    );
    expect(e.kind).toBe('outcome_unknown');
    expect(e.reference).toBe('MONEY06-T-1');
    expect(e.recordMayExist).toBe(true);
  });

  it('a dropped connection on a send is outcome_unknown, never a failure', async () => {
    double.on('POST', '/transaction/wallet-to-wallet', {
      status: 0,
      hangUp: true,
    });
    const e = await failure(
      client().walletToWallet({
        senderAccountNumber: MERCHANT_ACCOUNT,
        receiverAccountNumber: CUSTOMER_A.accountNumber,
        amountKobo: 1000,
        customerReference: 'MONEY06-T-2',
      }),
    );
    expect(e.kind).toBe('outcome_unknown');
  });

  it('the module provides the client', () => {
    const providers = Reflect.getMetadata(
      'providers',
      FintavaModule,
    ) as unknown[];
    const exported = Reflect.getMetadata('exports', FintavaModule) as unknown[];
    expect(providers).toContain(FintavaClient);
    expect(exported).toContain(FintavaClient);
  });
});

describe('1. identity checks (charged; typed, never run against the sandbox here)', () => {
  it('verifyBvn reads the documented identity and drops nothing it needs', async () => {
    double.on('GET', '/compliance/verify/bvn', { status: 200, body: BVN_200 });
    const id = await client().verifyBvn('12345678901');
    expect(double.seen[0].query).toEqual({ bvn: '12345678901' });
    expect(id).toEqual({
      firstName: 'Ada',
      middleName: 'B',
      lastName: 'Sandbox',
      dateOfBirth: '1992-10-04',
      phone: '09012345678',
      gender: 'Female',
      imageBase64: 'aGVsbG8=',
    });
  });

  it('an unknown BVN, a failed selfie and an unknown phone are identity_refused', async () => {
    double.on('GET', '/compliance/verify/bvn', {
      status: 400,
      body: fintavaError(400, 'Invalid BVN or BVN does not exist'),
    });
    double.on('POST', '/compliance/verify/bvn/selfie', {
      status: 400,
      body: fintavaError(400, 'Request failed with status code 404'),
    });
    double.on('GET', '/compliance/verify/phone-number', {
      status: 400,
      body: fintavaError(400, 'Phone Number not Found'),
    });
    const c = client();
    expect((await failure(c.verifyBvn('12345678901'))).kind).toBe(
      'identity_refused',
    );
    expect(
      (
        await failure(
          c.verifyBvnSelfie({
            bvn: '12345678901',
            imageBase64: 'iVBORw0KGgo=',
          }),
        )
      ).kind,
    ).toBe('identity_refused');
    expect((await failure(c.verifyPhone('+2348031230101'))).kind).toBe(
      'identity_refused',
    );
    expect(double.seen[1].body).toEqual({
      bvn: '12345678901',
      image: 'iVBORw0KGgo=',
    });
    expect(double.seen[2].query).toEqual({ phone_number: '08031230101' });
  });

  it('refuses a malformed BVN before paying for a check', async () => {
    const e = await failure(client().verifyBvn('123'));
    expect(e.kind).toBe('validation');
    expect(double.seen).toHaveLength(0);
  });
});

describe('1b. the selfie match (KYC-02): typed verdict and score, nothing else passed on', () => {
  const IMAGE = 'iVBORw0KGgo'.padEnd(64, 'A');
  const sent = { bvn: '12345678901', image: IMAGE };
  const selfie = () =>
    client().verifyBvnSelfie({ bvn: sent.bvn, imageBase64: IMAGE });

  it('sends the BVN and the base64 image in a JSON body, with the key', async () => {
    double.on('POST', '/compliance/verify/bvn/selfie', {
      status: 200,
      body: SELFIE_200,
    });
    await selfie();
    expect(double.seen).toHaveLength(1);
    expect(double.seen[0].body).toEqual({ bvn: sent.bvn, image: IMAGE });
    expect(double.seen[0].query).toEqual({});
    expect(double.seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(double.seen[0].headers['content-type']).toBe('application/json');
  });

  it('a 2xx with a data object is a match; with no score the confidence is null', async () => {
    double.on('POST', '/compliance/verify/bvn/selfie', {
      status: 200,
      body: SELFIE_200,
    });
    await expect(selfie()).resolves.toEqual({
      matched: true,
      confidence: null,
    });
  });

  it('reads a score, and a verdict field set to false is a failed match even on a 2xx', async () => {
    double.on('POST', '/compliance/verify/bvn/selfie', {
      status: 200,
      body: selfieAnswer(sent, { match: true, confidence_value: 99.5 }),
    });
    await expect(selfie()).resolves.toEqual({
      matched: true,
      confidence: 99.5,
    });
    double.reset();
    double.on('POST', '/compliance/verify/bvn/selfie', {
      status: 200,
      body: { data: { verified: false, confidence: '12.25' } },
    });
    await expect(selfie()).resolves.toEqual({
      matched: false,
      confidence: 12.25,
    });
  });

  it('passes on nothing else of the answer: not the BVN, the photo or the image it echoed', async () => {
    double.on('POST', '/compliance/verify/bvn/selfie', {
      status: 200,
      body: selfieAnswer(sent, { match: true, confidence: 88 }),
    });
    const result = await selfie();
    expect(Object.keys(result).sort()).toEqual(['confidence', 'matched']);
    const text = JSON.stringify(result);
    expect(text).not.toContain(sent.bvn);
    expect(text).not.toContain('QkFTRTY0UEhPVE8');
    expect(text).not.toContain(IMAGE);
  });

  it('the sandbox’s failed match is identity_refused; a body we cannot read is bad_response', async () => {
    double.on('POST', '/compliance/verify/bvn/selfie', {
      status: 400,
      body: SELFIE_400,
    });
    expect((await failure(selfie())).kind).toBe('identity_refused');
    double.reset();
    double.on('POST', '/compliance/verify/bvn/selfie', {
      status: 200,
      body: { status: 200, message: 'successful' },
    });
    expect((await failure(selfie())).kind).toBe('bad_response');
  });

  it('refuses a malformed BVN, an empty image or a data: URL before paying for a match', async () => {
    const c = client();
    for (const input of [
      { bvn: '123', imageBase64: IMAGE },
      { bvn: sent.bvn, imageBase64: '' },
      { bvn: sent.bvn, imageBase64: `data:image/png;base64,${IMAGE}` },
    ]) {
      expect((await failure(c.verifyBvnSelfie(input))).kind).toBe('validation');
    }
    expect(double.seen).toHaveLength(0);
  });
});

describe('2. customers: create answers 201, and a customer has four ids', () => {
  const input = {
    firstName: 'Ada',
    lastName: 'Sandbox',
    phone: '+234 803 123 0101',
    email: 'ada@example.com',
    address: '1 Test Street, Ikeja, Lagos',
    dateOfBirth: '1992-10-04',
    bvn: '12345678901',
    nin: '12345670003',
  };

  it('createCustomer accepts 201 and returns the ids, without the tier', async () => {
    double.on('POST', '/create/customer', { status: 201, body: CREATE_201 });
    const c = await client().createCustomer(input);
    expect(double.seen[0].body).toEqual({
      firstName: 'Ada',
      lastName: 'Sandbox',
      phoneNumber: '08031230101',
      email: 'ada@example.com',
      fundingMethod: 'STATIC_FUND',
      address: '1 Test Street, Ikeja, Lagos',
      dateOfBirth: '1992-10-04',
      bvn: '12345678901',
      nin: '12345670003',
    });
    expect(c).toEqual({
      customerId: CUSTOMER_A.customerId,
      walletId: CUSTOMER_A.walletId,
      accountNumber: CUSTOMER_A.accountNumber,
      recordId: null,
      tagpayCustomerId: null,
      firstName: 'Ada',
      lastName: 'Sandbox',
      accountName: 'Ada Sandbox',
      isFrozen: false,
      walletStatus: 'active',
      tier: null,
    });
    expect(JSON.stringify(c)).not.toMatch(/bvn|nin|address|dateOfBirth/i);
  });

  it('a blacklisted NIN (403) is identity_refused, not merchant_inactive', async () => {
    double.on('POST', '/create/customer', {
      status: 403,
      body: fintavaError(
        403,
        'This NIN is blacklisted',
        'please contact support for assistance.',
      ),
    });
    expect((await failure(client().createCustomer(input))).kind).toBe(
      'identity_refused',
    );
  });

  it('a lost create answer is outcome_unknown (find by phone before trying again)', async () => {
    double.on('POST', '/create/customer', { status: 502, body: 'bad gateway' });
    expect((await failure(client().createCustomer(input))).kind).toBe(
      'outcome_unknown',
    );
  });

  it('validation errors keep the nested messages', async () => {
    double.on('POST', '/create/customer', {
      status: 400,
      body: fintavaValidation(
        'firstName should not be empty',
        'address should not be empty',
      ),
    });
    const e = await failure(client().createCustomer(input));
    expect(e.kind).toBe('validation');
    expect(e.messages).toEqual([
      'firstName should not be empty',
      'address should not be empty',
    ]);
  });

  it('getCustomer reads all four ids and the tier', async () => {
    double.on('GET', `/customers/${CUSTOMER_A.customerId}`, {
      status: 200,
      body: CUSTOMER_BY_ID,
    });
    const c = await client().getCustomer(CUSTOMER_A.customerId);
    expect(c).toMatchObject({
      customerId: CUSTOMER_A.customerId,
      recordId: CUSTOMER_A.recordId,
      walletId: CUSTOMER_A.walletId,
      tagpayCustomerId: CUSTOMER_A.tagpayCustomerId,
      accountNumber: CUSTOMER_A.accountNumber,
      tier: 'TIER_2',
    });
    expect(
      new Set([c.customerId, c.recordId, c.walletId, c.tagpayCustomerId]).size,
    ).toBe(4);
  });

  it('findCustomerByPhone goes from details (no wallet) to the customer by id', async () => {
    double.on('GET', '/customers/details', {
      status: 200,
      body: CUSTOMER_DETAILS,
    });
    double.on('GET', `/customers/${CUSTOMER_A.customerId}`, {
      status: 200,
      body: CUSTOMER_BY_ID,
    });
    const c = await client().findCustomerByPhone('08031230101');
    expect(double.seen[0].query).toEqual({ phone: '08031230101' });
    expect(c?.walletId).toBe(CUSTOMER_A.walletId);
    double.reset();
    double.on('GET', '/customers/details', {
      status: 404,
      body: fintavaError(404, 'Customer not found'),
    });
    expect(await client().findCustomerByPhone('08031230101')).toBeNull();
  });

  it('listCustomers reads the wallet nested in userInfo, and string page counts', async () => {
    double.on('GET', '/customers/list', { status: 200, body: CUSTOMER_LIST });
    const page = await client().listCustomers({ page: 1, take: 10 });
    expect(double.seen[0].query).toEqual({ page: '1', take: '10' });
    expect(page).toMatchObject({
      page: 1,
      take: 10,
      itemCount: 1,
      hasNextPage: false,
    });
    expect(page.items[0]).toMatchObject({
      walletId: CUSTOMER_A.walletId,
      tier: 'TIER_2',
    });
  });
});

describe('3. balances: Fintava numbers to kobo', () => {
  it('getWalletBalance', async () => {
    double.on('GET', `/customer/wallet/balance/${CUSTOMER_A.walletId}`, {
      status: 200,
      body: WALLET_BALANCE,
    });
    expect(await client().getWalletBalance(CUSTOMER_A.walletId)).toEqual({
      availableKobo: 25000,
      bookedKobo: 25000,
      tier: 'TIER_2',
    });
  });

  it('an unknown wallet (400 "Wallet not found") is not_found', async () => {
    double.on('GET', /^\/customer\/wallet\/balance\//, {
      status: 400,
      body: fintavaError(400, 'Wallet not found'),
    });
    expect((await failure(client().getWalletBalance('nope'))).kind).toBe(
      'not_found',
    );
  });

  it('getMerchantBalance carries WAWU account number', async () => {
    double.on('GET', '/merchant/balance', {
      status: 200,
      body: MERCHANT_BALANCE,
    });
    expect(await client().getMerchantBalance()).toEqual({
      availableKobo: 4965000,
      bookedKobo: 4965000,
      tier: 'TIER_3',
      accountName: 'Test Account4',
      accountNumber: MERCHANT_ACCOUNT,
    });
  });
});

describe('4. history: both shapes, string amounts, debits only', () => {
  it('getCustomerHistory reads `{ data: { data, meta } }`', async () => {
    double.on('GET', '/txn', {
      status: 200,
      body: customerHistory([
        historyRow({
          CustomerReference: 'OPS02R-W2W-002',
          amount: '50.00',
          status: 'SUCCESS',
          customer: {
            id: CUSTOMER_A.customerId,
            firstName: 'Ada',
            lastName: 'Sandbox',
            phoneNumber: '*******0101',
          },
        }),
      ]),
    });
    const page = await client().getCustomerHistory({
      customerId: CUSTOMER_A.customerId,
      take: 10,
      status: 'SUCCESS',
    });
    expect(double.seen[0].query).toEqual({
      customerId: CUSTOMER_A.customerId,
      page: '1',
      take: '10',
      status: 'SUCCESS',
    });
    expect(page.items[0]).toMatchObject({
      amountKobo: 5000,
      customerReference: 'OPS02R-W2W-002',
      entry: 'DEBIT',
      customerId: CUSTOMER_A.customerId,
    });
  });

  it('getMerchantHistory reads `{ data: [rows], meta }` and orders newest first', async () => {
    double.on('GET', '/txn/merchant', {
      status: 200,
      body: merchantHistory([
        historyRow({
          transType: 'BVNCHARGE',
          amount: '5.00',
          CustomerReference: null,
          status: 'SUCCESS',
        }),
      ]),
    });
    const page = await client().getMerchantHistory({
      startDate: '2026-10-01',
      endDate: '2026-10-03',
    });
    expect(double.seen[0].query).toMatchObject({
      order: 'DESC',
      take: '20',
      startDate: '2026-10-01',
    });
    expect(page.items[0]).toMatchObject({
      transType: 'BVNCHARGE',
      amountKobo: 500,
      customerReference: null,
    });
  });
});

describe('5 and 6. banks and names', () => {
  it('listBanks keys on code: same name, two codes, both kept', async () => {
    double.on('GET', '/banks', { status: 200, body: BANKS });
    const banks = await client().listBanks();
    expect(banks.map((b) => b.code)).toEqual(['90202', '090202', '090620']);
  });

  it('bankNameEnquiry: a match needs status true and responseCode "00"', async () => {
    double.on('GET', '/name/enquiry', { status: 200, body: NAME_ENQUIRY });
    expect(await client().bankNameEnquiry('0123456789', '000013')).toEqual({
      matched: true,
      accountName: 'SIMI MICHELLE',
      accountNumber: '0123456789',
      bankCode: '000013',
      responseCode: '00',
    });
    double.reset();
    double.on('GET', '/name/enquiry', {
      status: 200,
      body: {
        data: { status: false, account: { responseCode: '07' } },
        status: 200,
      },
    });
    expect(
      (await client().bankNameEnquiry('0123456789', '000013')).matched,
    ).toBe(false);
  });

  it('walletNameEnquiry: a wallet, and null for the leaked-JS-error 400', async () => {
    double.on('GET', '/loma-name/enquiry', { status: 200, body: LOMA_NAME });
    expect(await client().walletNameEnquiry(CUSTOMER_A.accountNumber)).toEqual({
      accountNumber: CUSTOMER_A.accountNumber,
      accountName: 'Ada Sandbox',
    });
    double.reset();
    double.on('GET', '/loma-name/enquiry', {
      status: 400,
      body: fintavaError(
        400,
        "Cannot read properties of undefined (reading 'accountName')",
      ),
    });
    expect(await client().walletNameEnquiry('1100000000')).toBeNull();
    // ...but a bad key on the same call is still an auth error, never "no such wallet".
    double.reset();
    double.on('GET', '/loma-name/enquiry', {
      status: 400,
      body: fintavaError(400, 'Invalid API key'),
    });
    expect((await failure(client().walletNameEnquiry('1100000000'))).kind).toBe(
      'auth',
    );
  });
});

describe('8. lookups: found, absent, and the 200 `{}`', () => {
  it('by our reference: found', async () => {
    double.on('GET', '/transaction/reference/MONEY06-L-1', {
      status: 200,
      body: recordByReference('MONEY06-L-1'),
    });
    const l = await client().getTransactionByReference('MONEY06-L-1');
    expect(l).toMatchObject({
      state: 'found',
      transaction: {
        customerReference: 'MONEY06-L-1',
        fintavaReference: '23f77125-eac0-4e73-bb83-8562ccdfddb9',
        amountKobo: 30000,
        status: 'SUCCESS',
      },
    });
  });

  it('404 is absent; 200 `{}` is unknown, never absent', async () => {
    double.on('GET', '/transaction/reference/GONE', {
      status: 404,
      body: fintavaError(404, 'Transaction not found!'),
    });
    double.on('GET', '/transaction/reference/OPS02R-MT-001', {
      status: 200,
      body: {},
    });
    const c = client();
    expect(await c.getTransactionByReference('GONE')).toEqual({
      state: 'absent',
    });
    expect(await c.getTransactionByReference('OPS02R-MT-001')).toEqual({
      state: 'unknown',
    });
  });

  it('by id: the full record, fees read, the embedded identity dropped; null is absent', async () => {
    double.on('GET', '/transaction/id/02271ab1-413f-45d0-905b-c6c62a16d77a', {
      status: 200,
      body: RECORD_BY_ID,
    });
    double.on('GET', '/transaction/id/00000000-0000-0000-0000-000000000000', {
      status: 200,
      body: { data: null, status: 200, message: 'successful' },
    });
    const c = client();
    const l = await c.getTransactionById(
      '02271ab1-413f-45d0-905b-c6c62a16d77a',
    );
    expect(l).toMatchObject({
      state: 'found',
      transaction: {
        tagapayTransRef: 'Aq3QKQTXsU98QZpzee6FUbT4ygffK6bxqlRG',
        platformCommKobo: null,
        lomaChargeKobo: null,
        customerId: 'a2162db5-0911-4786-8760-7b99f5d4a69a',
      },
    });
    const text = JSON.stringify(l);
    for (const leaked of [
      '22299998888',
      '33399998888',
      '08099998888',
      'MASKED',
      'lastLogin',
      '1980-01-01',
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(
      await c.getTransactionById('00000000-0000-0000-0000-000000000000'),
    ).toEqual({
      state: 'absent',
    });
  });
});

describe('9 and 10. wallet to wallet, in every direction', () => {
  const send = {
    senderAccountNumber: MERCHANT_ACCOUNT,
    receiverAccountNumber: CUSTOMER_A.accountNumber,
    amountKobo: 30000,
    customerReference: 'MONEY06-W-1',
    narration: 'WAWU to A',
  };

  it('always sends OUR CustomerReference, naira in the body', async () => {
    double.on('POST', '/transaction/wallet-to-wallet', {
      status: 200,
      body: W2W_200,
    });
    await client().walletToWallet(send);
    expect(double.seen[0].body).toEqual({
      senderAccount: MERCHANT_ACCOUNT,
      receiverAccount: CUSTOMER_A.accountNumber,
      amount: 300,
      narration: 'WAWU to A',
      CustomerReference: 'MONEY06-W-1',
    });
  });

  it('un-swaps the response reference names', async () => {
    double.on('POST', '/transaction/wallet-to-wallet', {
      status: 200,
      body: W2W_200,
    });
    const r = await client().walletToWallet(send);
    expect(r).toEqual({
      customerReference: 'MONEY06-W-1',
      fintavaReference: '23f77125-eac0-4e73-bb83-8562ccdfddb9',
      tagapayTransRef: 'Aq3QKQTXsU98QZpzee6FUbT4ygffK6bxqlRG',
      transactionId: null,
      amountKobo: 30000,
      totalKobo: 30000,
      feeKobo: 0,
      lomaChargeKobo: null,
      sourceAccountNumber: MERCHANT_ACCOUNT,
      sourceAvailableKobo: 4965500,
      sourceBookedKobo: 4965500,
    });
  });

  it('a 2xx without the transaction is not_confirmed, not a payment', async () => {
    double.on('POST', '/transaction/wallet-to-wallet', {
      status: 200,
      body: { status: 200, message: 'successful' },
    });
    const e = await failure(client().walletToWallet(send));
    expect(e.kind).toBe('not_confirmed');
    expect(e.recordMayExist).toBe(true);
  });

  it('refusals: repeat reference, frozen, insufficient, 500 ECONNRESET', async () => {
    const c = client();
    const cases = [
      [400, 'customerReference already exists', 'duplicate_reference'],
      [
        400,
        'Kindly confirm both customer accounts are active',
        'wallet_inactive',
      ],
      [
        400,
        'Insufficient balance on source wallet to complete this transfer.',
        'insufficient_funds',
      ],
      [500, 'read ECONNRESET', 'outcome_unknown'],
    ] as const;
    for (const [status, text, kind] of cases) {
      double.reset();
      double.on('POST', '/transaction/wallet-to-wallet', {
        status,
        body: fintavaError(status, text),
      });
      const e = await failure(c.walletToWallet(send));
      expect([e.kind, e.reference]).toEqual([kind, 'MONEY06-W-1']);
    }
  });

  it('refuses a bad reference or amount before sending', async () => {
    const c = client();
    expect(
      (
        await failure(
          c.walletToWallet({ ...send, customerReference: 'has space' }),
        )
      ).kind,
    ).toBe('validation');
    expect(
      (await failure(c.walletToWallet({ ...send, amountKobo: 10.5 }))).kind,
    ).toBe('validation');
    expect(
      (
        await failure(
          c.walletToWallet({
            ...send,
            receiverAccountNumber: MERCHANT_ACCOUNT,
          }),
        )
      ).kind,
    ).toBe('validation');
    expect(double.seen).toHaveLength(0);
  });
});

describe('after a lost answer: reconcile before ANY resend', () => {
  const send = {
    senderAccountNumber: MERCHANT_ACCOUNT,
    receiverAccountNumber: CUSTOMER_A.accountNumber,
    amountKobo: 1000,
    customerReference: 'MONEY06-R-1',
  };
  // Past the money timeout (30 s) plus the 10-minute safety window.
  const longAgo = new Date(Date.now() - 15 * 60_000);

  it('found SUCCESS by reference: settled, nothing sent', async () => {
    double.on('GET', '/transaction/reference/MONEY06-R-1', {
      status: 200,
      body: recordByReference('MONEY06-R-1', 'SUCCESS', '10.00'),
    });
    const out = await client().retryWalletToWallet(send, {
      sender: { kind: 'merchant' },
      attemptedAt: longAgo,
    });
    expect(out.decision.action).toBe('settled');
    expect(out.receipt).toBeNull();
    expect(double.seen.map((r) => r.method)).toEqual(['GET']);
  });

  it('absent (404) long enough ago: the same reference goes again', async () => {
    double.on('GET', '/transaction/reference/MONEY06-R-1', {
      status: 404,
      body: fintavaError(404, 'Transaction not found!'),
    });
    double.on('GET', '/txn/merchant', {
      status: 200,
      body: merchantHistory([]),
    });
    double.on('POST', '/transaction/wallet-to-wallet', {
      status: 200,
      body: W2W_200,
    });
    const out = await client().retryWalletToWallet(send, {
      sender: { kind: 'merchant' },
      attemptedAt: longAgo,
    });
    expect(out.decision).toEqual({ action: 'resend_same_reference' });
    expect(out.receipt?.customerReference).toBe('MONEY06-R-1');
    expect(double.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /transaction/reference/MONEY06-R-1',
      'GET /txn/merchant',
      'POST /transaction/wallet-to-wallet',
    ]);
    expect(
      (double.seen[2].body as { CustomerReference: string }).CustomerReference,
    ).toBe('MONEY06-R-1');
  });

  it('absent seconds after sending: wait, nothing sent', async () => {
    double.on('GET', '/txn/merchant', {
      status: 200,
      body: merchantHistory([]),
    });
    double.on('GET', '/transaction/reference/MONEY06-R-1', {
      status: 404,
      body: fintavaError(404, 'Transaction not found!'),
    });
    const out = await client().retryWalletToWallet(send, {
      sender: { kind: 'merchant' },
      attemptedAt: new Date(),
    });
    expect(out.decision).toEqual({ action: 'wait', why: 'too_soon' });
    expect(double.seen.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('`{}` then found PENDING in merchant history: wait, nothing sent', async () => {
    double.on('GET', '/transaction/reference/MONEY06-R-1', {
      status: 200,
      body: {},
    });
    double.on('GET', '/txn/merchant', {
      status: 200,
      body: merchantHistory([
        historyRow({ CustomerReference: 'OTHER', status: 'SUCCESS' }),
        historyRow({
          CustomerReference: 'MONEY06-R-1',
          status: 'PENDING',
          amount: '10.00',
        }),
      ]),
    });
    const out = await client().retryWalletToWallet(send, {
      sender: { kind: 'merchant' },
      attemptedAt: longAgo,
    });
    expect(out.decision).toEqual({ action: 'wait', why: 'pending' });
    expect(double.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /transaction/reference/MONEY06-R-1',
      'GET /txn/merchant',
    ]);
    expect(double.seen[1].query).toMatchObject({ order: 'DESC' });
    const take = Number(double.seen[1].query.take);
    expect(take).toBeGreaterThanOrEqual(60);
    expect(take).toBeLessThanOrEqual(100);
  });

  it('`{}` and not in history: unknown, wait, nothing sent', async () => {
    double.on('GET', '/transaction/reference/MONEY06-R-1', {
      status: 200,
      body: {},
    });
    double.on('GET', '/txn/merchant', {
      status: 200,
      body: merchantHistory([]),
    });
    const out = await client().retryWalletToWallet(send, {
      sender: { kind: 'merchant' },
      attemptedAt: longAgo,
    });
    expect(out.decision).toEqual({ action: 'wait', why: 'empty_lookup' });
    expect(double.seen.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('a customer sender is reconciled from the customer history', async () => {
    double.on('GET', '/transaction/reference/MONEY06-R-1', {
      status: 200,
      body: {},
    });
    double.on('GET', '/txn', {
      status: 200,
      body: customerHistory([
        historyRow({ CustomerReference: 'MONEY06-R-1', status: 'SUCCESS' }),
      ]),
    });
    const rec = await client().reconcile(
      'MONEY06-R-1',
      { kind: 'customer', customerId: CUSTOMER_A.customerId },
      longAgo,
    );
    expect(rec).toMatchObject({ state: 'found', source: 'history' });
    expect(double.seen[1].query.customerId).toBe(CUSTOMER_A.customerId);
  });

  it('Fintava unreachable during the lookup: wait, nothing sent', async () => {
    double.on('GET', '/transaction/reference/MONEY06-R-1', {
      status: 503,
      body: fintavaError(503, 'down'),
    });
    const out = await client().retryWalletToWallet(send, {
      sender: { kind: 'merchant' },
      attemptedAt: longAgo,
    });
    expect(out.decision).toEqual({ action: 'wait', why: 'unreachable' });
  });

  it('history is paged back only as far as the send', async () => {
    double.on('GET', '/transaction/reference/MONEY06-R-1', {
      status: 200,
      body: {},
    });
    double.on('GET', '/txn/merchant', (req) => ({
      status: 200,
      body: merchantHistory(
        [
          historyRow({
            CustomerReference: `P${req.query.page}`,
            createdAt: '2026-01-01T00:00:00.000Z',
          }),
        ],
        true,
      ),
    }));
    const rec = await client().reconcile(
      'MONEY06-R-1',
      { kind: 'merchant' },
      new Date('2026-10-02T10:00:00Z'),
    );
    expect(rec).toEqual({ state: 'unknown', why: 'empty_lookup' });
    expect(double.seen.filter((r) => r.path === '/txn/merchant')).toHaveLength(
      1,
    );
  });
});

describe('7. bank sends: our reference, and refusals that leave a record', () => {
  const bank = {
    sourceCustomerId: CUSTOMER_A.customerId,
    accountNumber: '0123456789',
    accountName: 'SIMI MICHELLE',
    sortCode: '000013',
    amountKobo: 10000,
    customerReference: 'MONEY06-B-1',
    narration: 'A to bank',
  };
  const merchantBank = {
    accountNumber: '0123456789',
    accountName: 'SIMI MICHELLE',
    sortCode: '000013',
    amountKobo: 10000,
    customerReference: 'MONEY06-MB-1',
  };
  const BANK_200 = {
    message: 'successful',
    status: 200,
    data: {
      amount: 100,
      reference: 'pJWh8Wu8vXxKEyjFBi5gw2LIj9zlquT5s8oP',
      customerReference: '84ebna98-7b1e-4e7d-8655-e76357102d1a',
      total: 100,
      transaction_fee: 0,
      source_customer_id: '65a00d25-678d-4acd-901c-ea99a32158f0',
      source_customer_accname: 'Example Business',
      source_customer_accno: '1000778995',
      source_customer_wallet: '1000778995',
      source_availableBalance: 2.75,
      source_bookedBalance: 2.75,
      description: 'Fund transfer between customers',
      id: '0b4cd671-6ea7-42ee-8bbc-d08baf41b019',
      lomaCharge: 7.5,
    },
  };

  it('/bank/credit takes OUR CustomerReference and the customerId as sourceId', async () => {
    double.on('POST', '/bank/credit', { status: 200, body: BANK_200 });
    const r = await client().bankTransfer(bank);
    expect(double.seen[0].body).toEqual({
      sourceId: CUSTOMER_A.customerId,
      accountNumber: '0123456789',
      accountName: 'SIMI MICHELLE',
      sortCode: '000013',
      amount: 100,
      narration: 'A to bank',
      CustomerReference: 'MONEY06-B-1',
    });
    expect(r).toMatchObject({
      customerReference: 'MONEY06-B-1',
      transactionId: '0b4cd671-6ea7-42ee-8bbc-d08baf41b019',
      lomaChargeKobo: 750,
      sourceAvailableKobo: 275,
    });
  });

  it('/bank/credit/merchant takes OUR CustomerReference', async () => {
    double.on('POST', '/bank/credit/merchant', { status: 200, body: BANK_200 });
    await client().merchantBankTransfer(merchantBank);
    expect(double.seen[0].body).toMatchObject({
      CustomerReference: 'MONEY06-MB-1',
      amount: 100,
    });
  });

  it('"Unable to find customers" is payouts_blocked, and a record may exist', async () => {
    double.on('POST', '/bank/credit', {
      status: 400,
      body: fintavaError(400, 'Unable to find customers'),
    });
    double.on('POST', '/bank/credit/merchant', {
      status: 400,
      body: fintavaError(400, 'Unable to find customers'),
    });
    for (const p of [
      client().bankTransfer(bank),
      client().merchantBankTransfer(merchantBank),
    ]) {
      const e = await failure(p);
      expect([e.kind, e.recordMayExist]).toEqual(['payouts_blocked', true]);
    }
  });

  it('the record id as sourceId is a 404 not_found that may still leave a record', async () => {
    double.on('POST', '/bank/credit', {
      status: 404,
      body: fintavaError(404, 'No wallet exists for the customer'),
    });
    const e = await failure(
      client().bankTransfer({ ...bank, sourceCustomerId: CUSTOMER_A.recordId }),
    );
    expect([e.kind, e.recordMayExist]).toEqual(['not_found', true]);
  });

  it('a validation refusal leaves nothing', async () => {
    double.on('POST', '/bank/credit', {
      status: 400,
      body: fintavaValidation('sourceId must be a UUID'),
    });
    const e = await failure(client().bankTransfer(bank));
    expect([e.kind, e.recordMayExist]).toEqual(['validation', false]);
  });

  it('a bank retry must carry a NEW reference', async () => {
    const e = await failure(
      client().retryBankTransfer(bank, {
        previousReference: 'MONEY06-B-1',
        attemptedAt: new Date(Date.now() - 600_000),
      }),
    );
    expect(e.kind).toBe('validation');
    expect(double.seen).toHaveLength(0);
  });

  it('the old send PENDING (`{}` by reference, PENDING in history): never sent again', async () => {
    double.on('GET', '/transaction/reference/MONEY06-MB-1', {
      status: 200,
      body: {},
    });
    double.on('GET', '/txn/merchant', {
      status: 200,
      body: merchantHistory([
        historyRow({ CustomerReference: 'MONEY06-MB-1', status: 'PENDING' }),
      ]),
    });
    const out = await client().retryMerchantBankTransfer(
      { ...merchantBank, customerReference: 'MONEY06-MB-2' },
      {
        previousReference: 'MONEY06-MB-1',
        attemptedAt: new Date(Date.now() - 600_000),
      },
    );
    expect(out).toEqual({
      decision: { action: 'wait', why: 'pending' },
      receipt: null,
    });
    expect(double.seen.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('the old send FAILURE: sent again under the new reference', async () => {
    double.on('GET', '/transaction/reference/MONEY06-B-1', {
      status: 200,
      body: recordByReference('MONEY06-B-1', 'FAILURE', '100.00'),
    });
    double.on('POST', '/bank/credit', { status: 200, body: BANK_200 });
    const out = await client().retryBankTransfer(
      { ...bank, customerReference: 'MONEY06-B-2' },
      {
        previousReference: 'MONEY06-B-1',
        attemptedAt: new Date(Date.now() - 600_000),
      },
    );
    expect(out.decision.action).toBe('resend_new_reference');
    expect(out.receipt?.customerReference).toBe('MONEY06-B-2');
    expect(
      (double.seen[1].body as { CustomerReference: string }).CustomerReference,
    ).toBe('MONEY06-B-2');
  });
});

describe('12. freeze and unfreeze', () => {
  it('freeze sends the reason; the embedded customer and BVN are dropped', async () => {
    double.on('PATCH', `/customer/wallet/${CUSTOMER_A.walletId}/freeze`, {
      status: 200,
      body: FREEZE_200,
    });
    const w = await client().freezeWallet(CUSTOMER_A.walletId, 'fraud hold');
    expect(double.seen[0].body).toEqual({ reason: 'fraud hold' });
    expect(w).toEqual({
      walletId: CUSTOMER_A.walletId,
      accountNumber: CUSTOMER_A.accountNumber,
      isFrozen: true,
      walletStatus: 'active',
      tier: 'TIER_2',
    });
    expect(JSON.stringify(w)).not.toMatch(/22299990000|08011110000/);
  });

  it('unfreeze sends no body', async () => {
    double.on('PATCH', `/customer/wallet/${CUSTOMER_A.walletId}/unfreeze`, {
      status: 200,
      body: { ...FREEZE_200, data: { ...FREEZE_200.data, isFrozen: false } },
    });
    const w = await client().unfreezeWallet(CUSTOMER_A.walletId);
    expect(double.seen[0].body).toBeUndefined();
    expect(w.isFrozen).toBe(false);
  });

  it('a freeze without a reason is refused before sending', async () => {
    expect(
      (await failure(client().freezeWallet(CUSTOMER_A.walletId, ' '))).kind,
    ).toBe('validation');
  });
});

describe('11. bills: lists, preview, purchases', () => {
  it('listDiscos reads string limits per disco and availability', async () => {
    double.on('GET', '/billing/discos', { status: 200, body: DISCOS });
    const d = await client().listDiscos();
    expect(d).toEqual([
      {
        code: 'AEDC',
        description: 'AEDC Prepaid',
        minimumKobo: 50000,
        maximumKobo: 1000000000,
        available: true,
      },
      {
        code: 'Ibadan_Disco_Prepaid',
        description: 'Ibadan Disco Prepaid',
        minimumKobo: 0,
        maximumKobo: 100000000,
        available: true,
      },
      {
        code: 'Kaduna_Electricity_Disco_Postpaid',
        description: 'Kaduna Electricity Disco Postpaid',
        minimumKobo: 90000,
        maximumKobo: 500000000,
        available: false,
      },
    ]);
  });

  it('previewMeter: null for the bare "Http Exception"', async () => {
    double.on('POST', '/billing/preview-meter', {
      status: 400,
      body: fintavaError(400, 'Http Exception'),
    });
    expect(
      await client().previewMeter({
        meterNumber: '1111111111111',
        disco: 'AEDC',
        planType: 'prepaid',
      }),
    ).toBeNull();
    expect(double.seen[0].body).toEqual({
      meternumber: '1111111111111',
      disco: 'AEDC',
      planType: 'prepaid',
    });
  });

  it('listDataBundles asks for ETISALAT when the network is 9mobile', async () => {
    double.on('GET', /^\/billing\/data-bundles\//, {
      status: 200,
      body: DATA_BUNDLES,
    });
    const b = await client().listDataBundles('9MOBILE');
    expect(double.seen[0].path).toBe('/billing/data-bundles/ETISALAT');
    expect(b[0]).toEqual({
      code: '30',
      title: 'MTN D-MFIN-5-307 for DataPlan 100MB Daily',
      priceKobo: 10000,
      validity: 'DataPlan 100MB Daily',
    });
  });

  it('cable providers and plans', async () => {
    double.on('GET', '/cable-service-name', {
      status: 200,
      body: CABLE_PROVIDERS,
    });
    double.on('GET', '/cable-service-name/GOTV', {
      status: 200,
      body: CABLE_PLANS,
    });
    const c = client();
    expect(await c.listCableProviders()).toEqual(['GOTV', 'DSTV']);
    expect(await c.listCablePlans('GOTV')).toEqual([
      {
        code: '78',
        title: 'GOtv Max',
        provider: 'GOTV',
        priceKobo: 495000,
        available: true,
      },
    ]);
  });

  it('cable 201 "service not currently available" is not_confirmed, never paid', async () => {
    double.on('POST', '/billing/cable-subscription', {
      status: 201,
      body: CABLE_201_UNAVAILABLE,
    });
    const e = await failure(
      client().buyCable({
        provider: 'DSTV',
        smartcardNumber: '1212121212',
        planCode: '97',
      }),
    );
    expect(e.kind).toBe('not_confirmed');
    expect(e.messages).toEqual(['service not currently available']);
    expect(double.seen[0].body).toEqual({
      smartcard_number: '1212121212',
      tv_network: 'DSTV',
      service_code: '97',
    });
  });

  it('airtime: whole naira, ₦100 minimum checked before sending', async () => {
    const c = client();
    expect(
      (
        await failure(
          c.buyAirtime({
            network: 'MTN',
            amountKobo: 5000,
            phone: '08031230101',
          }),
        )
      ).kind,
    ).toBe('below_minimum');
    expect(
      (
        await failure(
          c.buyAirtime({
            network: 'MTN',
            amountKobo: 10050,
            phone: '08031230101',
          }),
        )
      ).kind,
    ).toBe('validation');
    expect(double.seen).toHaveLength(0);
    double.on('POST', '/billing/airtime', {
      status: 400,
      body: fintavaError(400, 'Unable to find customers'),
    });
    expect(
      (
        await failure(
          c.buyAirtime({
            network: 'MTN',
            amountKobo: 10000,
            phone: '+2348031230101',
          }),
        )
      ).kind,
    ).toBe('payouts_blocked');
    expect(double.seen[0].body).toEqual({
      vtu_network: 'MTN',
      vtu_amount: 100,
      vtu_number: '08031230101',
    });
  });

  it('data and electricity send the documented bodies; a purchase counts only with data', async () => {
    double.on('POST', '/billing/data-bundle', {
      status: 200,
      body: {
        status: 200,
        message: 'successful',
        data: { id: 'txn-1', reference: 'r-1', amount: '100.00' },
      },
    });
    double.on('POST', '/billing/electricity', {
      status: 400,
      body: fintavaError(400, 'Unable to find customers'),
    });
    const c = client();
    const r = await c.buyDataBundle({
      network: 'MTN',
      bundleCode: '30',
      phone: '08031230101',
    });
    expect(r).toMatchObject({
      transactionId: 'txn-1',
      fintavaReference: 'r-1',
      amountKobo: 10000,
    });
    expect(double.seen[0].body).toEqual({
      vtu_network: 'MTN',
      data_code: '30',
      vtu_number: '08031230101',
    });
    const e = await failure(
      c.buyElectricity({
        meterNumber: '1111111111111',
        disco: 'AEDC',
        planType: 'prepaid',
        amountKobo: 50000,
      }),
    );
    expect(e.kind).toBe('payouts_blocked');
    expect(double.seen[1].body).toEqual({
      meternumber: '1111111111111',
      disco: 'AEDC',
      amount: 500,
      planType: 'prepaid',
    });
  });
});

describe('round 2: absent means only Fintava saying so, and never too soon', () => {
  const merchantBank = {
    accountNumber: '0123456789',
    accountName: 'SIMI MICHELLE',
    sortCode: '000013',
    amountKobo: 10000,
    customerReference: 'MONEY06-V-B-2',
  };
  const fifteenMinutesAgo = () => new Date(Date.now() - 15 * 60_000);
  const posts = () => double.seen.filter((r) => r.method === 'POST').length;

  const notFintava404s: Array<[string, unknown]> = [
    [
      'a framework route 404',
      {
        statusCode: 404,
        message: 'Cannot GET /api/dev/transaction/reference/MONEY06-V-B-1',
        error: 'Not Found',
      },
    ],
    ['an empty body', ''],
    ['an HTML gateway page', '<html><body>404 Not Found</body></html>'],
    [
      'a JSON 404 with another message',
      fintavaError(404, 'Customer not found'),
    ],
  ];

  it.each(notFintava404s)(
    'the lookup answering %s is outcome_unknown, never absent',
    async (_name, body) => {
      double.on('GET', /^\/transaction\/reference\//, { status: 404, body });
      const e = await failure(
        client().getTransactionByReference('MONEY06-V-B-1'),
      );
      expect([e.kind, e.recordMayExist]).toEqual(['outcome_unknown', true]);
    },
  );

  it.each(notFintava404s)(
    'a bank retry after the lookup answers %s waits and sends nothing',
    async (_name, body) => {
      double.on('GET', /^\/transaction\/reference\//, { status: 404, body });
      double.on('GET', '/txn/merchant', {
        status: 200,
        body: merchantHistory([]),
      });
      double.on('POST', '/bank/credit/merchant', {
        status: 200,
        body: W2W_200,
      });
      const out = await client().retryMerchantBankTransfer(merchantBank, {
        previousReference: 'MONEY06-V-B-1',
        attemptedAt: fifteenMinutesAgo(),
      });
      expect(out).toEqual({
        decision: { action: 'wait', why: 'unrecognised' },
        receipt: null,
      });
      expect(posts()).toBe(0);
    },
  );

  it('the lookup by id answering a non-Fintava 404 is outcome_unknown too', async () => {
    double.on('GET', /^\/transaction\/id\//, { status: 404, body: '' });
    expect((await failure(client().getTransactionById('x'))).kind).toBe(
      'outcome_unknown',
    );
  });

  it('only `404 "Transaction not found!"` is absent', async () => {
    double.on('GET', /^\/transaction\/reference\//, {
      status: 404,
      body: fintavaError(404, 'Transaction not found!'),
    });
    expect(await client().getTransactionByReference('MONEY06-V-B-1')).toEqual({
      state: 'absent',
    });
  });

  it('a 404 is not enough while history still shows the send: settled, nothing sent', async () => {
    double.on('GET', /^\/transaction\/reference\//, {
      status: 404,
      body: fintavaError(404, 'Transaction not found!'),
    });
    double.on('GET', '/txn/merchant', {
      status: 200,
      body: merchantHistory([
        historyRow({ CustomerReference: 'MONEY06-V-B-1', status: 'SUCCESS' }),
      ]),
    });
    const out = await client().retryMerchantBankTransfer(merchantBank, {
      previousReference: 'MONEY06-V-B-1',
      attemptedAt: fifteenMinutesAgo(),
    });
    expect(out.decision.action).toBe('settled');
    expect(posts()).toBe(0);
  });

  it('a 404 with history unreachable: wait, nothing sent', async () => {
    double.on('GET', /^\/transaction\/reference\//, {
      status: 404,
      body: fintavaError(404, 'Transaction not found!'),
    });
    double.on('GET', '/txn/merchant', { status: 502, body: 'bad gateway' });
    const out = await client().retryMerchantBankTransfer(merchantBank, {
      previousReference: 'MONEY06-V-B-1',
      attemptedAt: fifteenMinutesAgo(),
    });
    expect(out.decision).toEqual({ action: 'wait', why: 'unreachable' });
    expect(posts()).toBe(0);
  });

  it("the verifier's case: a bank send done at 600 ms, timeout 200 ms, retry at once: sent once", async () => {
    const c = client({ FINTAVA_MONEY_TIMEOUT_MS: '200' });
    // Fintava finishes the first send after the client gave up; until then
    // the lookup says not found and history has no row.
    let landed = false;
    double.on('POST', '/bank/credit/merchant', () => {
      setTimeout(() => {
        landed = true;
      }, 600);
      return { status: 200, body: W2W_200, delayMs: 600 };
    });
    double.on('GET', /^\/transaction\/reference\//, () =>
      landed
        ? {
            status: 200,
            body: recordByReference('MONEY06-V-B-1', 'SUCCESS', '100.00'),
          }
        : { status: 404, body: fintavaError(404, 'Transaction not found!') },
    );
    double.on('GET', '/txn/merchant', {
      status: 200,
      body: merchantHistory([]),
    });

    const attemptedAt = new Date();
    const first = await failure(
      c.merchantBankTransfer({
        ...merchantBank,
        customerReference: 'MONEY06-V-B-1',
      }),
    );
    expect(first.kind).toBe('outcome_unknown');
    const out = await c.retryMerchantBankTransfer(merchantBank, {
      previousReference: 'MONEY06-V-B-1',
      attemptedAt,
    });
    expect(out).toEqual({
      decision: { action: 'wait', why: 'too_soon' },
      receipt: null,
    });
    await new Promise((r) => setTimeout(r, 700));
    expect(landed).toBe(true);
    expect(
      double.seen.filter((r) => r.path === '/bank/credit/merchant'),
    ).toHaveLength(1);
    // And once it has landed, a later retry finds it: settled, still one send.
    const later = await c.retryMerchantBankTransfer(merchantBank, {
      previousReference: 'MONEY06-V-B-1',
      attemptedAt: fifteenMinutesAgo(),
    });
    expect(later.decision.action).toBe('settled');
    expect(
      double.seen.filter((r) => r.path === '/bank/credit/merchant'),
    ).toHaveLength(1);
  });

  it('the same for wallet to wallet: retry at once after a timeout never resends', async () => {
    const c = client({ FINTAVA_MONEY_TIMEOUT_MS: '200' });
    double.on('POST', '/transaction/wallet-to-wallet', {
      status: 200,
      body: W2W_200,
      delayMs: 600,
    });
    double.on('GET', /^\/transaction\/reference\//, {
      status: 404,
      body: fintavaError(404, 'Transaction not found!'),
    });
    double.on('GET', '/txn/merchant', {
      status: 200,
      body: merchantHistory([]),
    });
    const input = {
      senderAccountNumber: MERCHANT_ACCOUNT,
      receiverAccountNumber: CUSTOMER_A.accountNumber,
      amountKobo: 1000,
      customerReference: 'MONEY06-V-W-1',
    };
    const attemptedAt = new Date();
    expect((await failure(c.walletToWallet(input))).kind).toBe(
      'outcome_unknown',
    );
    const out = await c.retryWalletToWallet(input, {
      sender: { kind: 'merchant' },
      attemptedAt,
    });
    expect(out.decision).toEqual({ action: 'wait', why: 'too_soon' });
    expect(double.seen.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('a repeated reference means the send exists: unknown outcome, never a plain failure', async () => {
    double.on('POST', '/transaction/wallet-to-wallet', {
      status: 400,
      body: fintavaError(400, 'customerReference already exists'),
    });
    const e = await failure(
      client().walletToWallet({
        senderAccountNumber: MERCHANT_ACCOUNT,
        receiverAccountNumber: CUSTOMER_A.accountNumber,
        amountKobo: 1000,
        customerReference: 'MONEY06-V-W-2',
      }),
    );
    expect([e.kind, e.recordMayExist, e.reference]).toEqual([
      'duplicate_reference',
      true,
      'MONEY06-V-W-2',
    ]);
    const body = e.toHttpException().getResponse() as {
      message: string;
      reason: { code: string };
    };
    expect(body.reason.code).toBe('provider_unreachable');
    expect(body.message).toMatch(/still confirming/i);
    expect(body.message).not.toMatch(/not available/i);
  });
});
