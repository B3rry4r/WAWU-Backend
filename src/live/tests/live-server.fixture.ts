// A real Hub process for the shutdown test (task INBOX-02): the live module
// with its dependencies, started the way main.ts starts the app (no
// enableShutdownHooks). Not a test itself. It listens on LIVE_FIXTURE_PORT,
// which the test sets to 0 so the operating system picks a free port, and
// prints "listening on <port>" with the port it really got.
import { ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'net';
import { Module } from '@nestjs/common';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { LiveModule } from '../live.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    WawuAuthModule,
    BlockedAccountModule,
    LiveModule,
  ],
})
class FixtureModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  await app.listen(Number(process.env.LIVE_FIXTURE_PORT ?? 0));
  const { port } = (
    app.getHttpServer() as { address(): unknown }
  ).address() as AddressInfo;
  console.log(`listening on ${port}`);
}
void bootstrap();
