import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { MoviesController } from './movies.controller';
import { MoviesService } from './movies.service';

/**
 * Flix movies (FLIX-01): `movies`, `movies/browse`, `movies/filters`,
 * `movies/search`, `movies/:movieId` and `movies/:movieId/watch`. Mounting it
 * in AppModule is SHARED-CHANGES FLIX-01 #1.
 */
@Module({
  imports: [WawuAuthModule],
  controllers: [MoviesController],
  providers: [MoviesService],
})
export class MoviesModule {}
