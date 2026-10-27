# Prices come from a list (PRICE-LIST, R-101)

Every price a person sets in the app is picked from a list the owner keeps in admin settings. This file is the Hub's side.

## The two settings

| Key | What | Launch value |
|---|---|---|
| `prices.list_naira` | the price list: pieces, paid questions, community passes, event tickets | 100, 200, 500, 1,000, 1,500, 2,000, 2,500, 3,000, 4,000, 5,000, 7,500, 10,000, 15,000, 20,000, 25,000, 30,000, 40,000, 50,000, 75,000, 100,000, 150,000, 200,000, 250,000, 500,000, 1,000,000 |
| `prices.tip_list_naira` | the tip list | 200, 500, 1,000, 2,000, 5,000, 10,000 |

Both are whole naira, stored as lines of digits (the settings screen's `lines` input), strictly ascending, each once, each above 0 and at most 1,000,000. A save that makes a tip list entry that is not on the price list is `400` (the pair is judged together, so both can change in one request). Read live: a change shows with no restart. The seed is `src/plan-settings/plan-settings.defaults.json`.

## `GET /prices`

Any signed-in person (a fan picking a tip is not a creator, so `GET /content/sale-terms`, creators only, could not carry it; its presets are unchanged). Read only.

```json
{ "prices": [{ "priceNaira": 100, "priceKobo": 10000 }, ...], "tips": [{ "priceNaira": 200, "priceKobo": 20000 }, ...] }
```

## The rule

A price a person sets is on `prices` (or 0 where R-8 allows free). Otherwise `400`, reason code `price_not_on_list` (CONVENTIONS section 3), with `nearestLowerNaira` and `nearestHigherNaira`. Enforced where the app alone sets a price:

- `PATCH /content/{id}`: a new price on a paid piece (an edit that leaves the price as it is is not judged);
- `PUT /paid-dm/settings`: the price of a paid question (`priceKobo`, a new price only);
- `POST /communities/rooms`: a private room's `passPriceKobo`.

Enforced only for the app's requests (`X-Wawu-Client: app`, CONVENTIONS section 3a), because the website calls them too and must see no change: `POST /content` and the draft publish (a draft's price is judged when it is published), `PUT /events/{id}/tickets` and `POST /events` (paid ticket types; a free tier is 0). Without the header those routes behave exactly as before.

Not enforced: `PATCH /creator/dm-settings` and `POST /tips` (website only; the tip list is stored and served).

## The migration

`20261212090000_price_list` moves every paid piece (any status but removed), paid-message price, private room pass price and unsold, unretired ticket type that is not on the list to the nearest list price (the lower on a tie; above the top, the top), and records each in `PriceListMove` (old and new price, in kobo). `PriceMoveNoticeService` tells each owner once per item: "The price of {title} is now ₦{price}, the nearest on the price list." (notification kind `price_moved`). `rollback.sql` puts the old prices back and refuses, changing nothing, when a moved price was changed since or a moved ticket type has since sold.
