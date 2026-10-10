import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { MeterPreviewDto } from './bills-catalogue.dto';
import { BillsCatalogueService } from './bills-catalogue.service';
import type {
  ElectricityBillersView,
  MeterPreviewView,
} from './bills-catalogue.views';

/**
 * Choosing a bill in the app (BILLS-01, S2 to S4, S10, S13): the electricity companies Fintava lists and the name on a
 * meter. Signed in, no wallet needed to browse (the wallet is asked for at Pay, BILLS-02). Both literal paths sit under
 * `bills/electricity/`, so neither is read as the web's `bills/:id/verify`. The web's Flutterwave routes under `bills`
 * are untouched.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('bills/electricity')
export class BillsCatalogueController {
  constructor(private readonly bills: BillsCatalogueService) {}

  /**
   * S2 and S3. Every company Fintava lists as available, one row per company and plan, each with its own minimum and
   * maximum in kobo and the quick amounts that fit them. `available: false` is S13: Fintava lists none, or its bills
   * service cannot be used. Fintava not answering at all is `503 provider_unreachable`, with `retryAfterSeconds`.
   */
  @Get('billers')
  @ApiResponse({
    status: 503,
    description:
      'reason.code provider_unreachable: Fintava did not answer. Try again after retryAfterSeconds.',
  })
  billers(): Promise<ElectricityBillersView> {
    return this.bills.electricityBillers();
  }

  /**
   * S4 and S10. The name and address Fintava holds for a meter. 422 `meter_not_found` is S10. 404 `biller_not_found` is a
   * `code` that is not on the list now. 503 `bills_unavailable` is S13. 429 `bills_rate_limited` carries
   * `retryAfterSeconds` (and `Retry-After`). Answers are `no-store`: they name someone else.
   */
  @Post('meter-preview')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiResponse({
    status: 404,
    description:
      'reason.code biller_not_found: the code is not on the list now.',
  })
  @ApiResponse({
    status: 422,
    description:
      'reason.code meter_not_found: Fintava does not know this meter for this company.',
  })
  @ApiResponse({
    status: 429,
    description: 'reason.code bills_rate_limited, with retryAfterSeconds.',
  })
  @ApiResponse({
    status: 503,
    description:
      'reason.code bills_unavailable (bills are not switched on) or provider_unreachable (Fintava did not answer).',
  })
  meterPreview(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: MeterPreviewDto,
  ): Promise<MeterPreviewView> {
    return this.bills.previewMeter(user.sub, dto);
  }
}
