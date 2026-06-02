// @apex/vault-client — typed Vault Transit client + lease/redeem helpers.
//
// In production this talks to a HashiCorp Vault HA cluster; in dev/self-host
// it talks to the same HTTP API exposed by Vault dev mode (compose/dev) or
// production-mode file storage (compose/selfhost).

export { createVaultHttp, type VaultClientOptions, type VaultHttp } from './client.js';
export {
  wrapDek,
  unwrapDek,
  dekFromUnwrap,
  type TransitWrapInput,
  type TransitWrapOutput,
  type TransitUnwrapInput,
} from './transit.js';
export {
  LeaseRequest,
  LeaseResponse,
  RedeemRequest,
  RedeemResponse,
  type LeaseRequest as LeaseRequestType,
  type LeaseResponse as LeaseResponseType,
  type RedeemRequest as RedeemRequestType,
  type RedeemResponse as RedeemResponseType,
} from './lease.js';
