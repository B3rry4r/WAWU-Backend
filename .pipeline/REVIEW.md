# Morning briefing — WAWUAfrica admin build

Unattended run. Everything below was decided without you, per the autonomous-mode
rules in the skills. **Nothing here is irreversible.** Read the top section; the
rest is reference.

---

## The one thing to read if you read nothing else

**Uploaded content can never be seen by anyone. The marketplace has never worked.**

- `ContentPiece` is created `status: 'pending'` (`content-piece.service.ts:418`).
- The only two `contentPiece.update` calls in the entire backend touch
  `commentCount` and `ratingPct`. **Neither touches `status`.**
- `live` and `rejected` are written by `prisma/seed.ts` and nothing else.
- Every public read filters `status='live'`: feed, ranked browse, featured, both
  search routes, public-profile content counts.
- The upload slot is consumed by an atomic increment at create time
  (`:395-396`). There is **no decrement anywhere**, and no delete-content
  endpoint.

A creator pays ₦5,999–₦18,999, permanently burns one of their 6 or 15 slots, and
publishes into a void — with no way to tell, because from their side it just
says "in review" forever. **Everything currently visible on the platform is the
three seeded pieces.**

### A decision I made that you should confirm

The ground-truth agent flagged, correctly, that an admin review queue would be
**the first writer of `live` in this system's history** — so it is not really an
admin view, it is the completion of a shipped-but-inert product path.

**I built it.** Reasoning: the product is already charging for this; the
`pending` default exists precisely to be reviewed; the change is additive and
alters no existing app behaviour; and the alternative is a marketplace that
cannot transact. Skill law 12 — *an entitlement with no endpoint is not a gap to
log, the product is charging for it.*

If you'd rather content auto-published on upload instead of being reviewed, that
is a one-line change in the create path and the queue becomes an override.

---

## Sold on the pricing card, not built

Each of these is advertised to paying customers and has no backing code.

| Promise | Reality |
|---|---|
| **"You keep 90% of every credit spent"** (six app surfaces) | No code multiplies by 0.9 anywhere. `CreditSpend` stores no naira and no rate. **Community hosts cannot be paid at all.** |
| **"Unlimited messages in open communities"** (both tiers) | No tier logic exists in `community-message.service.ts`. Every sender is debited 1 credit **including the host**, who can be 402'd out of their own room. |
| **Downgrade Pro → Basic** | A documented no-op (`creator-subscription.service.ts:470-489`). A creator who downgrades keeps 90/10, 15 slots and private communities forever, while the app confirms the split "goes back to 85%". |
| **DM penalty ladder** (spec §40-44) | Not built — yet the app renders a live suspension countdown off an endpoint that hardcodes zeros. |
| **Priority support · Recommended Deals · 1 month free health insurance** | Three Pro perks with zero backend. WAWUCare charges full price from month one. |
| **Pension registration** | The app POSTs `/service-applications/partner/apply`; the route is `/services/partner/apply`. **404.** |

Also: `LandingContent.tsx` advertises **"Instant Payouts"** and "Last Instant
Payout ₦860k" — against CLAUDE.md's no-wallet rule, on a backend with no payout
code of any kind.

## Money that can go missing

- **There is no Flutterwave webhook.** Every one of eight money flows depends on
  the browser calling `/verify`. Close the tab and the customer is charged and
  granted nothing; the daily sweep then deletes the `PendingCharge`.
  `FLUTTERWAVE_SECRET_HASH` is set in `.env` and read by no code. Already
  visible in dev: **4 of 6 purchases stuck `pending` with a null transaction id,
  and 75 orphaned `PendingCharge` rows.**
- **DM refunds move no money.** `scheduler.service.ts:33` — "needs a Flutterwave
  refund call, which no adapter exposes yet." It writes a log line. The user is
  told they were refunded.
- **`refunded` is unreachable** on bill payments and health subscriptions, while
  the copy says verbatim "our team will refund you".
- **A raced `failed` purchase is permanent** — verify throws forever, so a buyer
  whose card cleared must pay again.
