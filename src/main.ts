import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());
  app.use(compression());
  app.use(cookieParser());
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true, credentials: true });

  app.setGlobalPrefix('api/hub');

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
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
bootstrap();
