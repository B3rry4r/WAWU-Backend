import {
  ArgumentMetadata,
  BadRequestException,
  INestApplication,
  PipeTransform,
  Type,
} from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { firstUnstorableField, unstorableTextMessage } from './storable-text';

/**
 * FIX-17. Refuses a query or path value holding text Postgres cannot take
 * (`storable-text.ts`) with 400 naming the field, before the handler runs.
 *
 * It is not a global pipe, and the order is the whole point. Nest runs an
 * argument's pipes as: the global ValidationPipe, then the argument's own
 * pipes (`@Param('id', ParseUUIDPipe)`, `TgifDatePipe`, ...). A NUL that one
 * of those already refused answered 400 before this task, and keeps that
 * answer. So this pipe goes LAST on each argument
 * (`checkStorableTextOnEveryRoute`), and only text that every other check
 * let through, and that would otherwise reach a query, is refused here.
 *
 * Nest resolves a handler's arguments concurrently and answers the first
 * refusal. Two rules keep every refusal that answered before this task:
 *
 * - The pipe is last on EVERY argument Nest pipes (a body, a file, a custom
 *   decorator too), where it only reads query and path values and hands
 *   every other value back unread. Each pipe in a chain delays a refusal
 *   earlier in that chain by the same step, so with one more on every
 *   argument, two refusals in two arguments (a bad path value and a bad
 *   body) still arrive in the order they did before, and the same one is
 *   answered.
 * - A request with a NUL in one argument and a fault in another (a query key
 *   that does not exist, a bad body) answered that other fault's 400 before
 *   this task, so this refusal waits until every other check of the request
 *   has run (they all run within the same turn of the event loop: class
 *   validation, Nest's parse pipes) and only then refuses. A request without
 *   the fault never waits.
 */
export class StorableTextPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'query' && metadata.type !== 'param') return value;
    const field = firstUnstorableField(value, metadata.data);
    if (field === null) return value;
    return refuseAfterOtherChecks(field);
  }
}

async function refuseAfterOtherChecks(field: string): Promise<never> {
  await new Promise((resolve) => setImmediate(resolve));
  throw new BadRequestException(unstorableTextMessage(field));
}

/** The one instance every route shares. */
export const STORABLE_TEXT_PIPE = new StorableTextPipe();

interface RouteArg {
  index: number;
  data?: unknown;
  pipes: unknown[];
}

/**
 * Puts `STORABLE_TEXT_PIPE` last on every argument of every route the app
 * mounts, every method, so a route added later is covered without a line of
 * its own. It reads query and path values only: a request body passes
 * through it unread.
 *
 * Call it after creating the app and before `app.init()` / `app.listen()`:
 * Nest reads each handler's arguments when it builds the router, at init.
 * Calling it twice adds nothing.
 */
export function checkStorableTextOnEveryRoute(app: INestApplication): void {
  const scanner = new MetadataScanner();
  const seen = new Set<Type<unknown>>();
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const controller = wrapper.metatype as Type<unknown> | null;
      if (!controller || seen.has(controller)) continue;
      seen.add(controller);
      const prototype = controller.prototype as object;
      for (const method of scanner.getAllMethodNames(prototype)) {
        const args = Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          controller,
          method,
        ) as Record<string, RouteArg> | undefined;
        if (!args) continue;
        for (const arg of Object.values(args)) {
          if (!arg.pipes.includes(STORABLE_TEXT_PIPE))
            arg.pipes.push(STORABLE_TEXT_PIPE);
        }
      }
    }
  }
}
