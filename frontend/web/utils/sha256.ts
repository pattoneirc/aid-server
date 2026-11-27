import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}

/** Keep the digest identical when Web Crypto is unavailable on an HTTP origin. */
export async function digestSha256Hex(input: Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const subtle = globalThis.crypto?.subtle
  if (subtle && bytes.buffer instanceof ArrayBuffer) {
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', view)))
  }
  return sha256Hex(bytes)
}