- **Subscription revenue is recorded nowhere.** `PurchaseType` is `content|tip`
  only; billing history returns a hardcoded empty page. The two streams you keep
  100% of are unauditable. **BLOCKED, not built** — the fix needs a new table
  written from live payment paths, which touches an app-serving surface, and
  autonomous mode declines those rather than approving them. Your call.

## Security findings (recorded, not repaired)

- **Neither `iss` nor `aud` is enforced** on the Hub's token validation. Any
  RS256 token signed by that key passes — including tokens minted for
  Basket/Beauty, **and including refresh tokens**, since passport-jwt checks
  only signature and expiry. Setting `WAWU_ID_JWT_AUDIENCE` would currently
  reject 100% of real tokens, because WAWU ID's token service has no audience
  option at all. This needs a coordinated change across both services — not
  something to do unattended.
- **Phone numbers exist in five different shapes** in WAWU ID's user table:
  `+234…`, bare 10-digit, **7-digit fragments**, `234…`, and one 12-digit
  malformed. A `+234`-only admin lookup **misses 11 of 15 real users**, and it
  renders as "no results", never as an error. Admin lookups are built
  format-tolerant. A normalizing migration touches WAWU ID and is yours alone to
  authorize.

## Rendered as real, backed by nothing

`EvgScore` (seed-only) **silently drives creator search ranking and the entire
`/search/suggestions` list**. `ContentPiece.views` and `likes` have no writer yet
weight the trending feed and all three search orderings. `Notification` — 
`prisma.notification.create` **does not exist anywhere in src/**. `BlockedAccount`
has no `create`, so **blocking is impossible** and nothing reads the table.
Also inert: `Comment.likes`, `Mentor.sessions`, `CourseEnrollment.progressPct`,
`ServiceApplication.rejection` (so the tracking screen can never show a refusal).

## Creator input silently discarded

`ApplyPartnerServiceDto.note` is validated with `@MinLength(10)` and **written to
no column**. NEPC documents are dropped entirely; `rcNumber` and every structured
answer survive only inside a prose timeline string. `LegalRequest.details` and
`contractText` — the intake answers and the exact signed contract — can never be
retrieved by anyone.

## Dead ends besides content

**WAWU Legal takes money and strands it three ways**: `quote()` has no controller
route, so `awaiting_quote` can never be priced; `consultation_scheduled` is
terminal *after the consultation fee is paid*; and `in_progress` — fully paid
work — can never be delivered. Abandoned bookings permanently consume lawyer
calendar slots.

**`POST /learn/guides` can never succeed**: the DTO's allowed kinds
(`guide|playbook|export|compliance`) are disjoint from the enum
(`country|article|template`), and the service casts `as never`.

`SubscriptionStatus.cancelled` is unreachable; 3 of 4 `PenaltyState` values are
unreachable; `KycSubmission.approved` is terminal, so payout details can never be
corrected.

## Decisions I made for you

Full detail in `decisions.json`. The ones worth a glance:

| Decision | Confidence |
|---|---|
| Build the content review queue (first writer of `live`) | high — see above |
| No admin screen for EVG; report it as a fake instead | medium |
| Subscription-revenue table: BLOCKED, not built | high |
| Payment reconciliation re-runs real verification, never "mark as paid" | high |
| Admin lookups tolerate all five phone shapes; no normalizing migration | high |
| Dashboard on Next 16 (sibling-fleet evidence + your instruction) | high |

**Refused outright** (13 items, mostly by the derivation agent): any wallet,
balance or cash-out surface; credits→naira conversion; credit refunds; an
AML/CFT dashboard (cut in spec §6); any screen combining KYC with the
verification ladder — that conflation is already a shipped bug; hard-deleting a
sold `ContentPiece`; altering a signed legal contract; manual entitlement grants.

## Hazards any future agent must respect

- Module registration order in `app.module.ts:90-100` is **load-bearing** —
  `@Controller('services') @Get(':id')` is a catch-all.
- Five list endpoints return a **bare array** unless `page`/`perPage` is present.
- **28 of 39 wire types are bare Prisma model re-exports returned by spread** —
  so adding any column to an existing table automatically widens a live response.
  Admin annotations go in new side tables, never nullable columns on existing ones.
- The success interceptor **hardcodes `statusCode: 200` in the body even on 201s**.
