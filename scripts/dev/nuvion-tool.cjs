#!/usr/bin/env node
// Two commands for a stack's Nuvion stand-in (STACK-NUV). Dev tooling only; read README.md, "Local test stack".
//
//   node scripts/dev/nuvion-tool.cjs seed --name <n> [--scratch <dir>] [--amount-kobo 5000000] [--pin 4829]
//       Makes one person with an APPROVED, FUNDED Nuvion wallet through the Hub's own routes: registers them in the
//       stack's mock WAWU ID, opens the wallet (POST /money/wallet/open), uploads the two documents, waits (about two
//       minutes: the Hub reads webhooks every 30 seconds) for the approval and the account number, sets the PIN, and sends the money in as a signed
//       inflows.completed webhook. With the hosted selfie on (STACK_NUVION_LIVENESS=on) it also starts the selfie and
//       approves it through the stand-in's control route. Prints one JSON line: token, userId, accountNumber, pin, balanceKobo (the Hub's
//       and the stand-in's). With a stack that runs the real wawu-id, pass --token <a wawu-id token> (the mock
//       cannot sign for it).
//
//   node scripts/dev/nuvion-tool.cjs fire --name <n> [--scratch <dir>] <what>
//       Sends one signed webhook from the stand-in to the Hub. <what> is one of
//         --inflow <account number> --amount-kobo <kobo>      money in (a top-up by bank transfer)
//         --settle <transfer id> --status successful|failed|reversed    move a transfer on (outflows.completed,
//                                                              outflows.failed or outflows.refunded)
//         --event <name> --transfer-id <id>                    re-send an event for a transfer the stand-in holds
//         --state                                              print the stand-in's accounts, transfers, webhooks
//
// The ports come from <scratch>/<n>/stack.env. <scratch> is --scratch, else $STACK_SCRATCH, else
// ${TMPDIR:-/tmp}/wawu-stack (as stack.sh). Nothing leaves this machine: only 127.0.0.1 ports of the stack.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
      else (out[a.slice(2)] = next), (i += 1);
    } else out._.push(a);
  }
  return out;
}
const die = (m) => {
  console.error(`nuvion-tool: ${m}`);
  process.exit(1);
};

