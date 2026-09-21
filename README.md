# WAWU Hub API

NestJS + Prisma backend for the WAWU creator content marketplace.

## Running the tests

**The contract suite is not parallel-safe. Always run it with `--runInBand`.**

```bash
npm run test:contract
```

That script is the supported entry point. It pins `--runInBand --forceExit` and
defaults the three environment variables the suite needs:

| Variable | Default |
| --- | --- |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public` |
| `WAWU_ID_JWKS_URL` | `http://localhost:4001/.well-known/jwks.json` |
| `WAWU_ID_BASE_URL` | `http://localhost:4001` |

Each is overridable by exporting it first. Port 4001 is the local
`mock-wawu-id` service (`node mock-wawu-id/server.js`); the specs reuse an
already-running instance and spawn one only if the port is cold. Note that the
committed `.env` points `WAWU_ID_*` at the **real** WAWU ID on :3002 — that is
why the variables have to be set explicitly for a test run, and why
`WAWU_ID_INTERNAL_SERVICE_KEY` from `.env` must not leak into a spec that talks
to the mock (`verification-submission` pins its own; see the comment there).

### Why not parallel

Running bare `jest` (parallel, the default) fails a handful of tests, and **a
different handful on each run** — the counts and the names are not stable. The
cause is not a flake in any one spec: most specs share the same three seeded
accounts from `prisma/seed.ts` and the single `CreatorState` / `CreditsState`
rows that hang off them. In parallel, workers interleave reads and writes on
those rows, so one spec's balance decrement or slot claim lands in the middle
of another's assertion.

Fixing that properly means giving every spec its own identities. Two specs now
do —`src/community/tests/community.contract.spec.ts` registers throwaway WAWU
IDs and tears them down in `afterAll`, and
`src/creator-state/tests/creator-state.contract.spec.ts` owns its rows under
fixture UUIDs — and that pattern is what any newly isolated spec should copy.
Until the rest follow, `--runInBand` is the only way to get a comparable
number, and a parallel run's failures should not be read as regressions.

### Test hygiene rules

A spec must leave `wawu_hub_test` exactly as it found it. Two ways to comply,
in order of preference:

1. **Own your fixtures.** Create rows under UUIDs nothing else touches and
   delete them in `afterAll`. Prefer this.
2. **Snapshot and restore.** If an assertion genuinely needs a seeded row
   (`content-piece` needs the seeded creator's own content for its `scope=mine`
   assertions), snapshot the row in `beforeAll` and write it back in
   `afterAll`.

Deleting the rows you created is not always enough: claiming an upload slot
increments `CreatorState.slotsUsed`, and deleting the ContentPiece does not
give the slot back. That leak is what made `CreatorState › slotsTotal` pass or
fail depending on suite order.

Watch foreign-key directions when tearing down — `Purchase -> ContentPiece` is
`onDelete: Restrict`, not `Cascade`, so purchases must be deleted first.

### Resetting the database

Some tables (`Purchase`, `CreditPurchase`, `Comment`) still accumulate rows
across runs from specs that have not been isolated yet. Nothing asserts on
their totals today, so this is untidy rather than breaking, but to get back to
a clean baseline:

```bash
npm run test:db:clean     # non-destructive: removes only test-generated rows
```

A full reset is `npx prisma migrate reset` against `wawu_hub_test` — that drops
every table, so check `DATABASE_URL` first. Note that re-seeding alone does
**not** repair a mutated seed row: `prisma/seed.ts` upserts with `update: {}`,
so an existing row is left exactly as the last test run left it.

## Admin surface (`/api/hub/admin/*`)

The admin dashboard authenticates against this backend's **own** `AdminUser`
table. It does not go through WAWU ID, and it shares no configuration with the
user flow.

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `POST /api/hub/admin/auth/login` | none | `{ email, password }` -> `{ accessToken, refreshToken, expiresIn, admin }`. Rate limited to 5/min. |
| `POST /api/hub/admin/auth/refresh` | none | `{ refreshToken }` -> a fresh pair. An access token is rejected here. |
| `GET /api/hub/admin/auth/me` | admin | The signed-in admin. |
| `GET /api/hub/admin/auth/admins` | admin, `superadmin` only | The admin roster. |

