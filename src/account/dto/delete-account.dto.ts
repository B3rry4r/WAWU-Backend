/**
 * DELETE /account takes no request body per registry.json (Account resource
 * has no documented request shape). Declared anyway so the global
 * ValidationPipe ({ whitelist: true, forbidNonWhitelisted: true }) rejects
 * any stray body field with a 400 instead of silently ignoring it.
 */
export class DeleteAccountDto {}
