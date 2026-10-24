import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { openingAddressOf } from '../identity/identity-config';
import { BuiltBy, MoneyErrors } from '../money-contract';
import type { WalletView } from '../money-view.type';
import { WalletOpeningService } from '../opening/wallet-opening.service';
import {
  WorldFirstAccountDto,
  WorldOptionsQueryDto,
} from './dto/world-request.dto';
import { WorldWalletService } from './world-wallet.service';
import type { WorldCountriesView, WorldOptionsView } from './world-view.type';

/**
 * A wallet for a person outside Nigeria (task WALLET-41, R-87). Opening is
 * `POST /money/wallet/open` with a `countryCode` other than NG; these two
 * routes are what sits around it. Neither needs a wallet: they are where a
 * person without one is led (docs/contract/CONVENTIONS.md section 31).
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money/world')
export class WorldController {
  constructor(
    private readonly world: WorldWalletService,
    private readonly opening: WalletOpeningService,
  ) {}

  /**
   * The countries a person can say they live in, with English names. Nigeria
   * is among them. Until GEO-02's list lands this is the app's picker.
   */
  @Get('countries')
  @Header('Cache-Control', 'public, max-age=86400')
  @BuiltBy('WALLET-41')
  @MoneyErrors()
  countries(): WorldCountriesView {
    return this.world.countries();
  }

  /**
   * What a person living in a country is offered before they open: whether a
   * wallet can be opened from there now, the currency their country is
   * first offered, every currency the first account can be in, and what
   * WAWU charges to open (default 0). Reads config and the admin switches
   * only; the provider is not called.
   */
  @Get('options')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-41')
  @MoneyErrors()
  options(@Query() query: WorldOptionsQueryDto): Promise<WorldOptionsView> {
    return this.world.options(query.country);
  }

  /**
   * Opens the first account of a person Nuvion approved, when its own
   * notice has not (yet). Safe to repeat: one first account per person.
   * `currency` changes the first currency while no account is open (the
   * provider may decline a country's own, with its reason in `message`).
   * Answers the wallet as `GET /money/wallet` does; `world.state` `open`
   * says it is done, `opening` that Nuvion has not approved yet or has not
   * answered. A refusal in the provider's own words is `provider_declined`.
   */
  @Post('first-account')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-41')
  @MoneyErrors(
    'currency_not_supported',
    'fx_switched_off',
    'provider_declined',
    'provider_unreachable',
  )
  async firstAccount(
    @CurrentUser() user: WawuJwtClaims,
    @Req() req: Record<string, unknown>,
    @Body() dto?: WorldFirstAccountDto,
  ): Promise<WalletView> {
    await this.world.ensureFirstAccount(user.sub, dto?.currency);
    return this.opening.view(user.sub, openingAddressOf(req));
  }
}