Roles are `superadmin`, `reviewer`, `support`, `finance`. A handler declares
what it needs with `@AdminRoles(...)` and `@UseGuards(AdminAuthGuard,
AdminRolesGuard)`; a handler with no `@AdminRoles` is open to every **active**
admin. `superadmin` is not implicitly allowed everywhere -- each handler names
the roles it accepts.

**Why admin tokens cannot be confused with user tokens.** Admin tokens are
HS256, signed with a secret this backend owns; WAWU ID tokens are RS256,
verified against WAWU ID's JWKS. Each verifier pins its own algorithm, so
neither token can satisfy the other regardless of the claims it carries. That
is deliberate rather than decorative: the Hub enforces neither `iss` nor `aud`
on user tokens today, so a claim-based separation would be worth nothing here.
Access and refresh tokens also use separate secrets and audiences. The
verified admin lands on `req.admin`, never `req.user`, so no existing guard,
service or `@CurrentUser()` call site can observe one.
`src/admin/auth/tests/admin-auth.contract.spec.ts` asserts the rejection in
both directions, including for a WAWU ID *refresh* token.

Revocation has no session table: bump `AdminUser.tokenVersion` and every
outstanding access and refresh token for that admin stops working on the next
request.

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `ADMIN_JWT_SECRET` | yes | HS256 secret for admin **access** tokens. Min 32 chars. Unset = every admin route 401s (fails closed). |
| `ADMIN_JWT_REFRESH_SECRET` | yes | Separate secret for admin **refresh** tokens. Never the same value. |
| `ADMIN_JWT_ACCESS_TTL` | no | Default `30m`. |
| `ADMIN_JWT_REFRESH_TTL` | no | Default `7d`. |
| `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` / `ADMIN_SEED_NAME` | seed only | Read only by `npm run admin:seed`. No defaults; password must be >= 12 chars. |

### Creating the first superadmin

```bash
ADMIN_SEED_EMAIL=ops@wawu.africa \
ADMIN_SEED_PASSWORD='<a real password>' \
ADMIN_SEED_NAME='Ada Operator' \
npm run admin:seed
```

Idempotent: an existing admin with that email is left untouched. Pass
`ADMIN_SEED_RESET_PASSWORD=true` to re-hash the password and revoke that
admin's outstanding tokens.

## Payments

### Flutterwave webhook (required — not optional)

```
POST /api/hub/webhooks/flutterwave
```

Every money flow in this backend — tips, paid content unlocks, credit packs,
creator subscriptions and upgrades, paid DMs, CAC applications, WAWUPay bills,
WAWUCare plans and both WAWU Legal payment stages — used to be confirmed
**only** by the customer's browser POSTing to a `/verify` endpoint after the
Flutterwave modal closed. Close the tab, drop off Wi-Fi, or crash on the
redirect and the customer is charged while the system grants nothing. This
endpoint is the provider-driven half of that confirmation, and it is what
stops purchases getting stranded in `pending`.

- **Auth**: no JWT and no user. The only credential is the `verif-hash`
  header, which Flutterwave sets to the *verbatim* value of the "Secret hash"
  field on the dashboard. `FlutterwaveSignatureGuard` compares it to
  `FLUTTERWAVE_SECRET_HASH` in constant time and **fails closed** — if the env
  var is unset the endpoint answers 401 rather than accepting everything.
- **Trust**: the payload is never evidence. Its `amount`, `status` and
  `currency` are logged, not believed. Settlement is delegated to the same
  `/verify` service methods the browser calls, each of which re-verifies the
  transaction against Flutterwave and compares the amount Flutterwave reports
  to the amount this server stored (`PendingCharge.expectedAmount`,
  `Purchase.amount`, `CreditPurchase.amount`, …). A ₦1 payment cannot buy an
  ₦18,999 tier through this door either.
