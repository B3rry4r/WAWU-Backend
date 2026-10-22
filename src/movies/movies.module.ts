import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccountPurgeModule } from '../account-purge/account-purge.module';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { MoviePartnerModule } from '../movie-partner/movie-partner.module';
import { MovieSyncService } from './movie-sync.service';
import { MoviesController } from './movies.controller';
import { MoviesService } from './movies.service';
import { MoviesPurgeService } from './movies-purge.service';

/**
 * Flix movies (FLIX-01): `movies`, `movies/browse`, `movies/filters`,
 * `movies/search`, `movies/:movieId` and `movies/:movieId/watch`. Reaches the
 * partner only through the `MOVIE_PARTNER` seam (MoviePartnerModule). Mounting
 * it in AppModule is SHARED-CHANGES FLIX-01 #1.
 */
@Module({
  imports: [
    ConfigModule,
    WawuAuthModule,
    MoviePartnerModule,
    AccountPurgeModule,
  ],
  controllers: [MoviesController],
  providers: [MoviesService, MovieSyncService, MoviesPurgeService],
  exports: [MovieSyncService],
})
export class MoviesModule {}
