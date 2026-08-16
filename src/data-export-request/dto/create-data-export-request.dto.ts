/**
 * POST /settings/privacy/export takes no body per the frozen contract
 * (registry.json § DataExportRequest has no `body` on the endpoint) — the
 * export is always "export everything for the authenticated user". This
 * empty DTO exists only so the global ValidationPipe's
 * `forbidNonWhitelisted: true` rejects any stray field a client sends
 * (conventions.md § Validation) rather than silently ignoring it.
 */
export class CreateDataExportRequestDto {}
