import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../generated/prisma/client';

/**
 * Standard NestJS-idiomatic PrismaClient wrapper. Every Phase-5 build agent
 * injects this rather than instantiating PrismaClient directly (conventions.md
 * § ORM / database — the schema agent owns prisma/schema.prisma and this
 * shared client exclusively).
 *
 * Prisma 7's generated client (provider = "prisma-client") requires a driver
 * adapter — there is no more implicit connection from a `url` in the
 * datasource block. We use `@prisma/adapter-pg` against the same
 * DATABASE_URL every other part of this backend already reads from env
 * (conventions.md § ORM / database).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }
}
