import type {
  ProviderCustomerLookup,
  ProviderCustomerMatch,
  ProviderCustomerSighting,
  ProviderIdentity,
  ProviderOpenedWallet,
  ProviderPage,
  WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type { NuvionClient } from '../nuvion-client';
import { rejectNotSupported } from './not-supported';

const AREA = 'opening (NUV-02)';

/**
 * Opening a wallet on Nuvion: the person as an individual entity with their
 * BVN and NIN, Nuvion's review, approved or rejected (task NUV-02, the
 * lead's scratchpad `nuvion/docs/core-concepts__entities.md`,
 * `api-reference__entities.md`). This file is NUV-02's alone: the adapter
 * (nuvion-wallet-provider.ts) only delegates here, so NUV-02 fills these
 * methods without touching any other Nuvion file.
 *
 * `checkIdentity` stays `not_supported`: Nuvion has no standalone BVN
 * lookup (capabilities.identityLookup is false); the BVN and NIN are
 * checked inside Nuvion's review of the entity. Every other method answers
 * `not_supported` (nothing is sent) until NUV-02 gives it its calls.
 */
/** The WalletProvider methods this area answers for the adapter. */
export type NuvionOpeningMethods = Pick<
  WalletProvider,
  | 'checkIdentity'
  | 'openWallet'
  | 'findCustomerByPhone'
  | 'getCustomerMatch'
  | 'listCustomerSightings'
>;

export class NuvionOpeningArea implements NuvionOpeningMethods {
  constructor(readonly client: NuvionClient) {}

  checkIdentity(): Promise<ProviderIdentity> {
    return rejectNotSupported('check identity', AREA);
  }

  openWallet(): Promise<ProviderOpenedWallet> {
    return rejectNotSupported('open wallet', AREA);
  }

  findCustomerByPhone(): Promise<ProviderCustomerLookup> {
    return rejectNotSupported('find customer by phone', AREA);
  }

  getCustomerMatch(): Promise<ProviderCustomerMatch> {
    return rejectNotSupported('get customer match', AREA);
  }

  listCustomerSightings(): Promise<ProviderPage<ProviderCustomerSighting>> {
    return rejectNotSupported('list customer sightings', AREA);
  }
}
