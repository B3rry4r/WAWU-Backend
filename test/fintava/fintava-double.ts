import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';

/**
 * A local HTTP stand-in for Fintava, for the MONEY-06 contract tests. It
 * answers with the bodies the real sandbox sent (mobile repo
 * `docs/fintava/sandbox/`, masked there and here), so the client is tested
 * over a real socket: headers, query strings, bodies, status codes and
 * timeouts as `fetch` sees them. Nothing here reaches the internet.
 */

export interface SeenRequest {
  method: string;
  /** Path after `/api/dev`, without the query. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface CannedAnswer {
  status: number;
  /** An object is sent as JSON; a string is sent as it is. */
  body?: unknown;
  /** Wait this long before answering (to trip the client's timeout). */
  delayMs?: number;
  /** Close the socket without answering. */
  hangUp?: boolean;
}

type Handler = (req: SeenRequest) => CannedAnswer;

export class FintavaDouble {
  readonly seen: SeenRequest[] = [];
  private routes: Array<{
    method: string;
    path: string | RegExp;
    handler: Handler;
  }> = [];
  private server: Server | null = null;
  private port = 0;

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/api/dev`;
  }

  /** Answer `method path` (exact, or a pattern) with `answer`. Later wins. */
  on(
    method: string,
    path: string | RegExp,
    answer: CannedAnswer | Handler,
  ): this {
    const handler = typeof answer === 'function' ? answer : () => answer;
    this.routes.unshift({ method, path, handler });
    return this;
  }

  reset(): void {
    this.routes = [];
    this.seen.length = 0;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then((answer) => {
        const send = () => {
          if (answer.hangUp) {
            req.socket.destroy();
            return;
          }
          const text =
            typeof answer.body === 'string'
              ? answer.body
              : answer.body === undefined
                ? ''
                : JSON.stringify(answer.body);
          res.writeHead(answer.status, {
            'content-type': 'application/json; charset=utf-8',
          });
          res.end(text);
        };
        if (answer.delayMs) setTimeout(send, answer.delayMs);
        else send();
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', () => resolve()),
    );
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage): Promise<CannedAnswer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const seen: SeenRequest = {
      method: req.method ?? 'GET',
      path: url.pathname.replace(/^\/api\/dev/, ''),
      query: Object.fromEntries(url.searchParams.entries()),
      headers: req.headers,
      body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
    };
    this.seen.push(seen);
    const route = this.routes.find(
      (r) =>
        r.method === seen.method &&
        (typeof r.path === 'string'
          ? r.path === seen.path
          : r.path.test(seen.path)),
    );
    if (!route) {
      return {
        status: 404,
        body: { status: 404, message: ['Cannot route this in the double'] },
      };
    }
    return route.handler(seen);
  }
}

/** A ConfigService that reads only what it is given (never process.env). */
export function fintavaConfig(values: Record<string, string>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

/** Fintava's business-error body: `message` is always an array. */
export function fintavaError(status: number, ...message: string[]) {
  return {
    status,
    timestamp: '2026-10-02T09:40:42.500Z',
    message,
    path: '/api/dev/somewhere?bvn=*******8901',
  };
}

/** Fintava's validation body: the NestJS object nested inside `message`. */
export function fintavaValidation(...message: string[]) {
  return {
    status: 400,
    timestamp: '2026-10-02T09:40:59.558Z',
    message: { statusCode: 400, message, error: 'Bad Request' },
    path: '/api/dev/somewhere',
  };
}

// ---------------------------------------------------------------------------
// Bodies the sandbox really sent (OPS-02 re-run, 2 Oct 2026), masked.
// ---------------------------------------------------------------------------

export const CUSTOMER_A = {
  customerId: '4e8409cf-1234-40f7-963a-5c212c7a9836',
  recordId: 'a4d75fbd-0262-44b0-873c-022fbf309d7b',
  walletId: '3b84eae9-f1d5-4c7f-b5b7-7dfc52185cf7',
  tagpayCustomerId: 'aec1ceef-e774-4427-9456-00b585fe8999',
  accountNumber: '1154079370',
};
export const MERCHANT_ACCOUNT = '1102038668';

/** `sandbox/07-`: create answers 201, no tier, `nin: null`. */
export const CREATE_201 = {
  data: {
    userInfo: {
      firstName: 'Ada',
      lastName: 'Sandbox',
      phoneNumber: '*******0101',
      roles: ['USER'],
      userType: 'CUSTOMER',
      address: '1 Test Street, Ikeja, Lagos',
      bvn: '*******8901',
      dateOfBirth: '1992-10-04',
      nin: null,
      id: CUSTOMER_A.customerId,
      createdAt: '2026-10-02T09:40:03.904Z',
      updatedAt: '2026-10-02T09:40:03.904Z',
      twoFA: false,
    },
    wallet: {
      id: CUSTOMER_A.walletId,
      accountNumber: CUSTOMER_A.accountNumber,
      accountName: 'Ada Sandbox',
      isFrozen: false,
      status: 'active',
      fundMethod: 'STATIC_FUND',
    },
  },
  status: 201,
  message: 'User created successfully',
};

const WALLET_A_READ = {
  id: CUSTOMER_A.walletId,
  createdAt: '2026-10-02T09:40:03.904Z',
  updatedAt: '2026-10-02T09:40:03.904Z',
  merchant: 'ae4de060-0058-4f5b-a63c-aabe94b9b2c0',
  accountNumber: CUSTOMER_A.accountNumber,
  accountName: 'Ada Sandbox',
  isFrozen: false,
  status: 'active',
  fundMethod: 'STATIC_FUND',
  tagpayCustomerId: CUSTOMER_A.tagpayCustomerId,
  tagpayWalletId: CUSTOMER_A.accountNumber,
  currency: 'NGN',
  serviceProvider: 'loma',
  tier: 'TIER_2',
};

const USER_A = {
  id: CUSTOMER_A.customerId,
  createdAt: '2026-10-02T09:40:03.904Z',
  updatedAt: '2026-10-02T09:40:03.904Z',
  firstName: 'Ada',
  lastName: 'Sandbox',
  phoneNumber: '*******0101',
  bvn: '*******8901',
  dateOfBirth: '1992-10-04',
  address: '1 Test Street, Ikeja, Lagos',
  roles: ['USER'],
  userType: 'CUSTOMER',
  nin: null,
  twoFA: false,
};

/** `sandbox/07-`: `GET /customers/{customerId}`, the wallet beside userInfo. */
export const CUSTOMER_BY_ID = {
  data: {
    id: CUSTOMER_A.recordId,
    createdAt: '2026-10-02T09:40:03.904Z',
    updatedAt: '2026-10-02T09:40:03.904Z',
    phone: '*******0101',
    email: '***@example.com',
    customerType: 'INDIVIDUAL',
    approvalStatus: 'PENDING',
    kycComplianceIndicator: 'NOT_STARTED',
    userInfo: USER_A,
    wallet: WALLET_A_READ,
  },
  status: 200,
  message: 'Customer record fetched',
};

/** `sandbox/07-`: the list nests the wallet inside userInfo. */
export const CUSTOMER_LIST = {
  data: [
    {
      id: CUSTOMER_A.recordId,
      phone: '*******0101',
      customerType: 'INDIVIDUAL',
      approvalStatus: 'PENDING',
      userInfo: { ...USER_A, wallet: WALLET_A_READ },
    },
  ],
  meta: {
    page: '1',
    take: '10',
    itemCount: 1,
    pageCount: 1,
    hasPreviousPage: false,
    hasNextPage: false,
  },
  message: 'Merchant customers list fetched',
  status: 200,
};

/** `sandbox/07-`: details by phone has no wallet. */
export const CUSTOMER_DETAILS = {
  data: {
    id: CUSTOMER_A.recordId,
    phone: '*******0101',
    userInfo: { ...USER_A, auth: null },
  },
  status: 200,
  message: 'Customer record fetched',
};

/** `sandbox/08-`. Balances are numbers. */
export const WALLET_BALANCE = {
  data: {
    balance: { bookedBalance: 250, availableBalance: 250 },
    tier: 'TIER_2',
  },
  status: 200,
  message: 'Wallet details fetched',
};

/** `sandbox/22-`. */
export const MERCHANT_BALANCE = {
  data: {
    accountName: 'Test Account4',
    accountNumber: MERCHANT_ACCOUNT,
    balance: { bookedBalance: 49650, availableBalance: 49650 },
    tier: 'TIER_3',
  },
  status: 200,
  message: 'successful',
};

/** `sandbox/13-`: the transfer response, with its reference names swapped. */
export const W2W_200 = {
  data: {
    amount: 300,
    reference: 'Aq3QKQTXsU98QZpzee6FUbT4ygffK6bxqlRG',
    customerReference: '23f77125-eac0-4e73-bb83-8562ccdfddb9',
    total: 300,
    transaction_fee: 0,
    source_customer_id: '08c19688-031c-407f-936d-ff8901be6d83',
    source_customer_accname: 'Test Account4',
    source_customer_accno: MERCHANT_ACCOUNT,
    source_customer_wallet: MERCHANT_ACCOUNT,
    source_availableBalance: 49655,
    source_bookedBalance: 49655,
    description: 'Fund transfer between customers',
  },
  status: 200,
  message: 'successful',
};

/** `sandbox/11-`: the record by our reference. */
export function recordByReference(
  ourReference: string,
  status = 'SUCCESS',
  amount = '300.00',
) {
  return {
    data: {
      id: '02271ab1-413f-45d0-905b-c6c62a16d77a',
      createdAt: '2026-10-02T09:40:36.779Z',
      updatedAt: '2026-10-02T09:40:36.792Z',
      amount,
      amountPayable: null,
      transType: 'AATRANSFER',
      entry: 'DEBIT',
      reference: '23f77125-eac0-4e73-bb83-8562ccdfddb9',
      CustomerReference: ourReference,
      narration: 'OPS-02 rerun WAWU to A',
      currency: 'NGN',
      TransRef: null,
      status,
      recipientDetails: 'Ada Sandbox 1154079370',
      senderDetails: 'Test Account4 1102038668',
      senderBank: 'Loma Bank',
      receiverBank: 'Loma Bank',
      sessionId: '090620261002094036531865681434',
      accountProvider: 'loma',
    },
    status: 200,
    message: 'successful',
  };
}

/** `sandbox/12-`: by id, with the merchant administrator's identity embedded. */
export const RECORD_BY_ID = {
  data: {
    ...recordByReference('OPS02R-W2W-001').data,
    source: 'Test Account4 1102038668',
    destination: '1154079370',
    platformComm: null,
    merchantComm: null,
    lomaCharge: null,
    tagapayTransRef: 'Aq3QKQTXsU98QZpzee6FUbT4ygffK6bxqlRG',
    metertoken: null,
    meternumber: null,
    discoRef: null,
    customer: {
      id: 'a2162db5-0911-4786-8760-7b99f5d4a69a',
      firstName: 'MASKEDFIRST',
      lastName: 'MASKEDLAST',
      phoneNumber: '08099998888',
      bvn: '22299998888',
      nin: '33399998888',
      dateOfBirth: '1980-01-01',
      address: 'MASKED ADDRESS',
      auth: { lastLogin: '2026-10-02T08:24:09.384Z', mode: 'SANDBOX' },
    },
  },
  status: 200,
  message: 'successful',
};

/** One `/txn` or `/txn/merchant` row. */
export function historyRow(over: Record<string, unknown>) {
  return {
    id: '55788ec8-13f3-479c-a994-5e78e741887b',
    createdAt: '2026-10-02T09:41:37.284Z',
    updatedAt: '2026-10-02T09:41:37.284Z',
    amount: '100.00',
    transType: 'AATRANSFER',
    entry: 'DEBIT',
    reference: '6c3dd7c2-ced0-4119-bdb0-1e44a080c57a',
    CustomerReference: 'OPS02R-MT-001',
    source: 'undefined ae4de060-0058-4f5b-a63c-aabe94b9b2c0',
    destination: 'SIMI MICHELLE (0123456789)',
    narration: 'OPS-02 rerun merchant to bank',
    status: 'PENDING',
    recipientDetails: 'SIMI MICHELLE (0123456789)',
    senderDetails: 'Test Account4',
    senderBank: 'Loma Bank',
    receiverBank: 'GTBANK PLC',
    provider: null,
    sessionId: '000013261002094137685648997507',
    accountProvider: 'loma',
    customer: {
      id: 'a2162db5-0911-4786-8760-7b99f5d4a69a',
      firstName: '***',
      lastName: '***',
      phoneNumber: '***',
    },
    ...over,
  };
}

const META = (n: number, take = 100, hasNextPage = false) => ({
  page: '1',
  take: String(take),
  itemCount: n,
  pageCount: 1,
  hasPreviousPage: false,
  hasNextPage,
});

/** `sandbox/10-`: `{ data: [rows], meta }`, no status or message. */
export function merchantHistory(rows: unknown[], hasNextPage = false) {
  return { data: rows, meta: META(rows.length, 100, hasNextPage) };
}

/** `sandbox/09-`: `{ data: { data: [rows], meta }, status, message }`. */
export function customerHistory(rows: unknown[]) {
  return {
    data: { data: rows, meta: META(rows.length) },
    status: 200,
    message: 'Customer transactions fetched',
  };
}

/** `sandbox/15-`: the freeze answer embeds the customer, BVN included. */
export const FREEZE_200 = {
  data: {
    ...WALLET_A_READ,
    isFrozen: true,
    customer: {
      ...USER_A,
      bvn: '22299990000',
      phoneNumber: '08011110000',
      auth: null,
    },
  },
  status: 200,
  message: 'Wallet frozen successfully',
};

/** `sandbox/02-`. */
export const NAME_ENQUIRY = {
  data: {
    status: true,
    account: {
      bankCode: '000013',
      accountName: 'SIMI MICHELLE',
      accountNumber: '0123456789',
      responseCode: '00',
    },
  },
  status: 200,
  message: 'Bank details search completed',
};

/** `sandbox/03-`. */
export const LOMA_NAME = {
  data: { accountNumber: CUSTOMER_A.accountNumber, accountName: 'Ada Sandbox' },
  status: 200,
  message: 'Account number search completed',
};

/** `sandbox/01-`: two rows share a name with different codes. */
export const BANKS = {
  status: 200,
  message: 'bank lists fetched successfully',
  data: [
    {
      id: 'a',
      createdAt: 'x',
      updatedAt: 'x',
      code: '90202',
      name: 'ACCELEREX NETWORK LIMITED',
    },
    {
      id: 'b',
      createdAt: 'x',
      updatedAt: 'x',
      code: '090202',
      name: 'ACCELEREX NETWORK LIMITED',
    },
    {
      id: 'c',
      createdAt: 'x',
      updatedAt: 'x',
      code: '090620',
      name: 'LOMA BANK',
    },
  ],
};

/** `sandbox/16-`. */
export const DISCOS = {
  data: [
    {
      id: '1',
      code: 'AEDC',
      description: 'AEDC Prepaid',
      minimum_value: '500',
      maximum_value: '10000000',
      is_available: 'Yes',
    },
    {
      id: '2',
      code: 'Ibadan_Disco_Prepaid',
      description: 'Ibadan Disco Prepaid',
      minimum_value: '0',
      maximum_value: '1000000',
      is_available: 'Yes',
    },
    {
      id: '3',
      code: 'Kaduna_Electricity_Disco_Postpaid',
      description: 'Kaduna Electricity Disco Postpaid',
      minimum_value: '900',
      maximum_value: '5000000',
      is_available: 'No',
    },
  ],
  status: 200,
  message: 'Discos records fetched',
};

/** `sandbox/20-`. */
export const DATA_BUNDLES = {
  data: [
    {
      id: 'x',
      code: '30',
      title: 'MTN D-MFIN-5-307 for DataPlan 100MB Daily',
      price: '100',
      validity: 'DataPlan 100MB Daily',
    },
  ],
  status: 200,
  message: 'Provider bundles fetched',
};

/** `sandbox/21-`. */
export const CABLE_PROVIDERS = {
  data: [
    { id: '1', name: 'GOTV' },
    { id: '2', name: 'DSTV' },
  ],
  status: 200,
  message: 'successful',
};
export const CABLE_PLANS = {
  data: [
    {
      id: 'p',
      title: 'GOtv Max',
      network: 'GOTV',
      price: '4950',
      code: '78',
      available: 'Yes',
      allowance: 'GOTVMAX',
    },
  ],
  status: 200,
  message: 'Cable subscriptions fetched',
};

/** `sandbox/21-`: a failed purchase inside a 2xx. */
export const CABLE_201_UNAVAILABLE = {
  status: 200,
  message: 'service not currently available',
};

/** `reference/verify-bvn.md`: the documented success (never seen in the sandbox). */
export const BVN_200 = {
  data: {
    customer: '8b619eb6-9909-4727-8258-f7507e20637d',
    bvn: '12345678901',
    first_name: 'Ada',
    middle_name: 'B',
    last_name: 'Sandbox',
    date_of_birth: '1992-10-04',
    phone_number1: '09012345678',
    gender: 'Female',
    image: 'aGVsbG8=',
  },
};
