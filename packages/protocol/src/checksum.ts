const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }

  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const value of bytes) {
    crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function xorPayloads(payloads: Uint8Array[]): Uint8Array {
  const maxLength = payloads.reduce((max, payload) => Math.max(max, payload.length), 0);
  const parity = new Uint8Array(maxLength);

  for (const payload of payloads) {
    for (let index = 0; index < maxLength; index += 1) {
      parity[index] ^= payload[index] ?? 0;
    }
  }

  return parity;
}
