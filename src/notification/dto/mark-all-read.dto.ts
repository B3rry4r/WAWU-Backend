/**
 * POST /notifications/mark-all-read takes no body per registry.json (no
 * `body` key on the endpoint). This empty DTO exists purely so the global
 * `ValidationPipe({ forbidNonWhitelisted: true })` rejects any stray field a
 * client sends with a 400, rather than silently ignoring it.
 */
export class MarkAllReadDto {}
