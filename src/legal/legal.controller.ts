import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { LegalRequestsService } from './legal.service';
import {
  BookConsultationDto,
  CreateLegalRequestDto,
  SignContractDto,
  VerifyPaymentDto,
} from './dto/legal.dto';

/**
 * WAWU Legal.
 *
 * The route order mirrors the flow a client walks: browse the catalogue,
 * open a request, book and pay for a consultation if the service needs one,
 * read and sign the engagement letter, then pay for the work.
 */
@UseGuards(WawuAuthGuard)
@Controller('legal')
export class LegalController {
  constructor(private readonly legal: LegalRequestsService) {}

  /** When a lawyer is free. Drives the booking calendar. */
  @Get('availability')
  availability() {
    return this.legal.availability();
  }

  @Get('catalogue')
  catalogue() {
    return this.legal.catalogue();
  }

  @Post('requests')
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: WawuJwtClaims, @Body() dto: CreateLegalRequestDto) {
    return this.legal.create(user.sub, dto);
  }

  @Get('requests')
  mine(@CurrentUser() user: WawuJwtClaims) {
    return this.legal.listMine(user.sub);
  }

  @Get('requests/:id')
  one(@CurrentUser() user: WawuJwtClaims, @Param('id') id: string) {
    return this.legal.getMine(user.sub, id);
  }

  @Post('requests/:id/consultation')
  @HttpCode(HttpStatus.OK)
  book(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id') id: string,
    @Body() dto: BookConsultationDto,
  ) {
    return this.legal.bookConsultation(user.sub, id, dto);
  }

  @Post('requests/:id/consultation/verify')
  @HttpCode(HttpStatus.OK)
  verifyConsultation(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id') id: string,
    @Body() dto: VerifyPaymentDto,
  ) {
    return this.legal.verifyConsultationPayment(user.sub, id, dto.transactionId);
  }

  /** The exact text the client is about to sign. */
  @Get('requests/:id/contract')
  contract(@CurrentUser() user: WawuJwtClaims, @Param('id') id: string) {
    return this.legal.contractPreview(user.sub, id);
  }

  @Post('requests/:id/contract/sign')
  @HttpCode(HttpStatus.OK)
  sign(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id') id: string,
    @Body() dto: SignContractDto,
    @Ip() ip: string,
  ) {
    return this.legal.signContract(user.sub, id, dto.fullName, ip);
  }

  @Post('requests/:id/payment/init')
  @HttpCode(HttpStatus.OK)
  initPayment(@CurrentUser() user: WawuJwtClaims, @Param('id') id: string) {
    return this.legal.initServicePayment(user.sub, id);
  }

  @Post('requests/:id/payment/verify')
  @HttpCode(HttpStatus.OK)
  verifyPayment(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id') id: string,
    @Body() dto: VerifyPaymentDto,
  ) {
    return this.legal.verifyServicePayment(user.sub, id, dto.transactionId);
  }
}
