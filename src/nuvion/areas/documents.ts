import type {
  ProviderKycState,
  ProviderLivenessResult,
  ProviderLivenessSession,
  ProviderSelfieResult,
  WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type { NuvionClient } from '../nuvion-client';
import { rejectNotSupported } from './not-supported';

const AREA = 'documents (NUV-03)';

/**
 * The ID document, the proof of address and the hosted selfie, then the
 * onboarding submission for Nuvion's review (task NUV-03, R-42: ID document
 * and proof of address at opening; R-39: Nuvion's hosted selfie if its API
 * can start one, else no selfie). The lead's scratchpad
 * `nuvion/docs/api-reference__entities.md` (`POST /documents`,
 * `POST /onboarding-submissions`) and `SANDBOX-FINDINGS.md` item 4
 * (`POST /kyc/liveness/sessions`). This file is NUV-03's alone.
 *
 * `matchSelfie` stays `not_supported`: Nuvion matches no selfie against a
 * BVN photo (capabilities.selfieMatch is false). The others answer
 * `not_supported` (nothing is sent) until NUV-03 gives them their calls,
 * and NUV-03 turns capabilities.hostedLiveness on when the hosted selfie
 * works for a child entity.
 */
/** The WalletProvider methods this area answers for the adapter. */
export type NuvionDocumentsMethods = Pick<
  WalletProvider,
  'matchSelfie' | 'startLivenessSession' | 'getLivenessResult' | 'submitKyc'
>;

export class NuvionDocumentsArea implements NuvionDocumentsMethods {
  constructor(readonly client: NuvionClient) {}

  matchSelfie(): Promise<ProviderSelfieResult> {
    return rejectNotSupported('match selfie', AREA);
  }

  startLivenessSession(): Promise<ProviderLivenessSession> {
    return rejectNotSupported('start liveness session', AREA);
  }

  getLivenessResult(): Promise<ProviderLivenessResult> {
    return rejectNotSupported('get liveness result', AREA);
  }

  submitKyc(): Promise<ProviderKycState> {
    return rejectNotSupported('submit KYC', AREA);
  }
}