- **Exactly-once**: `PaymentWebhookReceipt.deliveryKey` (`<event>:<tx_ref>`) is
  unique, and the insert is the claim — a duplicate delivery loses it and
  never reaches settlement. The webhook racing the browser's `/verify` is
  caught one layer down, by conditional writes in each settle path.
- **Status codes are the retry contract**: `200` handled (settled, refused,
  duplicate, unmatched or ignored — do not redeliver); `401` signature missing
  or wrong (never processed); `5xx` we could not finish, please redeliver.

### Deploy checklist

1. Set `FLUTTERWAVE_SECRET_KEY` to a real key. The app **refuses to boot** in
   production without one, because the mock adapter approves every charge for
   free (`src/common/flutterwave/require-payment-config.ts`).
2. Set `FLUTTERWAVE_SECRET_HASH` to a strong random value.
3. In the Flutterwave dashboard → **Settings → Webhooks**, paste the *same*
   value into "Secret hash" and set the webhook URL to
   `https://<host>/api/hub/webhooks/flutterwave`. Skipping this leaves the
   backend dependent on the browser again — silently.
4. Confirm the URL is reachable without auth from outside your VPC and is not
   behind the JWT-protected path or a WAF rule that strips `verif-hash`.
5. Run `npx prisma migrate deploy` so `PaymentWebhookReceipt` exists.
6. `PaymentWebhookReceipt` is the operator's audit trail: rows with status
   `unmatched`, `rejected` or `failed` are the reconciliation queue. It is
   readable at `GET /api/hub/admin/payments/receipts?status=unresolved`
   (superadmin/finance), and a stuck charge is re-run through the REAL
   verification path with
   `POST /api/hub/admin/payments/receipts/:id/reverify`. There is deliberately
   no "mark as paid": settlement always re-asks Flutterwave and compares the
   answer against `PendingCharge.expectedAmount`.
7. Other required env vars: `DATABASE_URL`, `HUB_API_PORT`, `CORS_ORIGIN`
   (mandatory in production), `WAWU_ID_JWKS_URL`, `WAWU_ID_BASE_URL`,
   `WAWU_ID_INTERNAL_SERVICE_KEY`, `FLUTTERWAVE_PUBLIC_KEY`.

## Verification: two ticks, not a ladder

There is no five-rung ladder any more. There are exactly **two** verifications,
they are **independent** of each other, and neither outranks the other, because
one person may hold more than one role.

| Verification | Price | Tick | What it unlocks |
| --- | --- | --- | --- |
| Creator | NGN 4,999 / year | purple | the tick everywhere; hosting events |
| Professional | NGN 9,999 / year | green | the tick everywhere; hosting events |

Both are annual, both are paid, and both are server-authoritative.

### The wire shape

Every place a user appears on the wire carries the same object: the public
profile, creator discovery, professional listings, search hits, comment
authors, DM counterparties, community message senders and an event's host.

```ts
interface TickState { verified: boolean; expiresAt: string | null }
interface VerificationState { creator: TickState; professional: TickState }
```

`verified` is computed **server-side** from the expiry. A client never compares
dates to decide whether to draw a tick. `expiresAt === null` with
`verified === true` is a perpetual, admin-granted tick (the accounts
grandfathered off the old ladder); `expiresAt === null` with
`verified === false` simply means never verified. Both ticks render when both
are held, and nothing anywhere picks a winner.

### Where it is decided

One function: `deriveVerificationState()` in
`src/common/verification/verification-state.ts`. Every read path calls it,
through `VerificationStateService` for the batched reads. Nothing compares the
stored dates anywhere else.

### Storage, and who owns the truth

**WAWU ID owns it.** Every grant and every revoke PATCHes
`/internal/users/:userId/verification` there FIRST, then mirrors onto four
nullable columns on this backend's `UserProfile`
(`creator_verified_at`, `creator_verified_until`, `professional_verified_at`,
`professional_verified_until`). If identity rejects the call nothing has been
granted here and the payment is simply re-verifiable.

