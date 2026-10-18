#!/usr/bin/env node
// A local stand-in for Nuvion, for the local test stack (STACK-NUV). Dev tooling only.
//
// scripts/dev/stack.sh starts it on one of the stack's own ports and points the Hub at it
// (WALLET_PROVIDER=nuvion). It answers the routes the Hub's Nuvion adapter calls (src/nuvion/areas/),
// with the data shapes of the in-process test double (test/nuvion/*-standin.ts, which are Nuvion's own
// documented examples), and sends the webhooks the Hub expects (src/nuvion/webhook/), signed the way the
// Hub verifies them: HMAC-SHA256 of "<x-nuvion-event-timestamp>.<raw body>" with the stack's test secret.
//
// It reaches nothing but the Hub's own webhook URL on this machine. No real Nuvion host is ever called.
//
// What it does by itself, so a Hub on this stack can run end to end:
//   entity created (POST /individual-entities) -> documents -> submission (POST /onboarding-submissions)
//   -> approved after STANDIN_APPROVE_MS (entities.updated) -> the Hub opens the naira account
//   (POST /accounts, accounts.created) -> the Hub asks for its details (POST /account-details,
//   account_details.created) -> active with a ten-digit number after STANDIN_DETAILS_MS (account_details.updated).
//   Transfers (book transfers to a nuvion_ban, bank sends to a payment detail) are accepted as pending,
//   debit the payer at once and settle after STANDIN_SETTLE_MS (outflows.completed).
//   GET /accounts/{id}/statements (FIX-67) answers the month statement of an account, built from the transfers
//   above: every move appears once on each account it touched (see "statements" below).
//   A bank send that is reversed after it completed sends `outflows.refunded` as Nuvion's docs
//   define it: a CREDIT record (type inflow, meta.source_payment_id naming the send), not the send itself.
//
// Control routes, for a verifier (no auth: local only), all under /__standin/:
//   GET  state                     counts, every account with its balance, the webhooks sent
//   GET  account/<id|number|ban>   one account with its balance and its account number
//   POST fund                      { account_number | account_id | entity_id, amount_kobo }: money in
//                                  (a bank-transfer inflow, successful) and an inflows.completed webhook
//   POST webhook                   { event, data } or { event, transfer_id }: send one signed webhook
//   POST transfers/<id>/settle     { status: successful | failed | reversed }
//   POST entities/<id>/approve | reject      (when STANDIN_AUTO_APPROVE=0, or to decide by hand)
//   POST directory                 { bank_code, account_number, name }: a bank account the name check finds
//
// Settings (environment): PORT (NUVION_STANDIN_PORT), HUB_WEBHOOK_URL, NUVION_WEBHOOK_SECRET,
// NUVION_OPERATIONAL_ACCOUNT_ID, STANDIN_PARENT_ENTITY_ID, STANDIN_OPERATIONAL_KOBO (opening balance),
// NUVION_FEE_BOOK_TRANSFER / NUVION_FEE_BANK_PAYOUT / NUVION_FEE_INFLOW (kobo, as the Hub's settings;
// a whole number), STANDIN_AUTO_APPROVE (default 1), STANDIN_APPROVE_MS, STANDIN_DETAILS_MS,
// STANDIN_SETTLE_MS, STANDIN_WEBHOOK_DELAY_MS.
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => {
  const n = Number(env(k, String(d)));
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : d;
};

const PORT = num('NUVION_STANDIN_PORT', num('PORT', 0));
const HUB_WEBHOOK_URL = env('HUB_WEBHOOK_URL', '');
const SECRET = env('NUVION_WEBHOOK_SECRET', '');
const PARENT_ENTITY = env('STANDIN_PARENT_ENTITY_ID', '01STACKPARENTENTITY000001');
const OPERATIONAL_ID = env('NUVION_OPERATIONAL_ACCOUNT_ID', '01STACKOPERATIONAL0000001');
const FEE = {
  book: num('NUVION_FEE_BOOK_TRANSFER', 0),
  bank: num('NUVION_FEE_BANK_PAYOUT', 0),
  inflow: num('NUVION_FEE_INFLOW', 0),
};
const AUTO_APPROVE = env('STANDIN_AUTO_APPROVE', '1') !== '0';
const APPROVE_MS = num('STANDIN_APPROVE_MS', 800);
const DETAILS_MS = num('STANDIN_DETAILS_MS', 600);
const SETTLE_MS = num('STANDIN_SETTLE_MS', 1500);
const HOOK_DELAY_MS = num('STANDIN_WEBHOOK_DELAY_MS', 300);

// ---------------------------------------------------------------- data
const BANKS = [
  { bank_code: '044', bank_name: 'Access Bank', swift_bic: 'ABNGNGLA' },
  { bank_code: '058', bank_name: 'Guaranty Trust Bank', swift_bic: 'GTBINGLA' },
  { bank_code: '090270', bank_name: 'AB Microfinance Bank', swift_bic: null },
  { bank_code: '120001', bank_name: '9 Payment Service Bank', swift_bic: 'IPSBNGLA' },
  { bank_code: '000014', bank_name: 'Zenith Bank', swift_bic: 'ZEIBNGLA' },
];
const entities = new Map();
const accounts = new Map();
const details = new Map();
const transfers = new Map(); // id -> { t, toAccountId }
const counterparties = new Map();
const paymentDetails = new Map();
const directory = new Map(); // "bank:number" -> holder name
const sent = []; // webhooks sent: { event, id, attempts, status }
const used = new Set(); // generated numbers

const now = () => Date.now();
const ulid = (p) => `${p}${crypto.randomBytes(12).toString('hex').toUpperCase()}`.slice(0, 26);
const digits = (n) => {
  let s = '';
  while (s.length < n) s += String(crypto.randomInt(0, 10));
  return s;
};
const uniqueDigits = (n, prefix = '') => {
  for (;;) {
    const v = prefix + digits(n - prefix.length);
    if (!used.has(v)) {
      used.add(v);
      return v;
    }
  }
};

