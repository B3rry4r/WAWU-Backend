import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { FlixoraMoviePartner } from '../flixora/flixora-movie-partner';
import {
  MOVIE_PARTNER_CONFIG_KEY,
  readMoviePartnerName,
  selectMovieAdapter,
} from './movie-partner-config';
import { MOVIE_PARTNER, type MoviePartner } from './movie-partner.interface';
import { OffMoviePartner } from './off-movie-partner';
import { SoonMoviePartner } from './soon-movie-partner';
import { StandinMoviePartner } from './standin/standin-movie-partner';

/**
 * The movie partner seam's wiring (FLIX-01): the only place that knows which
 * adapters exist. Every movie module imports this one and injects
 * `MOVIE_PARTNER`; none imports an adapter. `MOVIE_PARTNER` picks the adapter
 * at boot (`off` by default); changing it is a setting and a restart. The
 * real adapter (`flixora`, FLIX-02) is added here, and only here: this is the
 * one file outside `src/flixora/` that imports it. A `flixora` server with a
 * setting missing stops at boot, naming the setting.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: MOVIE_PARTNER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MoviePartner =>
        selectMovieAdapter<MoviePartner>(
          readMoviePartnerName(config.get<string>(MOVIE_PARTNER_CONFIG_KEY)),
          {
            off: () => new OffMoviePartner(),
            soon: () => new SoonMoviePartner(),
            standin: () => new StandinMoviePartner(),
            flixora: () =>
              FlixoraMoviePartner.fromConfig((key) => config.get<string>(key)),
          },
        ),
    },
  ],
  exports: [MOVIE_PARTNER],
})
export class MoviePartnerModule {}