The mirror exists so a page of creator cards renders its ticks from one query.
`WawuIdClient.lookupPublicIdentities` deliberately degrades to an empty map
when identity is unreachable, which would otherwise strip every tick on the
page without an error.

`VerificationTier`, `VerificationSubmission.tier` and
`AdminVerificationAudit.tier` are all still there and still work. The ladder's
review queue has rows in it that predate this change, and a half-reviewed queue
that cannot be finished is worse than one write path too many. Nothing grants a
tick through them. Dropping them is a separate migration once nothing reads
them at all.

### Endpoints

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `GET /api/hub/verification/pricing` | user | Both prices, in naira, by the year. |
| `GET /api/hub/verification/me` | user | The caller's ticks, the prices, and which they may buy. |
| `POST /api/hub/verification/purchase` | user | `{ kind }` -> a Flutterwave inline config. |
| `POST /api/hub/verification/purchase/verify` | user | `{ transaction_id, tx_ref }` -> the granted tick. |
| `POST /api/hub/admin/verification/ticks/:wawuUserId/grant` | admin (superadmin, reviewer) | `{ kind, until? }`. Omitting `until` grants a perpetual tick. |
| `POST /api/hub/admin/verification/ticks/:wawuUserId/revoke` | admin (superadmin, reviewer) | `{ kind }`. Clears both dates. |

Payment runs through the SAME `FLUTTERWAVE_CLIENT` the content unlock uses,
exported from `ContentPieceModule`, rather than a sixth hand-copied adapter
pair. Init writes a `VerificationPurchase` row keyed by its `tx_ref`; nothing
is granted until a server-side verify has confirmed the amount and the
reference with Flutterwave.

### Prices are configured, not compiled in

`PlatformSettings.creatorVerificationPriceNgn` and
`.professionalVerificationPriceNgn`, read only by
`src/common/verification/verification-pricing.ts`, which also holds the
defaults for the case where that row does not exist yet. This is the first
reader `PlatformSettings` has ever had.

### Hosting an event is verified-only

Enforced on the write in `EventService`, on both create and edit, not by hiding
a button. A buyer can never host, because a buyer account can buy neither tick.
An unverified creator and an unverified professional cannot host either: having
the right account type is not having the tick.

The refusal is never a bare 403. `AllExceptionsFilter` carries a `reason`
object through to the caller when a thrower attaches one:

```json
{
  "statusCode": 403,
  "message": "Only verified accounts can host an event. ...",
  "data": null,
  "reason": {
    "code": "verification_required",
    "message": "...",
    "steps": ["...", "...", "..."],
    "purchasable": [
      { "kind": "creator", "priceNgn": 4999, "currency": "NGN", "termMonths": 12 }
    ]
  }
}
```

`code` is what the client branches on; `message` and `steps` are read by a
person, so the app can render "here is what you need to do" instead of a wall.
An exception without a `reason` produces exactly the envelope this filter has
always produced.

## `WAWU_ADMIN_KEY` is retired

It used to gate six operator surfaces — `legal/ops`, `services/ops/applications`,
`bills/ops`, `care/ops`, `PATCH /learn/playbook` and the `learn/guides` writes —
as a single shared static secret with no identity and no role model. All six now
sit behind `AdminAuthGuard` + `AdminRolesGuard` (`src/admin/auth/`), so every
operator action names a real admin and every handler declares which roles may
reach it. Setting `WAWU_ADMIN_KEY` grants access to nothing; `AdminKeyGuard` is
kept only because WAWUAfrica-Dashboard's `scripts/generate-ops-contract.mjs`
parses the file. Configure `ADMIN_JWT_SECRET` / `ADMIN_JWT_REFRESH_SECRET`
instead (see `.env.example`) and create the first admin with `npm run admin:seed`.

**Callers must send the admin's own bearer token.** WAWUAfrica-Dashboard's
`src/app/api/ops/[key]/route.ts` already verifies the caller's admin session
against `GET /api/hub/admin/auth/me` and then swaps in the shared key on the
upstream hop; it needs to forward that same `Authorization` header instead.

---

<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
