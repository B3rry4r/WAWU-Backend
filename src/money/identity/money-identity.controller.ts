import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { BuiltBy, MoneyErrors } from '../money-contract';
import {
  BvnCheckDto,
  IdentityOccupationDto,
  SelfieMatchDto,
} from './dto/identity-request.dto';
import { BVN_CHECK_THROTTLE } from './identity-config';
import type {
  BvnCheckView,
  SelfieMatchView,
  WalletIdentityView,
} from './identity-view.type';
import { SelfieMatchService } from './selfie-match.service';
import { WalletIdentityService } from './wallet-identity.service';

/**
 * Open your wallet's identity step (task KYC-01, R-6): the BVN check on A26,
 * A14 when the BVN's phone is not the account's, A5's prefill, and the
 * occupation typed on A5. Then the selfie (task KYC-02, A6, A7, A16): a face
 * match against the BVN photo, not a liveness check.
 *
 * The caller is the token: no route takes a wawuUserId, so nobody can run or
 * read another person's check. Every answer is `no-store`: the prefill is a
 * person's identity and must not sit in any cache between here and the app.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money/identity')
export class MoneyIdentityController {
  constructor(
    private readonly identity: WalletIdentityService,
    private readonly selfie: SelfieMatchService,
  ) {}

  /** Where the person's identity step stands: last 4 digits only, and checks left today. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @BuiltBy('KYC-01')
  get(@CurrentUser() user: WawuJwtClaims): Promise<WalletIdentityView> {
    return this.identity.view(user.sub);
  }

  /**
   * Checks the BVN with Fintava (charged per check) and keeps the NIN given
   * with it for account opening. The BVN's phone must be the account's phone
   * (A14: `bvn_phone_mismatch`). On a pass, answers A5's prefill once; it is
   * not stored. Limited per person per day (`identity_checks_exhausted`) and
   * per address by the app's throttler.
   */
  @Post('bvn')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle(BVN_CHECK_THROTTLE)
  @BuiltBy('KYC-01')
  @MoneyErrors(
    'bvn_not_confirmed',
    'bvn_phone_mismatch',
    'phone_not_nigerian',
    'identity_checks_exhausted',
    'wallet_already_open',
    'provider_unreachable',
  )
  checkBvn(
    @CurrentUser() user: WawuJwtClaims,
    @Body() body: BvnCheckDto,
  ): Promise<BvnCheckView> {
    return this.identity.checkBvn(user.sub, user.phone, body);
  }

  /** The selfie step: whether the selfie has matched the BVN photo, and matches left today. */
  @Get('selfie')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('KYC-02')
  getSelfie(@CurrentUser() user: WawuJwtClaims): Promise<SelfieMatchView> {
    return this.selfie.view(user.sub);
  }

  /**
   * A6: matches the selfie against the BVN record's photo with Fintava
   * (charged per match, a failed one too). A face match, not a liveness
   * check. Needs a passed BVN check, and the BVN it passed with
   * (`bvn_not_checked` otherwise). A failed match is A16
   * (`selfie_not_matched`, with matches left today); the fourth in 24 hours
   * is `selfie_checks_exhausted`, and Fintava is not asked. Only an explicit
   * match from Fintava passes: an answer with no verdict is
   * `provider_unreachable` and still counts. A match counts only for the
   * BVN check it was compared against (`bvn_not_checked` if another check
   * passed meanwhile). Neither the
   * selfie nor the BVN photo is stored or logged. Limited per address by the
   * app's throttler, as the BVN check is.
   */
  @Post('selfie')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle(BVN_CHECK_THROTTLE)
  @BuiltBy('KYC-02')
  @MoneyErrors(
    'selfie_not_matched',
    'selfie_checks_exhausted',
    'selfie_already_matched',
    'bvn_not_checked',
    'wallet_already_open',
    'provider_unreachable',
  )
  matchSelfie(
    @CurrentUser() user: WawuJwtClaims,
    @Body() body: SelfieMatchDto,
  ): Promise<SelfieMatchView> {
    return this.selfie.match(user.sub, body);
  }

  /** A5: stores the occupation the person typed. Needs a passed BVN check first. */
  @Put('occupation')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('KYC-01')
  @MoneyErrors('bvn_not_checked')
  setOccupation(
    @CurrentUser() user: WawuJwtClaims,
    @Body() body: IdentityOccupationDto,
  ): Promise<WalletIdentityView> {
    return this.identity.setOccupation(user.sub, body.occupation);
  }
}
