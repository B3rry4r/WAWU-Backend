import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { WawuAuthModule } from './common/auth/wawu-auth.module';
import { PrismaModule } from './common/prisma/prisma.module';
// SEAM: Phase 5 resource modules register here, one import line each,
// per conventions.md § Naming & layout "Registration entry".

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
