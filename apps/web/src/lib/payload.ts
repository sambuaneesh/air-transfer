import type { CompressionKind } from "@airt2/protocol";

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    length += value.length;
  }

  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

async function transformBytes(
  bytes: Uint8Array,
  streamFactory: () => CompressionStream | DecompressionStream
): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(streamFactory());
  return streamToBytes(stream);
}

export async function compressPayload(
  bytes: Uint8Array
): Promise<{ bytes: Uint8Array; compression: CompressionKind; originalSize: number }> {
  if (typeof CompressionStream === "undefined") {
    return {
      bytes,
      compression: "none",
      originalSize: bytes.length
    };
  }

  const compressed = await transformBytes(bytes, () => new CompressionStream("gzip"));
  if (compressed.length >= bytes.length * 0.92) {
    return {
      bytes,
      compression: "none",
      originalSize: bytes.length
    };
  }

  return {
    bytes: compressed,
    compression: "gzip",
    originalSize: bytes.length
  };
}

export async function materializePayload(
  bytes: Uint8Array,
  compression: CompressionKind
): Promise<Uint8Array> {
  if (compression === "none") {
    return bytes;
  }

  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser does not support gzip decompression.");
  }

  return transformBytes(bytes, () => new DecompressionStream("gzip"));
}
