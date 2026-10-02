import { pinEnvironment } from './harness';

/**
 * Imported FIRST by the protected route spec, before AppModule: a few modules
 * read their configuration into constants when they are loaded, so pinning in
 * `beforeAll` would be too late for them.
 */
export const restorePinnedEnvironment = pinEnvironment();
