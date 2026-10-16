import { Controller, Get, Param } from '@nestjs/common';
import { AboutSettings } from './about-settings';
import type { AboutView, PolicyView } from './about-view.type';
import { PoliciesService } from './policies.service';

/**
 * SETTINGS-02. Public on purpose: the Terms and the Privacy policy have to be
 * readable before anyone has an account, and About carries nothing personal.
 * `about` and `policies` are first segments no other controller uses.
 */
@Controller()
export class AboutController {
  constructor(
    private readonly settings: AboutSettings,
    private readonly policies: PoliciesService,
  ) {}

  /** The bank, the licence line and the support address, from config. */
  @Get('about')
  about(): AboutView {
    return this.settings.view();
  }

  /** `terms` or `privacy`; `available: false` until the owner fills it in. */
  @Get('policies/:slug')
  policy(@Param('slug') slug: string): Promise<PolicyView> {
    return this.policies.get(slug);
  }
}
