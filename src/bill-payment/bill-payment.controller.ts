import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { BillPaymentService } from './bill-payment.service';
import {
  InitBillDto,
  ListBillersQueryDto,
  ValidateCustomerDto,
  VerifyBillDto,
} from './dto/bill.dto';

/**
 * WAWUPay. Browsing the biller catalogue still requires a signed-in account:
 * these calls cost money on our Flutterwave contract, so they are not left
 * open to anonymous traffic.
 */
@UseGuards(WawuAuthGuard)
@Controller('bills')
export class BillPaymentController {
  constructor(private readonly bills: BillPaymentService) {}

  @Get('categories')
  categories(@Query() query: ListBillersQueryDto) {
    return this.bills.listCategories(query.country ?? 'NG');
  }

  @Get('categories/:category/billers')
  billers(
    @Param('category') category: string,
    @Query() query: ListBillersQueryDto,
  ) {
    return this.bills.listBillers(category, query.country ?? 'NG');
  }

  @Get('billers/:billerCode/items')
  items(@Param('billerCode') billerCode: string) {
    return this.bills.listItems(billerCode);
  }

  /** Confirms a meter/smartcard/phone before the payer spends money on a typo. */
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  validate(@Body() dto: ValidateCustomerDto) {
    return this.bills.validateCustomer(dto.itemCode, dto.customer);
  }

  @Post('init')
  @HttpCode(HttpStatus.OK)
  init(@CurrentUser() user: WawuJwtClaims, @Body() dto: InitBillDto) {
    return this.bills.init(user.sub, dto);
  }

  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  verify(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id') id: string,
    @Body() dto: VerifyBillDto,
  ) {
    return this.bills.verifyAndDeliver(user.sub, id, dto.transactionId);
  }

  @Get('mine')
  mine(@CurrentUser() user: WawuJwtClaims) {
    return this.bills.listMine(user.sub, 1, 50);
  }

  /**
   * BILLS-09 (R-102): where a bill stands, with its token and units. The buyer's
   * own bills only. A `processing` bill is asked about at the provider at most
   * once in 20 seconds. The id is a UUID so `GET /bills/wallet/status` and the
   * like keep answering exactly what the wallet bill route answered before this
   * route existed (the same 400 from the same pipe on `id`).
   */
  @Get(':id/status')
  status(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bills.statusOf(user.sub, id);
  }
}
