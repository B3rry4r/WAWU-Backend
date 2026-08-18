import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
}
