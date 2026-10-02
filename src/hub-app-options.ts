import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import type { Application } from 'express';
import { isIPv4 } from 'node:net';

/**
 * The options the Hub app is created with (src/main.ts), in one place so a
 * test builds its app the same way.
 *
 * `rawBody: true` keeps the exact bytes of every JSON and form body on
 * `request.rawBody`, beside the parsed `request.body`. Fintava signs the raw
 * body (HMAC-SHA512, task MONEY-07), and re-serialising the parsed JSON
 * does not give the same bytes back (spacing, key order, `100.0`, escapes).
 * Nothing else changes: the same parsers parse the same bodies.
 */
export const HUB_APP_OPTIONS: NestApplicationOptions = { rawBody: true };

/** 127.0.0.0/8 or ::1, also when Node writes an IPv4 peer as `::ffff:127.x`. */
export function isLoopbackAddress(address: string): boolean {
  const v4 = address.toLowerCase().startsWith('::ffff:')
    ? address.slice('::ffff:'.length)
    : address;
  if (isIPv4(v4)) return v4.startsWith('127.');
  return address === '::1';
}

/**
 * Express's `trust proxy`, as the function form Express calls once per hop
 * (`hop` 0 is the TCP peer, 1 the right-most X-Forwarded-For entry, and so
 * on), task OPS-11.
 *
 * Production is one nginx on the same droplet, proxying to
 * `http://127.0.0.1:3001` and appending the peer it saw to X-Forwarded-For
 * (`$proxy_add_x_forwarded_for`, deploy/install-services.sh). So exactly one
 * hop is trusted, and only when that hop is a loopback peer:
 *
 * - through nginx, `req.ip` is the right-most X-Forwarded-For entry, the
 *   address nginx itself saw. Anything a client wrote to the left of it is
 *   never read, so a client cannot pick another client's address;
 * - a connection that is not from loopback (anyone reaching the app port
 *   without nginx, were the firewall ever opened) is not trusted at all:
 *   its X-Forwarded-For is ignored and `req.ip` is its own address.
 *
 * The global ThrottlerGuard tracks callers by `req.ip`, so this is what gives
 * each caller its own 20/s and 200/min (src/hub-throttlers.ts) instead of one
 * bucket shared by everyone behind nginx. A CDN or load balancer added in
 * front of nginx is another hop, and this must change with it.
 */
export function hubTrustProxy(address: string, hop: number): boolean {
  return hop === 0 && isLoopbackAddress(address);
}

/**
 * Settings that live on the Express instance rather than in the create
 * options. src/main.ts applies them right after creating the app; a test that
 * builds its own app applies them the same way.
 */
export function applyHubHttpSettings(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance() as Application;
  express.set('trust proxy', hubTrustProxy);
}