const envelope = (data, message = 'OK') => ({ status: 'success', message, data });
const errorBody = (type, message = 'Something went wrong.') => ({ status: 'error', message, type });
const notFound = () => ({ status: 404, body: errorBody('error_resource_not_found', 'Resource does not exist') });
const invalid = (m) => ({ status: 422, body: errorBody('error_validation_failed', m) });

function addAccount(entityId, over = {}) {
  const a = {
    id: ulid('01ACC'),
    entity_id: entityId,
    type: 'checking',
    currency: 'NGN',
    display_name: 'Naira wallet',
    config: { is_overdraftable: false, overdraft_limit: 0 },
    nuvion_ban: `00${uniqueDigits(8)}`,
    balance: { available: 0, current: 0, overdraft_used: 0 },
    deleted: 0,
    created: now(),
    updated: now(),
    ...over,
  };
  accounts.set(a.id, a);
  return a;
}
const bump = (a, by) => {
  a.balance.available += by;
  a.balance.current += by;
  a.updated = now();
};

// WAWU's operational account, on the parent entity (src/nuvion: NUVION_OPERATIONAL_ACCOUNT_ID).
const operational = addAccount(PARENT_ENTITY, {
  id: OPERATIONAL_ID,
  type: 'operational',
  display_name: 'WAWU operational',
  nuvion_ban: 'NVXSTACKOPS1',
  balance: {
    available: num('STANDIN_OPERATIONAL_KOBO', 100_000_000),
    current: num('STANDIN_OPERATIONAL_KOBO', 100_000_000),
    overdraft_used: 0,
  },
});
// What every account held before its first move, for a statement's opening balance: only this one starts above zero.
const OPENING_KOBO = new Map([[operational.id, operational.balance.current]]);

// ---------------------------------------------------------------- shapes
const masked = (last4) => `***${last4}`;
function entityJson(e) {
  return {
    id: e.id,
    type: 'individual',
    status: e.status,
    name: e.name,
    is_root: false,
    parent_entity: PARENT_ENTITY,
    person_id: e.personId,
    creation_context: 'api',
    risk_level: 'medium',
    created: e.created,
    updated: e.updated,
    ...e.extra,
  };
}
function fullEntity(e) {
  const [first, ...rest] = e.name.split(' ');
  return {
    entity: entityJson(e),
    person: {
      id: e.personId,
      first_name: first,
      last_name: rest.join(' '),
      email: e.email,
      nationality: 'NG',
      gender: 'f',
      is_pep: false,
      status: 'approved',
      phonenumber: e.phone,
    },
    identification: {
      id: `${e.id.slice(0, 20)}IDENT0`,
      person_id: e.personId,
      verification_status: e.status === 'approved' ? 'approved' : 'pending',
      document: { type: 'international_passport', number: masked(e.idLast4), verification_status: e.documentStatus },
      proof_of_address: { type: 'utility_bill', verification_status: e.addressProofStatus },
      identity_numbers: [
        { type: 'BVN', value: masked(e.bvnLast4), verification_status: e.bvnStatus },
        { type: 'NIN', value: masked(e.ninLast4), verification_status: e.ninStatus },
      ],
    },
    documents: e.documents.map((d) => ({
      id: d.id,
      key: d.key,
      description: d.key === 'identity' ? 'Identity document' : 'Proof',
      urls: { main: `https://files.example.invalid/entity-documents/${e.id}/${d.id}` },
      meta: { file_type: d.fileType, content_hash: 'x'.repeat(64) },
      created: d.created,
      updated: d.created,
    })),
    child_entities: [],
  };
}
const transferView = (i) => {
  const a = accounts.get(i.t.account_id);
  return { ...i.t, account: a ? { id: a.id, display_name: a.display_name } : undefined };
};

function paged(rows, req, order = 'desc') {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 20) || 20));
  const start = req.query.cursor ? rows.findIndex((r) => r.id === req.query.cursor) + 1 : 0;
  const page = rows.slice(start, start + limit);
  const hasNext = start + limit < rows.length;
  return {
    data: page,
    meta: {
      pagination: {
        order,
        has_next: hasNext,
        limit,
        has_previous: start > 0,
        next_cursor: hasNext && page.length > 0 ? page[page.length - 1].id : null,
        previous_cursor: start > 0 ? rows[start - 1].id : null,
      },
    },
  };
}

// ---------------------------------------------------------------- webhooks (signed as the Hub verifies)
function sign(timestamp, raw) {
  return crypto.createHmac('sha256', SECRET).update(Buffer.concat([Buffer.from(`${timestamp}.`), raw])).digest('hex');
}
function deliver(event, data, after = HOOK_DELAY_MS) {
  const rec = { event, id: ulid('01EVT'), attempts: 0, status: 'queued', at: now() };
  sent.push(rec);
  if (sent.length > 500) sent.shift();
  const attempt = () => {
    if (!HUB_WEBHOOK_URL || !SECRET) {
      rec.status = 'not configured';
      return;
    }
    rec.attempts += 1;
    const raw = Buffer.from(JSON.stringify({ event, data }));
    const timestamp = new Date().toISOString();
    const u = new URL(HUB_WEBHOOK_URL);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': raw.length,
          'x-nuvion-event-id': rec.id,
          'x-nuvion-event-timestamp': timestamp,
          'x-nuvion-event-signature': sign(timestamp, raw),
        },
      },
      (res) => {
        res.resume();
        rec.status = res.statusCode;
        if (res.statusCode >= 200 && res.statusCode < 300) return;
        retry();
      },
    );
    req.on('error', (e) => {
      rec.status = `error ${e.code || e.message}`;
      retry();
    });
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.end(raw);
  };
  const retry = () => {
    if (rec.attempts < 6) setTimeout(attempt, 1000 * 2 ** (rec.attempts - 1)).unref?.();
  };
  setTimeout(attempt, after);
  return rec;
}

