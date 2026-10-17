// Types for the parts of the vendored noble bundle (noble.js) this plugin uses.
// Narrower than noble's own declarations on purpose: only what tap1.ts calls.

type Bytes = Uint8Array

export declare const x25519: {
  getPublicKey(privateKey: Bytes): Bytes
  getSharedSecret(privateKey: Bytes, publicKey: Bytes): Bytes
  utils: { randomPrivateKey(): Bytes }
}

export declare const ed25519: {
  getPublicKey(privateKey: Bytes): Bytes
  sign(message: Bytes, privateKey: Bytes): Bytes
  verify(signature: Bytes, message: Bytes, publicKey: Bytes, options?: { zip215?: boolean }): boolean
  utils: { randomPrivateKey(): Bytes }
}

export declare const p256: {
  verify(signature: Bytes, messageHash: Bytes, publicKey: Bytes, options?: { lowS?: boolean; prehash?: boolean; format?: 'der' | 'compact' }): boolean
}

type Hash = { (message: Bytes): Bytes; outputLen: number; blockLen: number }

export declare const sha256: Hash
export declare const sha512: Hash
export declare function hkdf(hash: Hash, ikm: Bytes, salt: Bytes | undefined, info: Bytes | undefined, length: number): Bytes
export declare function hmac(hash: Hash, key: Bytes, message: Bytes): Bytes
export declare function gcm(key: Bytes, nonce: Bytes, aad?: Bytes): {
  encrypt(plaintext: Bytes): Bytes
  decrypt(ciphertext: Bytes): Bytes
}
