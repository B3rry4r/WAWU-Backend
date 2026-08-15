import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../auth/wawu-jwt-claims.interface';

/** @CurrentUser() param decorator — pulls the verified WAWU ID claims off the request. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): WawuJwtClaims => {
  const request = ctx.switchToHttp().getRequest<Request & { user: WawuJwtClaims }>();
  return request.user;
});
