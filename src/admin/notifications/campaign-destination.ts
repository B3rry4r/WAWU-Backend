import { BadRequestException } from '@nestjs/common';

/**
 * Where a campaign is allowed to send somebody.
 *
 * A campaign lands in every account at once, so its button is the highest
 * reach any single link in this product has. Left free-form it is an open
 * redirect with a distribution list attached: one compromised or careless
 * dashboard session could point the whole user base at an external page that
 * asks for their WAWU password.
 *
 * So the destination is not a URL an admin types. It is one of a fixed set of
 * in-app routes, every one of which is a screen that exists in WAWU-Web
 * today. Adding a destination is a code change with a reviewer, which is the
 * correct amount of friction for this.
 *
 * External links are refused outright rather than allowlisted by host. WAWU
 * has two sibling products (WAWUBasket, WAWUBeauty) that a campaign will
 * eventually want to promote, and handing them a campaign link is a real
 * requirement - but it is a handoff with its own rules and it belongs behind
 * an in-app handoff screen, not behind a raw href in a notification row.
 */
export const CAMPAIGN_DESTINATIONS = [
  { href: '/home', label: 'Home feed' },
  { href: '/explore', label: 'Explore' },
  { href: '/events', label: 'Events' },
  { href: '/shop', label: 'Shop' },
  { href: '/learn', label: 'Learn' },
  { href: '/services', label: 'Services' },
  { href: '/communities', label: 'Communities' },
  { href: '/professionals', label: 'Professionals' },
  { href: '/profile/verification', label: 'Get verified' },
  { href: '/create', label: 'Create a listing' },
  { href: '/notifications', label: 'Stay here' },
] as const;

export type CampaignDestination = (typeof CAMPAIGN_DESTINATIONS)[number]['href'];

const ALLOWED = new Set<string>(CAMPAIGN_DESTINATIONS.map((d) => d.href));

/** True only for a destination on the list above. */
export function isCampaignDestination(href: string): href is CampaignDestination {
  return ALLOWED.has(href);
}

/**
 * Throws unless `href` is one of the allowed in-app routes.
 *
 * Called from the service rather than only from the DTO so that no future
 * caller can reach the write path around the validation pipe.
 */
export function assertCampaignDestination(href: string): void {
  if (!isCampaignDestination(href)) {
    throw new BadRequestException(
      `actionHref must be one of the allowed in-app destinations: ${[...ALLOWED].join(', ')}`,
    );
  }
}