// ---------------------------------------------------------------- entities
function approve(e) {
  e.status = 'approved';
  e.bvnStatus = e.ninStatus = e.documentStatus = e.addressProofStatus = 'approved';
  e.updated = Math.max(now(), e.updated + 1);
  deliver('entities.updated', entityJson(e), 100);
}
function reject(e, reason) {
  e.status = 'rejected';
  e.documentStatus = 'rejected';
  e.extra = { ...e.extra, rejection_reason: reason || 'The document is not clear. Upload it again.' };
  e.updated = Math.max(now(), e.updated + 1);
  deliver('entities.updated', entityJson(e), 100);
}
function makeEntity(b) {
  const person = b.person || {};
  const doc = (b.identification && b.identification.document) || {};
  const e = {
    id: ulid('01ENT'),
    personId: ulid('01PER'),
    status: 'incomplete',
    name: String(b.name || 'Test Person'),
    phone: String(person.phonenumber || ''),
    email: String(person.email || ''),
    bvnLast4: String(person.bvn || '').slice(-4),
    ninLast4: String(person.nin || '').slice(-4),
    idLast4: String(doc.number || '').slice(-4),
    created: now(),
    updated: now(),
    bvnStatus: 'pending',
    ninStatus: 'pending',
    documentStatus: 'pending',
    addressProofStatus: 'pending',
    documents: [],
    submissions: 0,
    extra: {},
  };
  entities.set(e.id, e);
  return e;
}

// ---------------------------------------------------------------- transfers
function finish(i, to) {
  const t = i.t;
  const from = t.status;
  if (from === to) return;
  const payer = accounts.get(t.account_id);
  const total = t.amount + t.applicable_fee;
  const unfinished = from === 'pending' || from === 'processing';
  if (to === 'successful' && unfinished) {
    if (i.toAccountId) bump(accounts.get(i.toAccountId), t.amount);
  } else if (to === 'failed' && unfinished) {
    bump(payer, total);
  } else if (to === 'reversed' && from === 'successful') {
    if (i.toAccountId) bump(accounts.get(i.toAccountId), -t.amount);
    bump(payer, total);
  } else {
    throw new Error(`a ${from} transfer cannot become ${to}`);
  }
  t.status = to;
  t.status_reason =
    to === 'failed' ? 'compliance_hold' : to === 'successful' ? 'processing_complete' : 'reversed_by_nuvion';
  t.updated = now();
  if (to === 'reversed' && t.payment_type === 'bank-transfer') {
    // Nuvion's docs: `outflows.refunded` is a CREDIT record (type inflow) of the money coming back,
    // naming the reversed transfer in meta.source_payment_id, not the transfer itself (webhooks/event-types).
    // It gives back what the payer got back: the amount and the charge.
    const id = ulid('01CRD');
    const credit = {
      id,
      amount: total,
      currency: t.currency,
      unique_reference: `${t.unique_reference}_reversal`,
      counterparty_id: `acct-${t.account_id}-bank-return`,
      account_id: t.account_id,
      entity_id: t.entity_id,
      status: 'successful',
      status_reason: 'bank_returned',
      narration: `REVERSAL | ${t.id}`,
      type: 'inflow',
      payment_type: 'bank-transfer',
      applicable_fee: 0,
      meta: { source: 'bank_return', source_payment_id: t.id },
      created: now(),
      updated: now(),
    };
    const ci = { t: credit, toAccountId: null };
    transfers.set(id, ci);
    deliver('outflows.refunded', transferView(ci));
    return;
  }
  deliver(
    to === 'successful' ? 'outflows.completed' : to === 'failed' ? 'outflows.failed' : 'outflows.refunded',
    transferView(i),
  );
}

function createTransfer(b) {
  const payer = accounts.get(String(b.account_id));
  if (!payer) return notFound();
  const isOperational = payer.id === operational.id;
  const entity = typeof b.entity_id === 'string' ? b.entity_id : null;
  if (isOperational ? entity !== null && entity !== PARENT_ENTITY : entity !== payer.entity_id) {
    return invalid('entity_id: does not match the account');
  }
  const reference = b.unique_reference;
  if (typeof reference !== 'string' || reference.length < 1 || reference.length > 64) {
    return invalid('unique_reference: 1 to 64 characters');
  }
  const amount = b.amount;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) {
    return invalid('amount: a whole number above zero');
  }
  if (b.currency !== 'NGN' || payer.currency !== 'NGN') return invalid('currency: expected NGN');
  const book = b.payment_type === 'book-transfer';
  if (!book && b.payment_type !== 'bank-transfer') return invalid('payment_type: expected book-transfer or bank-transfer');

  let payee = null;
  let counterpartyId;
  let paymentDetailId;
  if (book) {
    if (typeof b.narration !== 'string' || b.narration.length < 1 || b.narration.length > 100) {
      return invalid('narration: 1 to 100 characters');
    }
    payee = [...accounts.values()].find((a) => a.nuvion_ban === b.nuvion_ban);
    if (!payee) return notFound();
    counterpartyId = ulid('01CPY');
  } else {
    const detail = paymentDetails.get(String(b.payment_detail_id));
    const cp = counterparties.get(String(b.counterparty_id));
    const owner = entity || PARENT_ENTITY;
    if (!detail || !cp || detail.entity_id !== owner || detail.counterparty_id !== cp.id) return notFound();
    counterpartyId = cp.id;
    paymentDetailId = detail.id;
  }

  const original = [...transfers.values()].find(
    (x) => x.t.account_id === payer.id && x.t.unique_reference === reference && x.t.type === 'outflow',
  );
  if (original) {
    if (original.t.amount !== amount) {
      return {
        status: 409,
        body: errorBody('error_idempotency_key_mismatch', 'Idempotency key reused with different parameters'),
      };
    }
    return {
      status: 409,
      body: { ...errorBody('error_duplicate_resource', 'A transfer with this unique_reference already exists.'), data: transferView(original) },
    };
  }
  const fee = book ? FEE.book : FEE.bank;
  if (payer.balance.available < amount + fee) {
    return {
      status: payer.id === operational.id ? 422 : 400,
      body: errorBody('error_transfer_insufficient_funds', "You don't have enough funds for this transfer."),
    };
  }
  const t = {
    id: ulid('01TRF'),
    amount,
    currency: 'NGN',
    unique_reference: reference,
    counterparty_id: counterpartyId,
    ...(paymentDetailId ? { payment_detail_id: paymentDetailId } : {}),
    account_id: payer.id,
    entity_id: payer.entity_id,
    status: 'pending',
    status_reason: 'awaiting_processing',
    narration: b.narration ?? null,
    type: 'outflow',
    payment_type: book ? 'book-transfer' : 'bank-transfer',
    applicable_fee: fee,
    meta: {},
    created: now(),
    updated: now(),
  };
  const i = { t, toAccountId: payee ? payee.id : null };
  transfers.set(t.id, i);
  bump(payer, -(amount + fee)); // the amount and the fee leave `available` at once
  const answered = transferView(i);
  setTimeout(() => {
    try {
      finish(i, 'successful');
    } catch (e) {
      console.log(`[standin] settle ${t.id}: ${e.message}`);
    }
  }, SETTLE_MS);
  return { status: 201, body: envelope(answered, 'Transfer created successfully') };
}

