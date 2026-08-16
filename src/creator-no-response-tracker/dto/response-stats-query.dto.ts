/**
 * GET /dm/response-stats takes no query params (registry.json — no `query`
 * array on this endpoint). Bound as a typed, empty DTO purely so the global
 * `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` has a
 * metatype to validate against — any stray query param is then a genuine
 * 400, matching conventions.md § Validation ("agents never hand-roll
 * payload checks in a service method").
 */
export class ResponseStatsQueryDto {}
