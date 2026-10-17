import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HUB_APP_OPTIONS } from './hub-app-options';
import { configureHubApp } from './hub-app-config';

async function bootstrap() {
  // rawBody: true, for the Fintava webhook signature (src/hub-app-options.ts).
  const app = await NestFactory.create(AppModule, HUB_APP_OPTIONS);
  // Everything the Hub sets on its app, in one place a spec shares
  // (src/hub-app-config.ts). Nothing else may run before app.listen(), and
  // never app.init(): Nest reads each route's arguments when it inits, so the
  // storable-text check (FIX-17) has to be in before it.
  configureHubApp(app);

  // NOTE: deliberately NOT reading process.env.PORT — this sandbox has a
  // global PORT=8080 reserved (observed at boot time, reserved for the
  // frontend's dev server / platform preview). Using a dedicated var name
  // avoids the collision entirely.
  const port = process.env.HUB_API_PORT ?? 3001;
  await app.listen(port);
  console.log(`WAWU Hub API listening on :${port} (prefix /api/hub)`);
}
void bootstrap();