function addInflow(account, amount, over = {}) {
  const id = ulid('01TRF');
  const t = {
    id,
    amount,
    currency: 'NGN',
    unique_reference: `${id}-${now()}`,
    counterparty_id: ulid('01CPY'),
    account_id: account.id,
    entity_id: account.entity_id,
    status: 'successful',
    status_reason: 'Successful.',
    narration: 'Top up from my bank',
    type: 'inflow',
    payment_type: 'bank-transfer',
    applicable_fee: FEE.inflow,
    meta: {},
    created: now(),
    updated: now(),
    ...over,
  };
  const i = { t, toAccountId: null };
  transfers.set(id, i);
  bump(account, amount);
  deliver('inflows.completed', transferView(i), 100);
  return i;
}

// ---------------------------------------------------------------- routes
const readEntityScoped = (req, a) =>
  a.id === operational.id
    ? req.query.entity_id === undefined || req.query.entity_id === PARENT_ENTITY
    : a.entity_id === req.query.entity_id;

const routes = [];
const on = (method, path, fn) => routes.push({ method, path, fn });
const m = (req, i) => req.path.split('/')[i];

on('GET', '/health', () => ({ status: 200, body: { ok: true, service: 'nuvion-standin' } }));

// ---- opening
on('POST', '/individual-entities', (req) => {
  const e = makeEntity(req.body || {});
  return { status: 201, body: envelope(fullEntity(e), 'Individual entity created successfully') };
});
on('PATCH', /^\/individual-entities\/[^/]+$/, (req) => {
  const e = entities.get(m(req, 2));
  if (!e) return notFound();
  const person = (req.body && req.body.person) || {};
  if (person.bvn) (e.bvnLast4 = String(person.bvn).slice(-4)), (e.bvnStatus = 'pending');
  if (person.nin) (e.ninLast4 = String(person.nin).slice(-4)), (e.ninStatus = 'pending');
  if (!(req.body && req.body.meta)) {
    e.documentStatus = e.addressProofStatus = 'pending';
    e.updated = Math.max(now(), e.updated + 1);
  }
  return { status: 200, body: envelope(fullEntity(e), 'Individual entity updated successfully') };
});
on('GET', /^\/entities\/[^/]+$/, (req) => {
  const e = entities.get(m(req, 2));
  return e ? { status: 200, body: envelope(fullEntity(e), 'Entity retrieved successfully') } : notFound();
});
on('GET', '/entities', (req) => {
  const rows = [...entities.values()].filter((e) => !req.query.name || e.name === req.query.name).map(entityJson);
  return { status: 200, body: envelope(paged(rows, req, 'asc'), 'Entities retrieved successfully') };
});
on('POST', '/documents', (req) => {
  const b = req.body || {};
  const e = entities.get(String(b.entity_id));
  if (!e) return notFound();
  const meta = b.meta || {};
  const d = { id: ulid('01DOC'), key: String(b.key), created: now(), fileType: String(meta.file_type || '') };
  e.documents.push(d);
  return {
    status: 201,
    body: envelope(
      {
        document: {
          id: d.id,
          entity_id: e.id,
          key: d.key,
          description: typeof b.description === 'string' ? b.description : '',
          urls: { main: `https://files.example.invalid/entity-documents/${e.id}/${d.id}` },
          meta: { file_type: d.fileType, verification_status: 'pending', uploaded_at: d.created },
          created: d.created,
          updated: d.created,
        },
        entity_verification_impact: { entity_id: e.id },
      },
      'Document submitted successfully',
    ),
  };
});
on('POST', '/onboarding-submissions', (req) => {
  const e = entities.get(String((req.body || {}).entity_id));
  if (!e) return notFound();
  if (e.status !== 'incomplete' && e.status !== 'rejected') {
    return {
      status: 400,
      body: errorBody('error_entity_status_not_incomplete', 'Action requires an incomplete entity profile'),
    };
  }
  e.status = 'pending';
  e.updated = Math.max(now(), e.updated + 1);
  e.submissions += 1;
  if (AUTO_APPROVE) setTimeout(() => e.status === 'pending' && approve(e), APPROVE_MS);
  return { status: 201, body: envelope({ entity: entityJson(e) }, 'Onboarding completed successfully') };
});

