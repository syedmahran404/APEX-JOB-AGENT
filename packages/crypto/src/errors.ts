// @apex/shared-errors is itself a dependency of @apex/crypto. We use a
// dependency-light internal error here that the gateway layer can map.

export class CryptoError extends globalThis.Error {
  public readonly code: 'auth_fail' | 'invalid_input' | 'unsupported_version';

  constructor(code: 'auth_fail' | 'invalid_input' | 'unsupported_version', message: string) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
    Object.setPrototypeOf(this, CryptoError.prototype);
  }
}
