import { sha256Hex } from "@airt2/protocol";

export type CompressionMode = "none" | "gzip";

export interface QrManifest {
  type: "manifest";
  version: 1;
  sessionId: string;
  name: string;
  mimeType: string;
  originalSize: number;
  compressedSize: number;
  compression: CompressionMode;
  totalShards: number;
  shardSize: number;
  hash: string;
}

export interface QrShard {
  type: "shard";
  version: 1;
  sessionId: string;
  index: number;
  totalShards: number;
  payload: string;
}

export interface PreparedQrTransfer {
  manifest: QrManifest;
  manifestText: string;
  shardTexts: string[];
}

export interface ReceiverSession {
  manifest: QrManifest;
  shards: Array<Uint8Array | null>;
  received: Set<number>;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function generateSessionId(): string {
  const value = crypto.getRandomValues(new Uint32Array(1))[0];
  return value.toString(16).padStart(8, "0");
}

export async function prepareQrTransfer(options: {
  bytes: Uint8Array;
  name: string;
  mimeType: string;
  compression: CompressionMode;
  originalSize: number;
  shardSize?: number;
}): Promise<PreparedQrTransfer> {
  const shardSize = options.shardSize ?? 32;
  const totalShards = Math.ceil(options.bytes.length / shardSize);
  const manifest: QrManifest = {
    type: "manifest",
    version: 1,
    sessionId: generateSessionId(),
    name: options.name,
    mimeType: options.mimeType,
    originalSize: options.originalSize,
    compressedSize: options.bytes.length,
    compression: options.compression,
    totalShards,
    shardSize,
    hash: await sha256Hex(options.bytes)
  };

  const shardTexts = Array.from({ length: totalShards }, (_, index) => {
    const start = index * shardSize;
    const payload = options.bytes.slice(start, Math.min(options.bytes.length, start + shardSize));
    const shard: QrShard = {
      type: "shard",
      version: 1,
      sessionId: manifest.sessionId,
      index,
      totalShards,
      payload: bytesToBase64Url(payload)
    };
    return [
      "D",
      "1",
      shard.sessionId,
      shard.index.toString(36),
      shard.totalShards.toString(36),
      shard.payload
    ].join("|");
  });

  return {
    manifest,
    manifestText: [
      "M",
      "1",
      manifest.sessionId,
      encodeURIComponent(manifest.name),
      encodeURIComponent(manifest.mimeType),
      manifest.originalSize.toString(36),
      manifest.compressedSize.toString(36),
      manifest.compression === "gzip" ? "g" : "n",
      manifest.totalShards.toString(36),
      manifest.shardSize.toString(36),
      manifest.hash
    ].join("|"),
    shardTexts
  };
}

export function parseQrPayload(
  text: string
): { manifest?: QrManifest; shard?: { sessionId: string; index: number; totalShards: number; bytes: Uint8Array } } | null {
  try {
    const parts = text.split("|");
    if (parts.length < 2) {
      return null;
    }

    if (parts[0] === "M" && parts[1] === "1" && parts.length === 11) {
      return {
        manifest: {
          type: "manifest",
          version: 1,
          sessionId: parts[2],
          name: decodeURIComponent(parts[3]),
          mimeType: decodeURIComponent(parts[4]),
          originalSize: Number.parseInt(parts[5], 36),
          compressedSize: Number.parseInt(parts[6], 36),
          compression: parts[7] === "g" ? "gzip" : "none",
          totalShards: Number.parseInt(parts[8], 36),
          shardSize: Number.parseInt(parts[9], 36),
          hash: parts[10]
        }
      };
    }

    if (parts[0] === "D" && parts[1] === "1" && parts.length === 6) {
      return {
        shard: {
          sessionId: parts[2],
          index: Number.parseInt(parts[3], 36),
          totalShards: Number.parseInt(parts[4], 36),
          bytes: base64UrlToBytes(parts[5])
        }
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function createReceiverSession(manifest: QrManifest): ReceiverSession {
  return {
    manifest,
    shards: new Array(manifest.totalShards).fill(null),
    received: new Set()
  };
}

export function applyShard(
  session: ReceiverSession,
  shard: { sessionId: string; index: number; totalShards: number; bytes: Uint8Array }
): { duplicate: boolean; complete: boolean } {
  if (
    shard.sessionId !== session.manifest.sessionId ||
    shard.totalShards !== session.manifest.totalShards ||
    shard.index < 0 ||
    shard.index >= session.manifest.totalShards
  ) {
    return {
      duplicate: false,
      complete: false
    };
  }

  if (session.received.has(shard.index)) {
    return {
      duplicate: true,
      complete: session.received.size === session.manifest.totalShards
    };
  }

  session.shards[shard.index] = shard.bytes;
  session.received.add(shard.index);
  return {
    duplicate: false,
    complete: session.received.size === session.manifest.totalShards
  };
}

export function assembleReceiverSession(session: ReceiverSession): Uint8Array | null {
  if (session.received.size !== session.manifest.totalShards) {
    return null;
  }

  const totalLength = session.shards.reduce((sum, shard) => sum + (shard?.length ?? 0), 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const shard of session.shards) {
    if (!shard) {
      return null;
    }
    merged.set(shard, offset);
    offset += shard.length;
  }

  return merged.slice(0, session.manifest.compressedSize);
}