const a = args(process.argv.slice(2));
const cmd = a._[0];
if (!['seed', 'fire'].includes(cmd) || typeof a.name !== 'string') {
  die('usage: nuvion-tool.cjs seed|fire --name <stack name> [--scratch <dir>] ... (see the top of this file)');
}
const scratch = typeof a.scratch === 'string' ? a.scratch : process.env.STACK_SCRATCH || path.join(process.env.TMPDIR || '/tmp', 'wawu-stack');
const envFile = path.join(path.resolve(scratch), a.name, 'stack.env');
if (!fs.existsSync(envFile)) die(`no stack "${a.name}" in ${path.resolve(scratch)} (is it up? same --scratch as stack.sh)`);
const conf = Object.fromEntries(
  fs.readFileSync(envFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
if (conf.WALLET_PROVIDER !== 'nuvion' || !conf.NUV_PORT) die('this stack has no Nuvion stand-in (an older stack.sh started it)');
const HUB = `http://127.0.0.1:${conf.HUB_PORT}/api/hub`;
const NUV = `http://127.0.0.1:${conf.NUV_PORT}`;

async function call(base, method, p, { body, token, headers, form } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(headers || {}) },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');

async function fire() {
  let r;
  if (a.state) r = await call(NUV, 'GET', '/__standin/state');
  else if (a.inflow) r = await call(NUV, 'POST', '/__standin/fund', { body: { account_number: String(a.inflow), amount_kobo: Number(a['amount-kobo']) } });
  else if (a.settle) r = await call(NUV, 'POST', `/__standin/transfers/${encodeURIComponent(a.settle)}/settle`, { body: { status: a.status } });
  else if (a.event) r = await call(NUV, 'POST', '/__standin/webhook', { body: { event: a.event, transfer_id: a['transfer-id'] } });
  else die('fire needs --inflow, --settle, --event or --state');
  console.log(JSON.stringify(r.json));
  process.exit(r.status < 300 ? 0 : 1);
}

// A 1x1 PNG: the stand-in keeps no file, the Hub only checks the type.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function seed() {
  const stamp = `${Date.now()}${digits(3)}`;
  let token = typeof a.token === 'string' ? a.token : null;
  let phone = `+23480${digits(8)}`;
  if (!token) {
    if (conf.ID_PORT) die('this stack runs the real wawu-id: pass --token <a token it issued>');
    const reg = await call(`http://127.0.0.1:${conf.MOCK_PORT}`, 'POST', '/auth/register', {
      body: { fullName: 'Ada Seeded', email: `seed-${stamp}@example.com`, phone, dialCode: '+234', country: 'Nigeria', password: 'Password123!' },
    });
    token = reg.json.accessToken || reg.json.access_token || (reg.json.tokens && reg.json.tokens.accessToken);
    if (!token) die(`the mock WAWU ID gave no token (${reg.status}): ${JSON.stringify(reg.json).slice(0, 200)}`);
  } else {
    phone = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).phone || phone;
  }
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const open = await call(HUB, 'POST', '/money/wallet/open', {
    token,
    body: {
      bvn: digits(11), nin: digits(11), firstName: 'Ada', lastName: 'Seeded', dateOfBirth: '1991-04-12',
      address: '11 Opebi Road', city: 'Ikeja', state: 'Lagos', postalCode: '100001', gender: 'female',
      idType: 'international_passport', idNumber: `A${digits(8)}`, idExpiryDate: '2031-01-09', proofOfAddressType: 'utility_bill',
    },
  });
  if (open.status >= 300) die(`open wallet: ${open.status} ${JSON.stringify(open.json).slice(0, 300)}`);
  for (const kind of ['identity', 'proof_of_address']) {
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', new Blob([PNG], { type: 'image/png' }), `${kind}.png`);
    const up = await call(HUB, 'POST', '/money/identity/documents', { token, form });
    if (up.status >= 300) die(`upload ${kind}: ${up.status} ${JSON.stringify(up.json).slice(0, 300)}`);
  }
  // With the hosted selfie on (the stack started with STACK_NUVION_LIVENESS=on) the opening waits for it: start it and
  // let the stand-in's page approve it, as a person tapping "Take my selfie" would.
  const live = await call(HUB, 'GET', '/money/identity/liveness', { token });
  const liveView = live.json.data || live.json;
  if (liveView && liveView.enabled === true) {
    const started = await call(HUB, 'POST', '/money/identity/liveness', { token, body: {} });
    const url = (started.json.data || started.json || {}).url;
    const session = typeof url === 'string' ? url.split('/').pop() : null;
    if (started.status >= 300 || !session) die(`start selfie: ${started.status} ${JSON.stringify(started.json).slice(0, 300)}`);
    const done = await call(NUV, 'POST', `/__standin/liveness/${encodeURIComponent(session)}/finish`, {
      body: { capture_status: 'completed', verification_status: 'approved' },
    });
    if (done.status >= 300) die(`approve selfie: ${done.status} ${JSON.stringify(done.json).slice(0, 300)}`);
    // The Hub reads the result from Nuvion when it is asked for it (there is no webhook for the selfie).
    let state = null;
    for (let i = 0; i < 30 && state !== 'passed'; i += 1) {
      const r = await call(HUB, 'GET', '/money/identity/liveness', { token });
      state = (r.json.data || r.json || {}).state ?? null;
      if (state !== 'passed') await sleep(500);
    }
    if (state !== 'passed') die(`the selfie reads ${state} after it was approved`);
  }
  let wallet = null;
  // The Hub reads Nuvion's webhooks on a 30 second tick, and opening is three of them in a row: about two minutes.
  for (let i = 0; i < 300; i += 1) {
    await call(HUB, 'GET', '/money/identity/documents', { token }); // sends the opening for review when the documents are in
    const w = await call(HUB, 'GET', '/money/wallet', { token });
    wallet = w.json.data || w.json;
    if (wallet && wallet.account && wallet.account.accountNumber) break;
    await sleep(1000);
  }
  if (!wallet || !wallet.account || !wallet.account.accountNumber) die(`no account number after 5 minutes; the wallet reads: ${JSON.stringify(wallet).slice(0, 300)}`);
  const accountNumber = wallet.account.accountNumber;
  const pin = typeof a.pin === 'string' ? a.pin : '4829';
  const setPin = await call(HUB, 'POST', '/money/pin', { token, body: { pin, pinConfirmation: pin } });
  if (setPin.status >= 300 && !JSON.stringify(setPin.json).includes('pin_already_set')) die(`set pin: ${setPin.status} ${JSON.stringify(setPin.json).slice(0, 300)}`);
  const amount = Number(a['amount-kobo'] ?? 5_000_000);
  const fund = await call(NUV, 'POST', '/__standin/fund', { body: { account_number: accountNumber, amount_kobo: amount } });
  if (fund.status >= 300) die(`fund: ${fund.status} ${JSON.stringify(fund.json).slice(0, 300)}`);
  // The Hub credits it when the signed webhook arrives and it has read the transfer back.
  let hubBalance = null;
  for (let i = 0; i < 90; i += 1) {
    const b = await call(HUB, 'GET', '/money/wallet/balance', { token });
    hubBalance = (b.json.data || b.json).availableKobo ?? null;
    if (hubBalance === amount) break;
    await sleep(1000);
  }
  const ours = await call(NUV, 'GET', `/__standin/account/${accountNumber}`);
  console.log(JSON.stringify({
    token, userId: claims.sub, accountNumber, pin,
    balanceKobo: { hub: hubBalance, standin: ours.json.balance && ours.json.balance.available },
  }));
}

(cmd === 'fire' ? fire() : seed()).catch((e) => die(e && e.message ? e.message : String(e)));