// ---- accounts and account details
on('POST', '/accounts', (req) => {
  const b = req.body || {};
  const e = entities.get(String(b.entity_id));
  if (!e) return notFound();
  if (b.type !== 'checking' || b.currency !== 'NGN') return invalid('type checking and currency NGN are the only ones this stand-in makes');
  if ([...accounts.values()].some((a) => a.entity_id === e.id && a.type === 'checking' && a.currency === 'NGN')) {
    return { status: 409, body: errorBody('error_account_already_exists', 'This entity already has that account.') };
  }
  const a = addAccount(e.id, { display_name: String(b.display_name || 'Naira wallet') });
  deliver('accounts.created', { account: a });
  return { status: 201, body: envelope({ account: a, entity_impact: { entity_id: e.id, total_accounts: 1 } }, 'Account created successfully') };
});
on('GET', '/accounts', (req) => {
  const owner = req.query.entity_id || PARENT_ENTITY;
  const rows = [...accounts.values()]
    .filter((a) => a.entity_id === owner)
    .filter((a) => !req.query.currency || a.currency === req.query.currency)
    .filter((a) => !req.query.type || a.type === req.query.type);
  return { status: 200, body: envelope(paged(rows, req), 'Accounts retrieved successfully') };
});
on('GET', /^\/accounts\/[A-Za-z0-9]+$/, (req) => {
  const a = accounts.get(m(req, 2));
  if (!a || !readEntityScoped(req, a)) return notFound();
  const op = a.id === operational.id;
  return {
    status: 200,
    body: envelope(
      {
        account: a,
        entity: { id: a.entity_id, type: op ? 'business' : 'individual', verification_status: 'approved' },
        account_details: [...details.values()].filter((d) => d.account_id === a.id),
      },
      'Account retrieved successfully',
    ),
  };
});
on('POST', '/account-details', (req) => {
  const b = req.body || {};
  const a = accounts.get(String(b.account_id));
  if (!a || a.entity_id !== b.entity_id) return notFound();
  if ([...details.values()].some((d) => d.account_id === a.id)) {
    return { status: 409, body: errorBody('error_duplicate_resource', 'Account details already exist for this account') };
  }
  const e = entities.get(a.entity_id);
  const d = {
    id: ulid('01DET'),
    entity_id: a.entity_id,
    account_id: a.id,
    issuer: { name: 'Nuvion MFB', short_name: 'NUV', code: '090999' },
    status: 'pending',
    asset_type: 'fiat',
    beneficiary_name: e ? e.name : 'Test Person',
    currency: a.currency,
    deleted: 0,
    created: now(),
    updated: now(),
  };
  details.set(d.id, d);
  deliver('account_details.created', { account_details: d });
  setTimeout(() => {
    d.status = 'active';
    d.account_number = uniqueDigits(10, '99');
    d.issuer = { id: '000000000000000000000NG001', name: 'Nuvion MFB', code: '090999', scheme: 'cbn_bank_code' };
    d.status_reason = 'Account request approved';
    d.updated = Math.max(now(), d.updated + 1);
    deliver('account_details.updated', d, 100);
  }, DETAILS_MS);
  return { status: 201, body: envelope({ account_details: d }, 'Account detail created successfully') };
});
on('GET', '/account-details', (req) => {
  const rows = [...details.values()].filter(
    (d) => d.entity_id === req.query.entity_id && (!req.query.account_id || d.account_id === req.query.account_id),
  );
  return { status: 200, body: envelope(paged(rows, req), 'Account details retrieved successfully') };
});
on('GET', /^\/account-details\/[A-Za-z0-9]+$/, (req) => {
  const d = details.get(m(req, 2));
  if (!d || d.entity_id !== req.query.entity_id) return notFound();
  return { status: 200, body: envelope({ account_detail: d }, 'Account detail retrieved successfully') };
});

// ---- transfers
on('POST', '/transfers', (req) => createTransfer(req.body || {}));
on('GET', /^\/transfers\/[A-Za-z0-9]+$/, (req) => {
  const i = transfers.get(m(req, 2));
  if (!i) return notFound();
  const parent = i.t.entity_id === PARENT_ENTITY;
  const asked = req.query.entity_id;
  const ok = parent ? asked === undefined || asked === PARENT_ENTITY : asked === i.t.entity_id;
  return ok ? { status: 200, body: envelope(transferView(i), 'Transfer retrieved successfully') } : notFound();
});
on('GET', '/transfers', (req) => {
  const owner = req.query.entity_id || PARENT_ENTITY;
  const rows = [...transfers.values()]
    .map((i) => i.t)
    .filter((t) => t.entity_id === owner)
    .filter((t) => !req.query.account_id || t.account_id === req.query.account_id)
    .filter((t) => !req.query.status || t.status === req.query.status)
    .sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
  return { status: 200, body: envelope(paged(rows, req), 'Transfers retrieved successfully') };
});

// ---- statements: GET /accounts/{account_id}/statements (FIX-67)
// The shape is Nuvion's docs, saved as nuvion-docs/api-reference__accounts.md, "Get account statements":
//   :692 the path; :705-:729 the parameters (year and month required, limit 1 to 100 default 20, include_pending
//   default false, entity_id); :739-:801 the summary (account_id, account_holder, account_currency, ban, address,
//   generated_at, period{start_date,end_date}, balances{opening_balance,closing_balance,total_credits,total_debits,
//   total_fees}); :803-:891 each transaction (transaction_id, date, type credit|debit, description, counterparty{name,
//   account_number masked}, amount before the fee, fee, net_amount, running_balance, reference, status, currency, fx
//   only on a conversion, which this stand-in never makes); :893-:925 pagination (order, has_next, has_previous,
//   limit, next_cursor, previous_cursor, total_transactions); the whole body sits under `data` in the usual envelope
//   (:929-:931). Lines run oldest to newest (:804) and a pending line does not move running_balance or the totals
//   (:736). The months are UTC, as the example's period (:947 "2026-05-01T00:00:00.000Z").
//   The docs list no `cursor` parameter for this call, but its `pagination` answers next_cursor; pagination.md:21
//   names `cursor` for any list, so the stand-in takes it (the Hub's reader sends it, reconcile.ts statementOfMonth).
//   The docs' example moves running_balance by amount plus fee on a debit (447893 to 437868 on amount 5000, fee
//   5025) and gives net_amount as amount minus fee; both are kept. Errors follow errors.md:34-72 and :79: a
//   parameter out of range is 400 error_validation_error with a `validations` entry.
//
// It is built from the transfers this stand-in already records, nothing else, so a statement and
// GET /transfers/{id} always agree:
//   - an outflow is a debit line on its payer (amount, the fee, its own reference, id and time);
//   - a book transfer that landed is also a credit line on its payee (same reference, the time it landed);
//   - an inflow (add money, or the bank-return credit of a reversed bank send) is a credit line;
//   - a reversed book transfer has no record of its return, so its two return lines are derived: the money back to
//     the payer and out of the payee (id 01RTN + the transfer's id, reference "<reference>_reversal");
//   - a failed outflow is one line with status failed that moved nothing (debited, then given back).
// A completed line moves running_balance by what this stand-in really moved: a debit by amount plus fee, a credit by
// its amount (the stand-in does not take an inflow's fee off the account, so neither does the statement).
const monthStart = (y, mo) => Date.UTC(y, mo - 1, 1);
const maskedNumber = (n) => (n ? `XXXXXX${String(n).slice(-4)}` : null);
const lineStatus = (s) => (s === 'successful' ? 'completed' : s === 'pending' || s === 'processing' ? 'pending' : s);

