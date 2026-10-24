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
//   GET  hold | POST hold          { on: true | false, narration? }: while on, a book transfer INTO WAWU's operational account
//                                  (what a paid tier, ticket or DM sends) stays pending and is not settled by itself, so the
//                                  app's "Paid, still confirming" (M15) can be walked (ME-13 L3). `narration` holds only the
//                                  transfers whose narration contains it. The payer is debited at once, as for any transfer.
//   POST release                   { transfer_id?, status? }: settle the held transfer (every held one without an id) as
//                                  successful (default), failed or reversed, through the normal path: the signed webhook
//                                  (outflows.completed, outflows.failed or outflows.refunded) goes to the Hub
//   POST capital/expire | capital/mature   { order_id }: lapse a Capital reservation, or mature a holding (NUV-12)
//   GET  liveness                  the hosted selfie sessions (FIX-47 L2)
//   POST liveness/<id>/finish      { capture_status?, verification_status? }: decide a session by hand
//
// The hosted selfie (FIX-47 L2), to the shape Nuvion's dashboard uses and test/nuvion/documents-standin.ts models:
//   POST /kyc/liveness/sessions { entity_id?, redirect_url? } -> 201 { url, query_id }; the url is an https address on
//   STANDIN_SELFIE_ORIGIN (the Hub takes only https), and this server answers its path, GET /capture/<query_id>, with a
//   small page of three buttons (take the selfie, a face that does not match, a camera error). A browser on this machine
//   reaches it by sending that https origin to this port (the stack's walks do it in the browser, not here).
//   GET /kyc/liveness/sessions/<query_id> -> capture_status (pending | completed | image-error | internal-error),
//   verification_status (pending | approved | not-approved), initiated_at, capture_url. There is no webhook for it.
//   PATCH /individual-entities/<id> { meta: { liveness_check_id } } saves the link. No image is ever received or kept.
//   The Hub asks for it only when the stack is started with STACK_NUVION_LIVENESS=on (scripts/dev/stack.sh).
//
//   POST card-spend                { card_id, amount_cents, merchant?, reverse? }: a card payment (or its reversal) on a card
//                                  made through POST /virtual-cards or /disposable-cards (WALLET-31); a single-use card is
//                                  blocked after its first payment, as Nuvion does it
// Settings (environment): PORT (NUVION_STANDIN_PORT), HUB_WEBHOOK_URL, NUVION_WEBHOOK_SECRET,
// NUVION_OPERATIONAL_ACCOUNT_ID, STANDIN_PARENT_ENTITY_ID, STANDIN_OPERATIONAL_KOBO (opening balance),
// NUVION_FEE_BOOK_TRANSFER / NUVION_FEE_BANK_PAYOUT / NUVION_FEE_INFLOW (kobo, as the Hub's settings;
// a whole number), STANDIN_AUTO_APPROVE (default 1), STANDIN_APPROVE_MS, STANDIN_DETAILS_MS,
// STANDIN_SETTLE_MS, STANDIN_WEBHOOK_DELAY_MS, STANDIN_SELFIE_ORIGIN (default https://verify.example.invalid).
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
const SELFIE_ORIGIN = env('STANDIN_SELFIE_ORIGIN', 'https://verify.example.invalid').replace(/\/+$/, '');

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
const hold = { on: false, narration: '' }; // POST /__standin/hold: book transfers into the operational account wait
const sessions = new Map(); // hosted selfie sessions: query_id -> { id, entity_id, redirect_url, capture_status, verification_status, initiated_at }

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
    // The address dev answers beside `addresses`, which the Hub reads for a counterparty (FIX-97).
    address: personAddress(e),
    addresses: [personAddress(e)],
    child_entities: [],
  };
}
function personAddress(e) {
  return {
    id: `${e.id.slice(0, 20)}ADDR00`,
    line_1: '12 Admiralty Way',
    city: 'Lagos',
    state: 'Lagos',
    postal_code: '101241',
    country_code: 'NG',
    owner_id: e.personId,
    owner_type: 'person',
    label: 'registered_address',
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

// A book transfer into WAWU's operational account (a purchase) waits while the hold is on.
const isHeld = (i, b) =>
  hold.on && i.toAccountId === operational.id && (hold.narration === '' || String(b.narration || '').includes(hold.narration));

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
    // Dev refuses a transfer whose counterparty's address has no state or postal code, though the
    // counterparty itself was accepted (FIX-98, request 01M5MJABG4WBBV51HMQC8YZ52C).
    const cpAddress = cp.profile && typeof cp.profile.address === 'object' && cp.profile.address ? cp.profile.address : {};
    const lacking = [];
    for (const [shown, field] of [
      ['counterparty.address.state', 'state_or_province'],
      ['counterparty.address.postal_code', 'postal_code'],
    ]) {
      if (!cpAddress[field]) {
        lacking.push({
          [shown]: {
            type: 'error_validation_required_field_missing',
            message: `The '${shown}' field is required. Please include it and try again.`,
          },
        });
      }
    }
    if (lacking.length > 0) {
      return {
        status: 422,
        body: { ...errorBody('error_validation_error', 'Validation failed for one or more fields'), validations: lacking },
      };
    }
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
  if (isHeld(i, b)) {
    i.held = true; // stays pending until POST /__standin/release (or .../settle) decides it
    return { status: 201, body: envelope(answered, 'Transfer created successfully') };
  }
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
  } else if (typeof req.body.meta.liveness_check_id === 'string') {
    e.livenessCheckId = req.body.meta.liveness_check_id; // the link the dashboard saves; it changes nothing else
  }
  return { status: 200, body: envelope(fullEntity(e), 'Individual entity updated successfully') };
});
on('GET', /^\/entities\/[^/]+$/, (req) => {
  const e = entities.get(m(req, 2));
  if (!e && m(req, 2) === PARENT_ENTITY) {
    // WAWU's own entity (the operational account's): a business with an email and an address, as dev answers it.
    const address = {
      id: 'STACKPARENTADDR000000001',
      line_1: '1 Stand-in Street',
      city: 'Lagos',
      state: 'Lagos',
      postal_code: '100001',
      country_code: 'NG',
      owner_id: PARENT_ENTITY,
      owner_type: 'business',
      label: 'registered_address',
    };
    return {
      status: 200,
      body: envelope(
        {
          entity: { id: PARENT_ENTITY, type: 'business', name: 'WAWU STAND-IN LTD', status: 'approved', is_root: true },
          business: { id: 'STACKPARENTBUSINESS00001', email: 'finance@stand-in.example.test', legal_name: 'WAWU STAND-IN LTD' },
          address,
          addresses: [address],
        },
        'Entity retrieved successfully',
      ),
    };
  }
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
  const issuer = b.issuer && typeof b.issuer === 'object' ? b.issuer : null;
  const code = issuer ? String(issuer.code ?? '') : '';
  // As dev answers (FIX-97): the bank is `issuer.code`; a body without it is a 422 naming the field.
  if (code === '') {
    return {
      status: 422,
      body: {
        ...errorBody('error_validation_error', 'Validation failed for one or more fields'),
        validations: [
          {
            issuer: {
              type: 'error_validation_required_field_missing',
              message: "The 'issuer' field is required. Please include it and try again.",
            },
          },
        ],
      },
    };
  }
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
    // Dev's 404 for an account the bank does not hold.
    return {
      status: 404,
      body: errorBody(
        'error_resource_not_found',
        "We couldn't find that accounts. It may have been deleted or the ID might be incorrect.",
      ),
    };
  }
  return {
    status: 200,
    body: envelope(
      {
        _id: ulid('01LKP'),
        lookup_id: `${number}_${code}`,
        details: { issuer: { code, name: 'N/A', short_name: 'N/A' }, account_number: number, name: holder },
        meta: { routability: 'routable' },
        status: 'successful',
        status_reason: 'successfully_resolved',
      },
      'Account retrieved successfully',
    ),
  };
});
on('POST', '/counterparties', (req) => {
  const b = req.body || {};
  const profile = b.profile || {};
  if (b.type !== 'individual' && b.type !== 'business') return { status: 422, body: errorBody('error_validation_error', 'type is required') };
  // Dev refuses an individual without an email and an address (FIX-97).
  if (b.type === 'individual') {
    const address = profile.address && typeof profile.address === 'object' ? profile.address : null;
    const required = (name) => ({
      [name]: {
        type: 'error_validation_required_field_missing',
        message: `The '${name}' field is required. Please include it and try again.`,
      },
    });
    const validations = [];
    if (!address || !address.line1 || !address.city || !/^[A-Za-z]{2}$/.test(String(address.country ?? ''))) {
      validations.push(required('address'));
    }
    if (!profile.email) validations.push(required('email'));
    if (validations.length > 0) {
      return {
        status: 422,
        body: { ...errorBody('error_validation_error', 'Validation failed for one or more fields'), validations },
      };
    }
  }
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
on('GET', /^\/counterparties\/[A-Za-z0-9]+$/, (req) => {
  const c = counterparties.get(m(req, 2));
  if (!c || c.entity_id !== (req.query.entity_id || PARENT_ENTITY)) return notFound();
  return { status: 200, body: envelope(c, 'Counterparty retrieved successfully') };
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

// ---- hosted selfie (FIX-47 L2): Nuvion's /kyc/liveness/sessions, and the page its url opens
const CAPTURE = ['pending', 'completed', 'image-error', 'internal-error'];
const VERIFICATION = ['pending', 'approved', 'not-approved'];
const sessionUrl = (id) => `${SELFIE_ORIGIN}/capture/${id}`;
on('POST', '/kyc/liveness/sessions', (req) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (b.entity_id !== undefined && !entities.has(String(b.entity_id))) return notFound();
  if (b.redirect_url !== undefined && typeof b.redirect_url !== 'string') return invalid('redirect_url: an address');
  const s = {
    id: ulid('01LIV'),
    entity_id: b.entity_id === undefined ? null : String(b.entity_id),
    redirect_url: b.redirect_url === undefined ? null : b.redirect_url,
    capture_status: 'pending',
    verification_status: 'pending',
    initiated_at: now(),
  };
  sessions.set(s.id, s);
  return { status: 201, body: envelope({ url: sessionUrl(s.id), query_id: s.id }, 'Session created successfully') };
});
on('GET', /^\/kyc\/liveness\/sessions\/[A-Za-z0-9_-]+$/, (req) => {
  const s = sessions.get(m(req, 4));
  if (!s || (req.query.entity_id !== undefined && s.entity_id !== req.query.entity_id)) return notFound();
  return {
    status: 200,
    body: envelope(
      { capture_status: s.capture_status, verification_status: s.verification_status, initiated_at: s.initiated_at, capture_url: sessionUrl(s.id) },
      'Session retrieved',
    ),
  };
});
// The hosted page: three buttons, no camera and no image (the stand-in never receives a face).
const PAGE_CHOICES = [
  ['approved', 'Take my selfie'],
  ['not-approved', 'Face does not match'],
  ['image-error', 'Camera problem'],
];
const page = (html) => ({ status: 200, type: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure selfie</title><body style="font-family:sans-serif;max-width:360px;margin:40px auto;padding:0 16px">${html}</body>` });
on('GET', /^\/capture\/[A-Za-z0-9_-]+$/, (req) => {
  const s = sessions.get(m(req, 2));
  if (!s) return { status: 404, type: 'text/html; charset=utf-8', body: '<!doctype html><title>Not found</title><p>This selfie link does not exist.</p>' };
  if (s.capture_status !== 'pending') {
    return page(`<h1>Selfie ${s.verification_status === 'approved' ? 'received' : 'finished'}</h1><p id="done">You can go back to the app.</p>`);
  }
  const buttons = PAGE_CHOICES.map(
    ([v, label]) => `<form method="post" action="/capture/${s.id}/finish" style="margin:12px 0"><button name="result" value="${v}" style="width:100%;padding:14px;font-size:16px">${label}</button></form>`,
  ).join('');
  return page(`<h1>Take a selfie</h1><p>Stand-in page for Nuvion's hosted selfie. Choose what the check finds.</p>${buttons}`);
});
on('POST', /^\/capture\/[A-Za-z0-9_-]+\/finish$/, (req) => {
  const s = sessions.get(m(req, 2));
  if (!s) return notFound();
  const raw = typeof req.body === 'string' ? new URLSearchParams(req.body).get('result') : (req.body || {}).result;
  const to = decideSession(s, raw);
  if (to === null) return invalid('result: approved, not-approved or image-error');
  return page(`<h1>Selfie ${raw === 'approved' ? 'received' : 'finished'}</h1><p id="done">You can go back to the app.</p>`);
});
// approved: the capture finished and was approved; not-approved: it finished and did not match; image-error: the capture failed.
function decideSession(s, result) {
  if (s.capture_status !== 'pending') return s; // a session is decided once
  if (result === 'approved') Object.assign(s, { capture_status: 'completed', verification_status: 'approved' });
  else if (result === 'not-approved') Object.assign(s, { capture_status: 'completed', verification_status: 'not-approved' });
  else if (result === 'image-error') Object.assign(s, { capture_status: 'image-error', verification_status: 'pending' });
  else return null;
  return s;
}

// ---- cards (WALLET-31, R-84), as Nuvion's dev answered them on 24 Oct 2026 (docs/nuvion/DEV-RESULTS.md):
// POST /virtual-cards and /disposable-cards take the fee (NUVION_FEE_CARD_CREATE, default 65,772 kobo) from the
// funding account at once, or answer 400 error_card_creation_fee_required; only USD cards; entity_id is a QUERY on the
// reads and a BODY field on PATCH freeze/unfreeze and DELETE (a query there is 404); a deleted card is 404 everywhere.
// The stand-in keeps the number and CVV so the Hub's reveal can be walked; they are fake and random.
const CARD_FEE = Number(env('NUVION_FEE_CARD_CREATE', '65772'));
const CENT_KOBO = Number(env('STANDIN_CARD_CENT_KOBO', '1500')); // the stand-in's rate: 1 cent = 15 naira
const cards = new Map();
const cardJson = (c) => ({ id: c.id, name: c.name, type: c.type, status: c.status, currency: c.currency, nuvion_account_name: (accounts.get(c.account_id) || {}).display_name || null, last4: null, expiration_month: null, expiration_year: null, created: new Date(c.created).toISOString().slice(0, 10) });
const cardEvent = (c) => ({ id: c.id, name: c.name, type: c.type, status: c.status, currency: c.currency, account_id: c.account_id, nuvion_account_name: (accounts.get(c.account_id) || {}).display_name || null, created: new Date(c.created).toISOString().slice(0, 10) });
const cardEntity = (c) => (accounts.get(c.account_id) || {}).entity_id;
const cardNotFound = () => ({ status: 404, body: errorBody('error_resource_not_found', "We couldn't find that card. It may have been deleted or the ID might be incorrect.") });
const cardScoped = (c, entity) => c && !c.deleted && cardEntity(c) === (entity || PARENT_ENTITY);
const makeCard = (type) => (req) => {
  const b = req.body || {};
  const a = accounts.get(String(b.account_id));
  if (!a || a.entity_id !== (b.entity_id || PARENT_ENTITY)) return notFound();
  const h = b.cardholder || {};
  if (!b.card_name || !h.first_name || !h.last_name || !h.email || !/^\+\d{8,15}$/.test(String(h.phone_number || ''))) {
    return invalid('card_name and a cardholder with first_name, last_name, email and an E.164 phone_number');
  }
  if (b.currency !== 'USD') return { status: 400, body: errorBody('error_operation_invalid_for_state', "You can't perform this action right now due to the current status. Please try again later or contact support.") };
  if (!/^\d{2}$/.test(String(b.expiration_month)) || !/^\d{2}$/.test(String(b.expiration_year))) return invalid('expiration_month MM and expiration_year YY');
  if (a.balance.available < CARD_FEE) {
    return { status: 400, body: errorBody('error_card_creation_fee_required', `Card creation requires at least ${(CARD_FEE / 100).toFixed(2)} NGN to be available for the card creation fee`) };
  }
  bump(a, -CARD_FEE);
  const c = { id: ulid('01CARD'), name: String(b.card_name), type, status: 'active', currency: 'USD', account_id: a.id, number: `4${digits(15)}`, cvv: digits(3), month: b.expiration_month, year: b.expiration_year, first: h.first_name, last: h.last_name, created: now(), deleted: false, txns: [] };
  cards.set(c.id, c);
  deliver('cards.created', cardEvent(c));
  return {
    status: 201,
    body: envelope({
      status: 'active', name: c.name, number: c.number, expiration_month: c.month, expiration_year: c.year, cvv: c.cvv,
      individual_controls: type === 'virtual' ? { life_time_transaction_count: 5000, daily_transaction_count: 100 } : { life_time_transaction_count: 1, daily_transaction_count: 1 },
      individual_mcc_controls: [], mcc_group_controls: [], created: c.created, id: c.id,
    }),
  };
};
on('POST', '/virtual-cards', makeCard('virtual'));
on('POST', '/disposable-cards', makeCard('disposable'));
on('GET', '/cards', (req) => {
  const entity = req.query.entity_id || PARENT_ENTITY;
  const rows = [...cards.values()].filter((c) => !c.deleted && cardEntity(c) === entity && (!req.query.account_id || c.account_id === req.query.account_id));
  rows.sort((x, y) => y.created - x.created);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const start = req.query.cursor ? Number(req.query.cursor) || 0 : 0;
  const slice = rows.slice(start, start + limit);
  const more = start + limit < rows.length;
  return { status: 200, body: { status: 'success', data: { cards: slice.map(cardJson), pagination: { order: 'desc', has_next: more, limit, has_previous: start > 0, next_cursor: more ? String(start + limit) : null, previous_cursor: null } } } };
});
on('GET', /^\/card-details\/[A-Za-z0-9]+$/, (req) => {
  const c = cards.get(m(req, 2));
  if (!cardScoped(c, req.query.entity_id)) return cardNotFound();
  return {
    status: 200,
    body: envelope({
      id: c.id, status: c.status, name: c.name, type: c.type, number: c.number, expiration_month: c.month, expiration_year: c.year, cvv: c.cvv,
      first_name: c.first, last_name: c.last, amount: 1000000, currency: 'USD',
      individual_controls: c.type === 'virtual' ? { life_time_transaction_count: 5000, daily_transaction_count: 100 } : { life_time_transaction_count: 1, daily_transaction_count: 1 },
      individual_mcc_controls: [], mcc_group_controls: [], retrieved: now(),
      billing: { address_line_1: '390 NE 191ST ST STE 8972', address_line_2: '', city: 'MIAMI', state: 'FL', postal_code: '33179' },
    }),
  };
});
const cardChange = (to, event, message) => (req) => {
  const c = cards.get(m(req, 2));
  // entity_id in the BODY, as Nuvion reads it (a query is 404).
  if (!cardScoped(c, (req.body || {}).entity_id)) return cardNotFound();
  c.status = to;
  deliver(event, cardEvent(c));
  return { status: 200, body: envelope({ message, status: to, updated: now() }) };
};
on('PATCH', /^\/card-details\/[A-Za-z0-9]+\/freeze$/, cardChange('blocked', 'cards.frozen', 'Card frozen successfully'));
on('PATCH', /^\/card-details\/[A-Za-z0-9]+\/unfreeze$/, cardChange('active', 'cards.unfrozen', 'Card unfrozen successfully'));
on('DELETE', /^\/card-details\/[A-Za-z0-9]+$/, (req) => {
  const c = cards.get(m(req, 2));
  if (!cardScoped(c, (req.body || {}).entity_id)) return cardNotFound();
  c.deleted = true;
  c.status = 'blocked';
  deliver('cards.deleted', cardEvent(c));
  return { status: 200, body: envelope({ message: 'Card soft-deleted successfully', status: 'blocked', deleted: now() }) };
});
on('GET', /^\/card-transactions\/[A-Za-z0-9]+$/, (req) => {
  const c = cards.get(m(req, 2));
  if (!cardScoped(c, req.query.entity_id)) return { status: 404, body: errorBody('error_resource_not_found', 'Card not accessible by this entity') };
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const start = req.query.cursor ? Number(req.query.cursor) || 0 : 0;
  const rows = [...c.txns].sort((x, y) => y.created - x.created);
  const more = start + limit < rows.length;
  return { status: 200, body: { status: 'success', data: { payments: rows.slice(start, start + limit), pagination: { order: 'desc', has_next: more, limit, has_previous: start > 0, next_cursor: more ? String(start + limit) : null, previous_cursor: null } } } };
});
// A verifier's: spend on a card (debits the funding account at the stand-in's rate) or give a payment back.
on('POST', '/__standin/card-spend', (req) => {
  const b = req.body || {};
  const c = cards.get(String(b.card_id));
  const cents = Number(b.amount_cents);
  if (!c || c.deleted || !Number.isSafeInteger(cents) || cents < 1) return invalid('card_id and amount_cents (a whole number above zero)');
  if (c.status !== 'active') return { status: 400, body: errorBody('error_operation_invalid_for_state', 'The card is not active.') };
  const a = accounts.get(c.account_id);
  const kobo = cents * CENT_KOBO;
  const reverse = b.reverse === true;
  if (!reverse && a.balance.available < kobo) return { status: 400, body: errorBody('error_transfer_insufficient_funds', 'Not enough in the account.') };
  bump(a, reverse ? kobo : -kobo);
  const t = {
    _id: ulid('01CTX'), amount: cents, currency: 'USD', unique_reference: ulid('TXN'), account_id: a.id, entity_id: a.entity_id,
    status: 'successful', type: reverse ? 'inflow' : 'outflow', payment_type: reverse ? 'card-debit-reversal' : 'card-debit',
    narration: `${reverse ? 'REVERSAL | ' : ''}Payment to ${b.merchant || 'Acme Corp'}`,
    initiator: { type: 'account', id: a.id, name: a.display_name, card_id: c.id },
    recipient: { name: String(b.merchant || 'Acme Corp'), address: { city: 'San Francisco', state: 'CA', postal_code: '94105', country: 'US' } },
    applicable_fee: 0, created: now(), updated: now(), deleted: 0, version: 0,
  };
  c.txns.push(t);
  if (c.type === 'disposable' && !reverse) {
    c.status = 'blocked';
    deliver('cards.frozen', cardEvent(c));
  }
  return { status: 201, body: { transaction: t, balance: a.balance } };
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
    hold: { on: hold.on, narration: hold.narration },
    liveness: [...sessions.values()].map((x) => ({ id: x.id, entity_id: x.entity_id, capture_status: x.capture_status, verification_status: x.verification_status })),
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
on('GET', '/__standin/hold', () => ({
  status: 200,
  body: { on: hold.on, narration: hold.narration, held: [...transfers.values()].filter((i) => i.held && i.t.status === 'pending').map((i) => i.t.id) },
}));
on('POST', '/__standin/hold', (req) => {
  const b = req.body || {};
  if (typeof b.on !== 'boolean') return invalid('on: true or false');
  if (b.narration !== undefined && typeof b.narration !== 'string') return invalid('narration: text');
  hold.on = b.on;
  hold.narration = b.narration || '';
  return { status: 200, body: { on: hold.on, narration: hold.narration } };
});
on('POST', '/__standin/release', (req) => {
  const b = req.body || {};
  const to = b.status === undefined ? 'successful' : b.status;
  if (!['successful', 'failed', 'reversed'].includes(to)) return invalid('status: successful, failed or reversed');
  const held = b.transfer_id === undefined
    ? [...transfers.values()].filter((i) => i.held && i.t.status === 'pending')
    : [transfers.get(String(b.transfer_id))].filter((i) => i && i.held);
  if (held.length === 0) return notFound();
  const released = [];
  for (const i of held) {
    try {
      if (to === 'reversed') finish(i, 'successful'); // a reversal follows a settled transfer
      finish(i, to);
      released.push({ id: i.t.id, status: i.t.status });
    } catch (e) {
      return { status: 409, body: { error: e.message, released } };
    }
    i.held = false;
  }
  return { status: 200, body: { released } };
});
on('GET', '/__standin/liveness', () => ({
  status: 200,
  body: { sessions: [...sessions.values()].map((s) => ({ ...s, url: sessionUrl(s.id) })) },
}));
on('POST', /^\/__standin\/liveness\/[^/]+\/finish$/, (req) => {
  const s = sessions.get(m(req, 3));
  if (!s) return notFound();
  const b = req.body || {};
  if (b.capture_status !== undefined && !CAPTURE.includes(b.capture_status)) return invalid(`capture_status: ${CAPTURE.join(', ')}`);
  if (b.verification_status !== undefined && !VERIFICATION.includes(b.verification_status)) return invalid(`verification_status: ${VERIFICATION.join(', ')}`);
  if (b.capture_status !== undefined) s.capture_status = b.capture_status;
  if (b.verification_status !== undefined) s.verification_status = b.verification_status;
  return { status: 200, body: s };
});
on('POST', '/__standin/directory', (req) => {
  const b = req.body || {};
  if (!b.bank_code || !/^\d{10}$/.test(String(b.account_number)) || !b.name) return invalid('bank_code, a ten-digit account_number and name');
  directory.set(`${b.bank_code}:${b.account_number}`, String(b.name));
  return { status: 200, body: { ok: true } };
});

// ---- Capital (NUV-12): products, reservations, orders, the portfolio, withdrawals. The answers are the shapes
// Nuvion's dev gave on 24 Oct 2026 (mobile docs/nuvion/DEV-RESULTS.md, "Capital"): a reservation lasts 15 minutes
// and moves nothing; confirm debits once and a second confirm is 400 invalid for state; the early action date is
// the confirmation moment; a payout settles after STANDIN_SETTLE_MS as a `capital-early-liquidation-withdrawal`
// inflow whose counterparty is the holding's user_capital_account_id.
const CAP_DOC = { name: 'Terms & Conditions.pdf', url: 'https://docs.example.invalid/capital/terms.pdf' };
const capProducts = [
  { id: '01CAPFR90TREASURYBILLS0001', capital_product_type: 'FIXED_RETURN', is_external: false, name: '90 Days Treasury Bills', description: '<p>A government issued investment instrument for 90 days</p>', currency: 'NGN', start_date: null, end_date: null,
    config: { principal: { min: 100000, max: 100000000, bands: [] }, tenor: { tenor_days: 90 }, rates: { interest: { primary: 0.3, bands: [] }, deductibles: [{ name: 'Withholding Tax', value: 0.1, value_type: 'percentage', applicable_to: 'interest' }] }, orders: { liquidation: { allow_early_withdrawal: true } } } },
  { id: '01CAPFR180FIXEDINCOME00002', capital_product_type: 'FIXED_RETURN', is_external: false, name: '180 Days Fixed Income', description: '<p>Lock in a predetermined return for six months.</p>', currency: 'NGN', start_date: null, end_date: null,
    config: { principal: { min: 1000000, bands: [] }, tenor: { tenor_days: 180 }, rates: { interest: { primary: 0.23, bands: [] }, deductibles: [{ name: 'Withholding Tax', value: 0.1, value_type: 'percentage', applicable_to: 'interest' }] }, orders: { liquidation: { allow_early_withdrawal: false } } } },
  { id: '01CAPSOIPOSPV00000000003A', capital_product_type: 'SHARE_OFFERING', is_external: false, name: 'Dangote IPO SPV', description: '<p>Exposure to the Dangote IPO through a special purpose vehicle.</p>', currency: 'NGN', start_date: now() - 86400000, end_date: now() + 30 * 86400000,
    config: { principal: { min: 20000, max: 10000000, bands: [] }, share_offering: { issuer_name: 'Dangote Refinery', offer_price: 10000, lock_period_days: 0, prospectus_url: 'https://docs.example.invalid/capital/prospectus.pdf', offer_stage: 'ipo' }, rates: { deductibles: [{ name: 'Cross-Deal Fee', value: 0.01, value_type: 'percentage', applicable_to: 'principal' }] } },
    availability: { status: 'available', quantity: null } },
  { id: '01CAPSOMTNPUBLICOFFER0004', capital_product_type: 'SHARE_OFFERING', is_external: false, name: 'MTN Public Offering', description: '<p>Shares in MTN.</p>', currency: 'NGN', start_date: now() - 20 * 86400000, end_date: now() - 5 * 86400000,
    config: { principal: { min: 1000, max: 100000000, bands: [] }, share_offering: { issuer_name: 'MTN', offer_price: 1000, lock_period_days: 180, prospectus_url: 'https://docs.example.invalid/capital/mtn.pdf', offer_stage: 'ipo' }, rates: { deductibles: [] } },
    availability: { status: 'available', quantity: null, orderable: false, reason: 'sale_window_closed' } },
  { id: '01CAPFRDOLLARS000000000005', capital_product_type: 'FIXED_RETURN', is_external: false, name: 'Fixed Return in dollars', description: '<p>Dollars.</p>', currency: 'USD', start_date: null, end_date: null,
    config: { principal: { min: 10000, bands: [] }, tenor: { tenor_days: 90 }, rates: { interest: { primary: 0.15, bands: [] }, deductibles: [] }, orders: { liquidation: { allow_early_withdrawal: true } } } },
  { id: '01CAPPRIVATEEQUITY0000006', capital_product_type: 'PRIVATE_EQUITY', is_external: false, name: 'Private placement', description: '<p>Not served.</p>', currency: 'USD', start_date: null, end_date: null, config: {} },
];
const capOrders = new Map(); // id -> { o, quote, userCap, account }
const capEntity = (req, body) => (body && body.entity_id) || req.query.entity_id || PARENT_ENTITY;
const capView = (r) => ({ ...r.o, capital_account: r.account, agreements: [{ document: { ...CAP_DOC, content: null }, affirmations: [{ action_type: 'affirmation', actioned_at: r.o.created }] }] });
const capExpire = (r) => {
  if (r.o.status === 'RESERVED' && r.o.expires_at <= now()) {
    r.o.status = 'EXPIRED';
    r.o.expired_at = r.o.expires_at;
    r.o.status_reason = 'The reservation expired before it was confirmed.';
  }
};
on('GET', '/products', (req) => {
  const rows = capProducts
    .filter((p) => (!req.query.currency || p.currency === req.query.currency) && (!req.query.capital_product_type || p.capital_product_type === req.query.capital_product_type))
    .map((p) => ({ ...p, config: { ...p.config } }));
  return { status: 200, body: envelope(paged(rows, req, 'asc'), 'Capital products retrieved successfully') };
});
on('GET', /^\/products\/[A-Za-z0-9]+$/, (req) => {
  const p = capProducts.find((x) => x.id === m(req, 2));
  if (!p) return notFound();
  return { status: 200, body: envelope({ ...p, config: { ...p.config, documents: [CAP_DOC] } }, 'Capital product retrieved successfully') };
});
on('POST', '/product-orders', (req) => {
  const b = req.body || {};
  const p = capProducts.find((x) => x.id === b.product_id);
  const a = accounts.get(b.account_id);
  if (!p || !a || a.entity_id !== capEntity(req, b)) return notFound();
  if (a.currency !== p.currency) return invalid('account_id must match the product currency');
  const share = p.capital_product_type === 'SHARE_OFFERING';
  const amount = share ? b.amount : b.principal;
  if (!Number.isInteger(amount) || amount < (p.config.principal.min || 1) || (p.config.principal.max && amount > p.config.principal.max)) return invalid('the amount is outside what the product takes');
  if (!Array.isArray(b.agreement_acceptances) || b.agreement_acceptances.length !== 1 || b.agreement_acceptances[0].document_name !== CAP_DOC.name) return invalid('every document must be affirmed by its name');
  if (p.availability && p.availability.orderable === false) return { status: 400, body: errorBody('error_operation_invalid_for_state', 'Not orderable.') };
  const id = ulid('01ORD');
  const created = now();
  let quote;
  let total;
  if (share) {
    const shares = Math.floor(amount / p.config.share_offering.offer_price);
    const base = shares * p.config.share_offering.offer_price;
    const cross = Math.floor(base * 0.01);
    total = base + cross;
    quote = { product_id: p.id, product_owner_id: ulid('01OWN'), product_type: 'SHARE_OFFERING', currency: p.currency, requested_amount: amount, requested_shares: shares, allocated_shares: shares, unallocated_amount: amount - base, offer_price: p.config.share_offering.offer_price, base_cost: base, brokerage_fee: 0, cross_deal_fee: cross, total_debit: total, deductibles: p.config.rates.deductibles, lock_period_days: p.config.share_offering.lock_period_days };
  } else {
    total = amount;
    quote = { product_id: p.id, product_owner_id: ulid('01OWN'), product_type: 'FIXED_RETURN', currency: p.currency, principal: amount, total_debit: amount, tenor_days: p.config.tenor.tenor_days, locked_rate: p.config.rates.interest.primary, rate_source: 'primary', day_count: 365, is_locked: b.lock_investment === true, allow_early_withdrawal: p.config.orders.liquidation.allow_early_withdrawal, earliest_withdrawal_days: null, penalty: { primary: 0.15 }, deductibles: p.config.rates.deductibles };
  }
  const o = { id, entity_id: a.entity_id, reference: ulid('01REF'), product_id: p.id, funding_account_id: a.id, product_type: p.capital_product_type, currency: p.currency, amount: total, reserved_quantity: share ? quote.allocated_shares : null, status: 'RESERVED', status_reason: null, expires_at: created + 15 * 60000, confirmed_at: null, rejected_at: null, expired_at: null, created, updated: created };
  capOrders.set(id, { o, quote, total, account: null, userCap: ulid('01UCA'), lock: b.lock_investment === true });
  return { status: 201, body: envelope({ id, entity_id: a.entity_id, status: 'RESERVED', expires_at: o.expires_at, currency: p.currency, quote }, 'Capital order reserved successfully') };
});
on('POST', /^\/product-orders\/[A-Za-z0-9]+\/confirm$/, (req) => {
  const r = capOrders.get(m(req, 2));
  if (!r || r.o.entity_id !== capEntity(req, req.body)) return notFound();
  capExpire(r);
  if (r.o.status === 'EXPIRED') return { status: 410, body: errorBody('error_resource_expired', 'This reservation has expired. Please create a new order.') };
  if (r.o.status !== 'RESERVED') return { status: 400, body: errorBody('error_operation_invalid_for_state', "You can't perform this action right now due to the current status.") };
  const a = accounts.get(r.o.funding_account_id);
  if (a.balance.available < r.total) return { status: 400, body: errorBody('error_transfer_insufficient_funds', 'The funding account does not have enough funds to complete this transfer.') };
  bump(a, -r.total);
  const at = now();
  r.o.status = 'APPROVED';
  r.o.confirmed_at = at;
  r.o.updated = at;
  const share = r.o.product_type === 'SHARE_OFFERING';
  const principal = share ? null : r.quote.principal;
  const gross = share ? null : Math.floor((principal * r.quote.locked_rate * r.quote.tenor_days) / 365);
  const ded = share ? null : Math.floor(gross * 0.1);
  r.account = { id: ulid('01CAP'), product_order_id: r.o.id, product_id: r.o.product_id, product_type: r.o.product_type, currency: r.o.currency, account_number: `00${digits(8)}`, created: at, updated: at, lifecycle: { status: share ? 'LOCKED' : 'ACTIVE', payout_status: null },
    ...(share ? { shares_purchased: r.quote.allocated_shares, units_held: r.quote.allocated_shares, base_cost: r.quote.base_cost, total_amount_debited: r.total, current_market_value: null }
      : { principal, locked_rate: r.quote.locked_rate, day_count: 365, tenor_days: r.quote.tenor_days, start_date: at, maturity_date: at + r.quote.tenor_days * 86400000, early_action_date: r.lock || !r.quote.allow_early_withdrawal ? null : at, accrued_interest: 0, due_interest: gross - ded, expected_net_payout: principal + gross - ded, total_deductions: ded, gross_interest: gross, expected_gross_payout: principal + gross, net_payout: null, settlement_date: null }) };
  const id = ulid('01TRF');
  const t = { id, amount: r.total, currency: r.o.currency, unique_reference: ulid('01UNQ'), counterparty_id: ulid('01CPY'), account_id: a.id, entity_id: a.entity_id, status: 'successful', status_reason: 'capital_fixed_return_purchase_settled', narration: `${capProducts.find((x) => x.id === r.o.product_id).name} FR order`, type: 'outflow', payment_type: share ? 'capital-share-offering-purchase' : 'capital-fixed-return-purchase', applicable_fee: 0, meta: {}, created: at, updated: at };
  const i = { t, toAccountId: null };
  transfers.set(id, i);
  r.tx = [{ id: ulid('01CTX'), entity_id: a.entity_id, event_type: 'PURCHASE', amount: r.total, accrual_date: null, created: at, funded_amount: null, placement_fee_charged: null, vehicle_expense_charged: null }];
  deliver('outflows.completed', transferView(i), 100);
  deliver('capital_orders.completed', { id: r.o.id, entity_id: r.o.entity_id, status: 'APPROVED', funding_account_id: a.id }, 200);
  deliver('capital_accounts.created', { id: r.account.id, entity_id: r.o.entity_id, capital_order_id: r.o.id, status: r.account.lifecycle.status }, 300);
  return { status: 200, body: envelope({ id: r.o.id, entity_id: r.o.entity_id, status: 'APPROVED', capital_account_id: r.account.id, user_capital_account_id: r.userCap, transfer_reference: `capital-fixed-return:${r.o.id}` }, 'Capital order confirmed successfully') };
});
on('GET', '/product-orders', (req) => {
  const owner = capEntity(req, null);
  const rows = [...capOrders.values()].filter((r) => r.o.entity_id === owner && (!req.query.status || r.o.status === req.query.status)).map((r) => (capExpire(r), capView(r))).reverse();
  return { status: 200, body: envelope(paged(rows, req), 'Capital orders retrieved successfully') };
});
on('GET', /^\/product-orders\/[A-Za-z0-9]+$/, (req) => {
  const r = capOrders.get(m(req, 2));
  if (!r || r.o.entity_id !== capEntity(req, null)) return notFound();
  capExpire(r);
  return { status: 200, body: envelope(capView(r), 'Capital order retrieved successfully') };
});
on('GET', /^\/product-orders\/[A-Za-z0-9]+\/withdrawal\/preview$/, (req) => {
  const r = capOrders.get(m(req, 2));
  if (!r || r.o.entity_id !== capEntity(req, null)) return notFound();
  if (!r.account) return { status: 404, body: errorBody('error_resource_not_found', 'We could not find that capital_account.') };
  const days = Math.floor((now() - r.account.start_date) / 86400000);
  const gross = Math.floor((r.account.principal * r.account.locked_rate * days) / 365);
  const penalty = Math.floor(gross * 0.15);
  const ded = Math.floor((gross - penalty) * 0.1);
  return { status: 200, body: envelope({ id: r.account.id, entity_id: r.o.entity_id, gross_interest: gross, penalty_rate: 0.15, penalty_amount: penalty, total_deductions: ded, net_payout: r.account.principal + gross - penalty - ded, days_elapsed: days }, 'Capital withdrawal preview generated successfully') };
});
on('POST', /^\/product-orders\/[A-Za-z0-9]+\/withdrawal$/, (req) => {
  const r = capOrders.get(m(req, 2));
  if (!r || r.o.entity_id !== capEntity(req, req.body)) return notFound();
  const a = r.account;
  if (!a || r.o.product_type !== 'FIXED_RETURN' || a.lifecycle.status !== 'ACTIVE' || a.early_action_date === null || a.early_action_date > now()) {
    return { status: 400, body: errorBody('error_operation_invalid_for_state', "You can't perform this action right now due to the current status.") };
  }
  const days = Math.floor((now() - a.start_date) / 86400000);
  const gross = Math.floor((a.principal * a.locked_rate * days) / 365);
  const penalty = Math.floor(gross * 0.15);
  const ded = Math.floor((gross - penalty) * 0.1);
  a.net_payout = a.principal + gross - penalty - ded;
  a.lifecycle = { status: 'EARLY_LIQUIDATING', payout_status: 'pending' };
  a.updated = now();
  r.tx.push({ id: ulid('01CTX'), entity_id: r.o.entity_id, event_type: 'WITHDRAWAL', amount: a.net_payout, accrual_date: null, created: now(), funded_amount: null, placement_fee_charged: null, vehicle_expense_charged: null });
  deliver('capital_accounts.updated', { id: a.id, entity_id: r.o.entity_id, capital_order_id: r.o.id, status: 'EARLY_LIQUIDATING', payout_status: 'pending' }, 100);
  setTimeout(() => {
    const acct = accounts.get(r.o.funding_account_id);
    bump(acct, a.net_payout);
    a.lifecycle = { status: 'WITHDRAWN', payout_status: 'completed' };
    a.updated = now();
    const id = ulid('01TRF');
    const t = { id, amount: a.net_payout, currency: r.o.currency, unique_reference: ulid('01UNQ'), counterparty_id: r.userCap, account_id: acct.id, entity_id: acct.entity_id, status: 'successful', status_reason: 'capital_account_withdrawal_settled', narration: 'Capital liquidation payout', type: 'inflow', payment_type: 'capital-early-liquidation-withdrawal', applicable_fee: 0, meta: { withdrawal_type: 'early_liquidation', product_type: 'fixed_return', provider_reference: null }, created: now(), updated: now() };
    const i = { t, toAccountId: null };
    transfers.set(id, i);
    r.tx.push({ id: ulid('01CTX'), entity_id: r.o.entity_id, event_type: 'EARLY_LIQUIDATION_PAYOUT', amount: a.net_payout, accrual_date: null, created: now(), funded_amount: null, placement_fee_charged: null, vehicle_expense_charged: null });
    deliver('inflows.completed', transferView(i), 100);
    deliver('capital_accounts.completed', { id: a.id, entity_id: r.o.entity_id, capital_order_id: r.o.id, status: 'WITHDRAWN', payout_status: 'completed' }, 200);
  }, SETTLE_MS);
  return { status: 200, body: envelope(capView(r), 'Capital withdrawal initiated successfully') };
});
on('GET', '/capital-portfolio', (req) => {
  const owner = capEntity(req, null);
  let invested = 0;
  let ret = 0;
  for (const r of capOrders.values()) {
    if (r.o.entity_id !== owner || !r.account || ['WITHDRAWN', 'CLOSED', 'REFUNDED'].includes(r.account.lifecycle.status) || r.o.currency !== 'NGN') continue;
    invested += r.total;
    ret += r.account.product_type === 'SHARE_OFFERING' ? 0 : Math.floor((r.account.principal * r.account.locked_rate * Math.floor((now() - r.account.start_date) / 86400000)) / 365);
  }
  const currencies = invested === 0 ? [] : [{ currency: 'NGN', totals: { investment: { amount_invested: invested, total_return: ret, current_value: invested + ret } } }];
  return { status: 200, body: envelope({ currencies }, 'Capital portfolio retrieved successfully') };
});
on('GET', '/capital-transactions', (req) => {
  const r = [...capOrders.values()].find((x) => x.account && x.account.id === req.query.capital_id);
  const rows = r && r.o.entity_id === capEntity(req, null) ? [...r.tx].reverse() : [];
  return { status: 200, body: envelope(paged(rows, req), 'Capital transactions retrieved successfully') };
});
// Control: a verifier moves the clock of a reservation or a holding (local only).
on('POST', '/__standin/capital/expire', (req) => {
  const r = capOrders.get((req.body || {}).order_id);
  if (!r) return notFound();
  r.o.expires_at = now() - 1000;
  return { status: 200, body: { ok: true } };
});
on('POST', '/__standin/capital/mature', (req) => {
  const r = capOrders.get((req.body || {}).order_id);
  if (!r || !r.account) return notFound();
  r.account.lifecycle = { status: 'MATURED', payout_status: null };
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
  rs.setHeader('Content-Type', answer.type || 'application/json');
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
