/**
 * POST /dm/:messageId/report takes no body per the frozen contract
 * (registry.json § DmReport has no `body` on the endpoint) — the report is
 * always "the authenticated user reports the thread identified by the
 * :messageId path param". This empty DTO exists only so the global
 * ValidationPipe's `forbidNonWhitelisted: true` rejects any stray field a
 * client sends (conventions.md § Validation) rather than silently ignoring
 * it.
 */
export class CreateDmReportDto {}
