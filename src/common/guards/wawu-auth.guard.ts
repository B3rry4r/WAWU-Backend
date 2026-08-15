import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** "Any authenticated WAWU user" guard. @UseGuards(WawuAuthGuard) on any endpoint requiring login. */
@Injectable()
export class WawuAuthGuard extends AuthGuard('wawu-jwt') {}
