import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { applyHubHttpSettings, HUB_APP_OPTIONS } from './hub-app-options';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { checkStorableTextOnEveryRoute } from './storable-text/storable-text.pipe';

async function bootstrap() {
  // rawBody: true, for the Fintava webhook signature (src/hub-app-options.ts).
  const app = await NestFactory.create(AppModule, HUB_APP_OPTIONS);
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
  // (src/storable-text/storable-text.pipe.ts). Before app.listen(): Nest
  // reads each route's arguments when it builds the router.
  checkStorableTextOnEveryRoute(app);
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  // NOTE: deliberately NOT reading process.env.PORT — this sandbox has a
  // global PORT=8080 reserved (observed at boot time, reserved for the
  // frontend's dev server / platform preview). Using a dedicated var name
  // avoids the collision entirely.
  const port = process.env.HUB_API_PORT ?? 3001;
  await app.listen(port);
  console.log(`WAWU Hub API listening on :${port} (prefix /api/hub)`);
}
void bootstrap();
