import { INestApplication, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { applyHubHttpSettings } from './hub-app-options';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { checkStorableTextOnEveryRoute } from './storable-text/storable-text.pipe';

/**
 * Everything the Hub does to its app between creating it and listening
 * (FIX-17, D1). `src/main.ts` calls this and nothing else before
 * `app.listen()`, and a spec that must answer as the Hub does builds its app
 * the same way, so the two cannot drift: the storable-text check, the
 * ValidationPipe, the filter and the interceptor sit in this one function.
 *
 * Call it once, right after the app is created and BEFORE `app.init()` or
 * `app.listen()`: Nest reads each handler's arguments when it builds the
 * router, so a check added later is silently not there and a NUL answers 500
 * on every route (src/storable-text/tests pin that this file is called first
 * and that main.ts never calls `init()` itself).
 */
export function configureHubApp(app: INestApplication): void {
  // `trust proxy`: one nginx hop on loopback, so the rate limits count each
  // caller, not nginx (src/hub-app-options.ts, task OPS-11).
  applyHubHttpSettings(app);

  app.use(helmet());
  app.use(compression());
  app.use(cookieParser());
  // `origin: true` reflects whatever Origin the caller sends. Combined with
  // credentials that is a production footgun, so in production an explicit
  // CORS_ORIGIN allowlist is required; other environments keep the permissive
  // default for local tooling.
  const corsOrigin = process.env.CORS_ORIGIN?.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (
    process.env.NODE_ENV === 'production' &&
    (!corsOrigin || corsOrigin.length === 0)
  ) {
    throw new Error(
      'CORS_ORIGIN must list the allowed origins in production. Refusing to start with a reflect-any-origin CORS policy.',
    );
  }
  app.enableCors({ origin: corsOrigin ?? true, credentials: true });

  app.setGlobalPrefix('api/hub');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // FIX-17: a query or path value Postgres cannot take (a NUL) is a 400
  // naming the field, on every route, after every other check of that value
  // (src/storable-text/storable-text.pipe.ts).
  checkStorableTextOnEveryRoute(app);
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
}
