import { Controller, Get, Param } from '@nestjs/common';
import { AboutSettings } from './about-settings';
import type { AboutView, PolicyListView, PolicyView } from './about-view.type';
import { PoliciesService } from './policies.service';

/**
 * SETTINGS-02, LEGAL-DOCS. Public on purpose: the owner's legal documents (the
 * Terms, the Privacy policy and seven more) have to be readable before anyone
 * has an account, and About carries nothing personal.
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

  /**
   * The published documents in the owner's order: slug, title and effective
   * date, no text. Empty until the owner has published one.
   */
  @Get('policies')
  policyList(): Promise<PolicyListView> {
    return this.policies.list();
  }

  /** One of the nine slugs; `available: false` until the owner fills it in. */
  @Get('policies/:slug')
  policy(@Param('slug') slug: string): Promise<PolicyView> {
    return this.policies.get(slug);
  }
}