function statementRows(a) {
  const rows = [];
  const other = (id) => accounts.get(id);
  for (const { t, toAccountId } of transfers.values()) {
    const total = t.amount + t.applicable_fee;
    const done = t.status === 'successful';
    const reversed = t.status === 'reversed';
    if (t.account_id === a.id) {
      if (t.type === 'inflow') {
        const bankReturn = t.meta && t.meta.source === 'bank_return';
        rows.push({
          id: t.id, at: t.created, credit: true, amount: t.amount, fee: t.applicable_fee, ref: t.unique_reference,
          status: lineStatus(t.status), delta: done ? t.amount : 0, description: t.narration || 'Money in',
          name: bankReturn ? 'Returned by the bank' : 'Bank transfer', number: null,
        });
        continue;
      }
      const to = toAccountId ? other(toAccountId) : null;
      const detail = paymentDetails.get(t.payment_detail_id);
      rows.push({
        id: t.id, at: t.created, credit: false, amount: t.amount, fee: t.applicable_fee, ref: t.unique_reference,
        status: reversed ? 'completed' : lineStatus(t.status), delta: done || reversed ? -total : 0,
        description: t.narration || (toAccountId ? 'Book transfer' : 'Bank transfer'),
        name: to ? to.display_name : detail ? detail.account_holder_name : 'Bank account',
        number: maskedNumber(to ? to.nuvion_ban : detail && detail.account_number),
      });
      if (reversed && toAccountId) {
        rows.push({
          id: `01RTN${t.id.slice(5)}`.slice(0, 26), at: t.updated, credit: true, amount: total, fee: 0,
          ref: `${t.unique_reference}_reversal`, status: 'completed', delta: total, description: `REVERSAL | ${t.id}`,
          name: to ? to.display_name : 'Reversed', number: maskedNumber(to && to.nuvion_ban),
        });
      }
    }
    if (toAccountId === a.id && t.type === 'outflow' && (done || reversed)) {
      const payer = other(t.account_id);
      const landed = reversed ? Math.min(t.updated, t.created + SETTLE_MS) : t.updated;
      rows.push({
        id: t.id, at: landed, credit: true, amount: t.amount, fee: 0, ref: t.unique_reference, status: 'completed',
        delta: t.amount, description: t.narration || 'Book transfer', name: payer ? payer.display_name : 'Sender',
        number: maskedNumber(payer && payer.nuvion_ban),
      });
      if (reversed) {
        rows.push({
          id: `01RTN${t.id.slice(5)}`.slice(0, 26), at: t.updated, credit: false, amount: t.amount, fee: 0,
          ref: `${t.unique_reference}_reversal`, status: 'completed', delta: -t.amount, description: `REVERSAL | ${t.id}`,
          name: payer ? payer.display_name : 'Sender', number: maskedNumber(payer && payer.nuvion_ban),
        });
      }
    }
  }
  rows.sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : x.id > y.id ? 1 : x.credit === y.credit ? 0 : x.credit ? -1 : 1));
  let running = OPENING_KOBO.get(a.id) || 0;
  for (const r of rows) {
    if (r.status === 'completed') running += r.delta;
    r.balance = running;
  }
  return rows;
}

const invalidParam = (field, message, type = 'error_validation_value_out_of_range') => ({
  status: 400,
  body: {
    ...errorBody('error_validation_error', 'Validation failed for one or more fields'),
    validations: [{ [field]: { type, message } }],
  },
});

