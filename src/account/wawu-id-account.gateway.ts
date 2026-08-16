/**
 * Outbound gateway for orchestrating WAWU ID's own account deletion
 * alongside this backend's 48h grace-period marker (registry.json Account
 * endpoint note: "this backend mirrors that grace-period idea for its own
 * data, then calls WAWU ID's account deletion separately"). Declared as an
 * interface + DI token (conventions.md's "external calls behind an
 * interface so contract tests can stub them" rule) rather than importing
 * the shared WawuIdClient (src/common/auth/wawu-id.client.ts), which is
 * common/-owned and out of this resource's edit scope, and doesn't expose
 * a deletion method today.
 */
export interface WawuIdAccountGateway {
  scheduleAccountDeletion(wawuUserId: string): Promise<{ scheduled: boolean }>;
}

export const WAWU_ID_ACCOUNT_GATEWAY = Symbol('WAWU_ID_ACCOUNT_GATEWAY');
