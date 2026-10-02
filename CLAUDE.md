# WAWU Hub API (wawu-backend)

NestJS 11 and Prisma 7. Every route sits under `/api/hub`. This backend serves
the WAWU mobile app, the web app (`wawuafrica`) and the admin dashboard.

## The mobile app is the product

- **The mobile app is the product and the authority.** Its repo is
  `MOXN-AFRICA/wawu-wmt-mobile`. This backend changes to fit it. The web
  follows it after launch (DECISIONS.md, Authority (owner, 1 Oct 2026), in the
  mobile repo). The app is built with Expo (R-3, owner, 1 Oct 2026).
- **Rulings live in the mobile repo's `DECISIONS.md`.** Every ruling id here
  (R-1 and so on) is from there. A ruling outranks a code comment, a line in
  `README.md`, and anything in `.pipeline/`.
- **Task files live in the mobile repo's `tasks/`.** Start a backend session
  with both repos attached.

## How work is built and verified

Follow the mobile repo's `docs/WORKFLOW.md`. It covers this repo too. What
matters most here:

- **Additive only.** New tables, new nullable columns, new routes. Nothing the
  web or the dashboard calls today is renamed, retyped or widened. Add, then
  move, then remove; a removal is its own task, after two weeks with no calls.
- **Protected routes.** `.pipeline/protected-registry.json` lists the routes the
  web calls: 129 endpoints, frozen 22 Aug 2026, none under `admin/`. Nothing
  in it changes behaviour. It does not cover the admin dashboard's routes yet.
  Task MONEY-01 extends it to the dashboard and builds the regression suite
  from it (pass V3). Until then, treat the dashboard's routes as live too.
- **Fenced files.** `prisma/schema.prisma` (except an additive migration the
  task names), `src/common/**`, `src/app.module.ts`, auth guards and
  `contract/**`. To change one, add a row to the mobile repo's
  `SHARED-CHANGES.md`.
- The session that builds a task never verifies it.
- Never `git stash`, `git reset --hard`, `git checkout -- .` or force-push.
  Never edit a gate, a test or the baseline to make a check pass.
- No em-dashes in anything a user reads, error messages included (R-5).

## Money

- **Wallets run on Fintava, under Loma Bank's licence** (R-1, owner, 1 and 2
  Oct 2026). Fintava is the technology. The licence is Loma Bank's (Iyin Ekiti
  MFB). Every WAWU wallet, Naira and crypto, rides on it. Fintava replaces
  Flutterwave as the money rail. Licensing, custody and regulatory questions
  belong to the owner: no task waits on them, and no task reopens them.
- **The web stays on Flutterwave until after launch.** The Flutterwave
  adapters, the `/verify` routes and `POST /api/hub/webhooks/flutterwave`
  (see "Payments" in `README.md`) keep working exactly as they do. Fintava goes
  in beside them as new routes and tables. Taking Flutterwave out is an
  after-launch removal task.
- **Built on the real Fintava sandbox** (R-20, owner, 2 Oct 2026). No mocks,
  no stand-ins, no feature flags or fallbacks. Keys live in a local `.env`,
  never committed and never in the app.
- **Held money sits in WAWU's merchant wallet** (R-19, owner, 2 Oct 2026).
  Fintava can't reserve part of a customer's balance, so paid DMs, tickets and
  bills move the money into WAWU's own Fintava wallet, then on to the payee or
  back to the payer.
- **Fees: the user pays Fintava's fee plus WAWU's on top** (R-10, owner, 2 Oct
  2026). Both come from config, never from the design.
- **Nobody has a wallet until they open one** (R-6, owner, 2 Oct 2026).
  Identity checks happen then, not at sign-up. Earnings land in the wallet
  automatically; a creator without one keeps earning and the money waits
  (R-11, owner, 2 Oct 2026).
- **One split, 85/15, on every stream** (R-5, owner, 21 Sep 2026). WAWU
  Credits are a count, never naira.
- Fintava's balance is the truth. Never add up our own records and show that
  as a balance.
- What Fintava's API really does is in the mobile repo's `docs/fintava/`.
  Facts come from there and from real sandbox responses, never from the design.
- **Money routes follow `docs/contract/CONVENTIONS.md`** (kobo, `+234`, one
  error shape, `Idempotency-Key`, the `X-Transaction-Pin` header, cursor
  pages). The Naira wallet routes are declared in `src/money/` and listed in
  `docs/contract/WALLET.md`; they are in the contract marked
  `x-wawu-served: false` until their task serves them (MONEY-04).

## Commands

```
npm run build               prisma generate, then nest build
npm run start:dev           run locally with watch
npx tsc --noEmit            typecheck
npm run lint                eslint (it runs with --fix, so it edits files)
npm run test:contract       contract suite; always this, never bare jest (README)
python3 scripts/gates/run.py          the gates
python3 scripts/gates/check_baseline.py   every accepted finding has an owner and a reason
npm run contract:build      regenerate contract/openapi.json (never hand-edit it)
```

The mobile app's API types are generated from `contract/openapi.json`
(`npm run api` in the mobile repo).

## Older notes in this repo

- `README.md`: how to run the tests, admin auth, the Flutterwave webhook and
  the verification ticks. It describes the code as built.
- `.pipeline/REVIEW.md` and `.pipeline/decisions.json`: the record of one
  unattended admin build (22 Aug 2026). History, not rules. Where they
  disagree with the mobile repo's `DECISIONS.md`, that file wins.