on('GET', /^\/accounts\/[A-Za-z0-9]+\/statements$/, (req) => {
  const a = accounts.get(m(req, 2));
  if (!a || !readEntityScoped(req, a)) return notFound();
  const q = req.query;
  const whole = (v) => (/^-?\d+$/.test(String(v)) ? Number(v) : null);
  const year = q.year === undefined ? null : whole(q.year);
  const month = q.month === undefined ? null : whole(q.month);
  if (year === null || year < 1970 || year > 9999) {
    return invalidParam('year', "The value for 'year' is required and should be a year such as 2026.");
  }
  if (month === null || month < 1 || month > 12) {
    return invalidParam('month', "The value for 'month' is required and should be between 1 and 12.");
  }
  const limit = q.limit === undefined ? 20 : whole(q.limit);
  if (limit === null || limit < 1 || limit > 100) {
    return invalidParam('limit', "The value for 'limit' should be between 1 and 100.");
  }
  if (q.include_pending !== undefined && q.include_pending !== 'true' && q.include_pending !== 'false') {
    return invalidParam('include_pending', "The value for 'include_pending' should be true or false.", 'error_validation_invalid_value');
  }
  const pending = q.include_pending === 'true';

  const from = monthStart(year, month);
  const until = month === 12 ? monthStart(year + 1, 1) : monthStart(year, month + 1);
  const all = statementRows(a);
  const before = all.filter((r) => r.at < from);
  const inMonth = all.filter((r) => r.at >= from && r.at < until);
  const done = inMonth.filter((r) => r.status === 'completed');
  const opening = before.length ? before[before.length - 1].balance : OPENING_KOBO.get(a.id) || 0;
  const closing = (inMonth.length ? inMonth[inMonth.length - 1] : before[before.length - 1] || { balance: opening }).balance;
  const lines = inMonth.filter((r) => pending || r.status !== 'pending');

  const at = q.cursor === undefined ? -1 : lines.findIndex((r) => r.id === q.cursor);
  if (q.cursor !== undefined && at < 0) {
    return invalidParam('cursor', "The value for 'cursor' is not a cursor of this statement.", 'error_validation_invalid_value');
  }
  const start = at + 1;
  const page = lines.slice(start, start + limit);
  const hasNext = start + limit < lines.length;
  const entity = a.id === operational.id ? null : entities.get(a.entity_id);
  const generated = now();
  return {
    status: 200,
    body: envelope(
      {
        account_id: a.id,
        account_holder: entity ? entity.name : 'WAWU operational',
        account_currency: a.currency,
        ban: a.nuvion_ban,
        address: { line_1: '1 Stand-in Street', line_2: null, line_3: null, city: 'Lagos', state: 'Lagos', postal_code: '100001', country_code: 'NG' },
        generated_at: new Date(generated).toISOString(),
        period: { start_date: new Date(from).toISOString(), end_date: new Date(Math.min(generated, until - 1)).toISOString() },
        balances: {
          opening_balance: opening,
          closing_balance: closing,
          total_credits: done.filter((r) => r.credit).reduce((n, r) => n + r.amount, 0),
          total_debits: done.filter((r) => !r.credit).reduce((n, r) => n + r.amount, 0),
          total_fees: done.reduce((n, r) => n + r.fee, 0),
        },
        transactions: page.map((r) => ({
          transaction_id: r.id,
          date: new Date(r.at).toISOString(),
          type: r.credit ? 'credit' : 'debit',
          description: r.description,
          counterparty: { name: r.name, account_number: r.number },
          amount: r.amount,
          fee: r.fee,
          net_amount: r.amount - r.fee,
          running_balance: r.balance,
          reference: r.ref,
          status: r.status,
          currency: a.currency,
        })),
        pagination: {
          order: 'asc',
          has_next: hasNext,
          has_previous: start > 0,
          limit,
          next_cursor: hasNext && page.length > 0 ? page[page.length - 1].id : null,
          previous_cursor: start > 0 ? lines[start - 1].id : null,
          total_transactions: lines.length,
        },
      },
      'Account statement retrieved successfully',
    ),
  };
});

// ---- bank sends: the bank list, the name check, counterparties, payment details
on('GET', /^\/bank-codes\/[A-Z]{2}$/, (req) => ({
  status: 200,
  body: envelope(req.path.endsWith('/NG') ? BANKS : [], 'Bank codes retrieved successfully'),
}));
on('POST', '/counterparty-lookups', (req) => {
  const b = req.body || {};
  const number = String(b.account_number ?? '');
  const code = String(b.bank_code ?? '');
  if (b.country !== 'NG' || !/^\d{10}$/.test(number)) {
    return { status: 422, body: errorBody('error_resolution_format_invalid', 'Account number format is invalid') };
  }
  if (!BANKS.some((x) => x.bank_code === code)) {
    return { status: 422, body: errorBody('error_resolution_bank_not_supported', 'Account lookups are not supported for this bank') };
  }
  // A number WAWU's own wallets hold resolves to its holder; one from the directory to its name; a number
  // starting 000 is unknown (for a "no such account" check); any other resolves to a made-up holder.
  const wallet = [...details.values()].find((d) => d.account_number === number);
  const holder =
    directory.get(`${code}:${number}`) ||
    (wallet && wallet.beneficiary_name) ||
    (number.startsWith('000') ? null : `STANDIN HOLDER ${number.slice(-4)}`);
  if (!holder) {
    return { status: 404, body: errorBody('error_resolution_account_not_found', 'No account found matching the provided details') };
  }
  return { status: 200, body: envelope({ account_name: holder, account_number: number, bank_code: code }, 'Account resolved successfully') };
});
on('POST', '/counterparties', (req) => {
  const b = req.body || {};
  const profile = b.profile || {};
  if (b.type !== 'individual' && b.type !== 'business') return { status: 422, body: errorBody('error_validation_error', 'type is required') };
  const c = {
    id: ulid('01CPY'),
    entity_id: String(b.entity_id || PARENT_ENTITY),
    type: String(b.type),
    nickname: `${profile.first_name ?? ''} ${profile.last_name ?? ''}`.trim(),
    status: 'active',
    profile,
    meta: b.meta || {},
    created: now(),
    updated: now(),
    deleted: 0,
  };
  counterparties.set(c.id, c);
  return { status: 201, body: envelope(c, 'Counterparty created successfully') };
});
on('GET', '/counterparties', (req) => {
  const owner = req.query.entity_id || PARENT_ENTITY;
  const rows = [...counterparties.values()].filter((c) => c.entity_id === owner && (!req.query.status || c.status === req.query.status));
  return { status: 200, body: envelope(paged(rows, req, 'asc'), 'Counterparties retrieved successfully') };
});
on('POST', '/payment-details', (req) => {
  const b = req.body || {};
  const owner = String(b.entity_id || PARENT_ENTITY);
  const c = counterparties.get(String(b.counterparty_id));
  if (!c || c.entity_id !== owner) return notFound();
  if (
    b.payment_method !== 'bank-transfer' ||
    b.currency !== 'NGN' ||
    b.country !== 'NG' ||
    !/^\d{10}$/.test(String(b.account_number ?? '')) ||
    !b.bank_code ||
    !b.account_holder_name ||
    !b.bank_name
  ) {
    return { status: 422, body: errorBody('error_validation_error', 'A required field is missing') };
  }
  const d = {
    id: ulid('01PDT'),
    payment_method: 'bank-transfer',
    currency: 'NGN',
    account_holder_name: String(b.account_holder_name),
    counterparty_id: c.id,
    entity_id: owner,
    country: 'NG',
    bank_code: String(b.bank_code),
    account_number: String(b.account_number),
    bank_name: String(b.bank_name),
    deleted: 0,
  };
  paymentDetails.set(d.id, d);
  return { status: 201, body: envelope(d, 'Payment detail created successfully') };
});
on('GET', /^\/payment-details\/[A-Za-z0-9]+$/, (req) => {
  const d = paymentDetails.get(m(req, 2));
  if (!d || d.entity_id !== (req.query.entity_id || PARENT_ENTITY)) return notFound();
  return { status: 200, body: envelope(d, 'Payment detail retrieved successfully') };
});
on('GET', /^\/counterparties\/[A-Za-z0-9]+\/payment-details$/, (req) => {
  const owner = req.query.entity_id || PARENT_ENTITY;
  const rows = [...paymentDetails.values()].filter((d) => d.counterparty_id === m(req, 2) && d.entity_id === owner);
  return { status: 200, body: envelope(paged(rows, req, 'asc'), 'Payment details retrieved successfully') };
});

