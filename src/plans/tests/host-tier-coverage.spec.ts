import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { EventController } from '../../event/event.controller';
import { EventTicketingController } from '../../event-ticketing/event-ticketing.controller';
import { HostTierOffersInterceptor } from '../host-tier-offers.interceptor';
import {
  HostTierRequiredError,
  hostTierRequiredMessage,
} from '../host-tier-error';

/**
 * EVERY ROUTE THAT HOSTS AN EVENT CARRIES THE HOST-TIER OFFER (EVENTS-12).
 *
 * `EventService.assertMayHost` throws a bare `tier_required`; only the route
 * knows whose token asked, so `HostTierOffersInterceptor` (via
 * `@GatesHosting()`) adds the lowest tier in the person's currency. A route
 * that calls the gate without the decorator would answer a refusal with no
 * price, so this holds the two lists equal:
 *
 * - the routes that carry the interceptor are exactly GATED below;
 * - the services that call `assertMayHost` are exactly CALLERS below, so a new
 *   caller has to be looked at here (and its route decorated) before it ships.
 */

const GATED = [
  'POST events',
  'PATCH events/:id',
  'PUT events/:id/tickets',
].sort();

/** Source files (relative to src/) that call the gate, and how many times. */
const CALLERS: Record<string, number> = {
  'event/event.service.ts': 2, // create, update
  'event-ticketing/event-ticketing.service.ts': 1, // setTicketTypes
};

const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

function carriers(controller: { prototype: object }): string[] {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(controller.prototype)) {
    const handler = (controller.prototype as Record<string, unknown>)[name];
    if (typeof handler !== 'function') continue;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as
      number | undefined;
    if (method === undefined) continue;
    const interceptors = (Reflect.getMetadata(INTERCEPTORS_METADATA, handler) ??
      []) as unknown[];
    if (!interceptors.includes(HostTierOffersInterceptor)) continue;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
    out.push(
      `${METHODS[method]} ${`${base}/${path}`.replace(/\/+/g, '/').replace(/\/$/, '')}`,
    );
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory())
      return entry === 'tests' ? [] : sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('the host-tier gate: coverage (EVENTS-12)', () => {
  it('the routes that carry the interceptor are exactly the routes that host an event', () => {
    expect(
      [
        ...carriers(EventController),
        ...carriers(EventTicketingController),
      ].sort(),
    ).toEqual(GATED);
  });

  it('only the event service and the ticketing service call assertMayHost, as many times as listed', () => {
    const root = join(__dirname, '..', '..');
    const found: Record<string, number> = {};
    for (const file of sourceFiles(root)) {
      const calls = (
        readFileSync(file, 'utf8').match(/\.assertMayHost\(/g) ?? []
      ).length;
      if (calls > 0) found[file.slice(root.length + 1)] = calls;
    }
    expect(found).toEqual(CALLERS);
  });

  it('the refusal reads for a person: no em-dash, and an ended tier says so', () => {
    for (const state of ['none', 'ended'] as const) {
      expect(hostTierRequiredMessage(state)).not.toContain('—');
    }
    expect(hostTierRequiredMessage('none')).toMatch(/^Needs a tier\./);
    expect(hostTierRequiredMessage('ended')).toMatch(/^Your tier has ended\./);
  });

  it('the refusal is a 403 in the one error shape, and a copy with the offer keeps its state', () => {
    const bare = new HostTierRequiredError('ended');
    expect(bare.getStatus()).toBe(403);
    const withOffer = bare.withOffer({
      currency: 'NGN',
      lowestTier: { id: 'verify', name: 'Verify', priceMinor: 1 },
    });
    expect(withOffer.getStatus()).toBe(403);
    expect(withOffer.getResponse()).toMatchObject({
      statusCode: 403,
      reason: {
        code: 'tier_required',
        tierState: 'ended',
        currency: 'NGN',
        lowestTier: { id: 'verify' },
      },
    });
  });
});