// ---- control routes (a verifier's, local only)
const accountByRef = (ref) =>
  accounts.get(ref) ||
  [...accounts.values()].find((a) => a.nuvion_ban === ref) ||
  accounts.get(([...details.values()].find((d) => d.account_number === ref) || {}).account_id);
const accountView = (a) => ({
  ...a,
  account_number: ([...details.values()].find((d) => d.account_id === a.id && d.status === 'active') || {}).account_number || null,
});

on('GET', '/__standin/state', () => ({
  status: 200,
  body: {
    entities: [...entities.values()].map((e) => ({ id: e.id, status: e.status, documents: e.documents.length, submissions: e.submissions })),
    accounts: [...accounts.values()].map(accountView),
    transfers: [...transfers.values()].map((i) => ({
      id: i.t.id, type: i.t.type, payment_type: i.t.payment_type, status: i.t.status, amount: i.t.amount, fee: i.t.applicable_fee, reference: i.t.unique_reference, account_id: i.t.account_id,
    })),
    webhooks: sent.slice(-50),
    fees: FEE,
  },
}));
on('GET', /^\/__standin\/account\/[^/]+$/, (req) => {
  const a = accountByRef(decodeURIComponent(m(req, 3)));
  return a ? { status: 200, body: accountView(a) } : notFound();
});
on('POST', '/__standin/fund', (req) => {
  const b = req.body || {};
  const amount = Number(b.amount_kobo);
  if (!Number.isSafeInteger(amount) || amount < 1) return invalid('amount_kobo: a whole number above zero');
  const a = b.account_number || b.account_id
    ? accountByRef(String(b.account_number || b.account_id))
    : [...accounts.values()].find((x) => x.entity_id === b.entity_id && x.type === 'checking' && x.currency === 'NGN');
  if (!a) return notFound();
  return { status: 201, body: { transfer: transferView(addInflow(a, amount)), balance: a.balance } };
});
on('POST', '/__standin/webhook', (req) => {
  const b = req.body || {};
  let data = b.data;
  if (!data && b.transfer_id) {
    const i = transfers.get(String(b.transfer_id));
    if (!i) return notFound();
    data = transferView(i);
  }
  if (typeof b.event !== 'string' || data === undefined) return invalid('send { event, data } or { event, transfer_id }');
  return { status: 202, body: deliver(b.event, data, 0) };
});
on('POST', /^\/__standin\/transfers\/[^/]+\/settle$/, (req) => {
  const i = transfers.get(m(req, 3));
  if (!i) return notFound();
  const to = (req.body || {}).status;
  if (!['successful', 'failed', 'reversed'].includes(to)) return invalid('status: successful, failed or reversed');
  try {
    finish(i, to);
  } catch (e) {
    return { status: 409, body: { error: e.message } };
  }
  return { status: 200, body: transferView(i) };
});
on('POST', /^\/__standin\/entities\/[^/]+\/(approve|reject)$/, (req) => {
  const e = entities.get(m(req, 3));
  if (!e) return notFound();
  if (m(req, 4) === 'approve') approve(e);
  else reject(e, (req.body || {}).reason);
  return { status: 200, body: { id: e.id, status: e.status } };
});
on('POST', '/__standin/directory', (req) => {
  const b = req.body || {};
  if (!b.bank_code || !/^\d{10}$/.test(String(b.account_number)) || !b.name) return invalid('bank_code, a ten-digit account_number and name');
  directory.set(`${b.bank_code}:${b.account_number}`, String(b.name));
  return { status: 200, body: { ok: true } };
});

// ---------------------------------------------------------------- server
function route(req) {
  const hit = routes.find((r) => r.method === req.method && (typeof r.path === 'string' ? r.path === req.path : r.path.test(req.path)));
  if (!hit) return { status: 404, body: errorBody('error_endpoint_not_found', 'API endpoint does not exist') };
  try {
    return hit.fn(req);
  } catch (e) {
    console.log(`[standin] ${req.method} ${req.path}: ${e && e.stack ? e.stack : e}`);
    return { status: 500, body: errorBody('error_system_internal_error') };
  }
}

const server = http.createServer(async (rq, rs) => {
  const chunks = [];
  for await (const c of rq) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  let body = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  const url = new URL(rq.url || '/', 'http://standin');
  const req = { method: rq.method || 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), body, headers: rq.headers };
  const answer = route(req);
  const out = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
  rs.statusCode = answer.status;
  rs.setHeader('Content-Type', 'application/json');
  rs.setHeader('X-Request-ID', ulid('01REQ'));
  rs.end(out);
  if (!req.path.startsWith('/__standin') && req.path !== '/health') {
    console.log(`[standin] ${req.method} ${req.path} -> ${answer.status}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[standin] Nuvion stand-in on 127.0.0.1:${server.address().port}; webhooks to ${HUB_WEBHOOK_URL || '(none)'}; fees ${JSON.stringify(FEE)}`);
});
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(() => process.exit(0)));
