import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_FRAME_PAYLOAD_SIZE,
  DEFAULT_PARITY_GROUP_SIZE,
  DEFAULT_PROFILE_ID
} from "./constants";
import { crc32, sha256Hex, xorPayloads } from "./checksum";
import { decodeManifestPayload, encodeControlPayload, encodeFrame, encodeManifestPayload } from "./frameCodec";
import type {
  AdaptiveDecision,
  ChunkDecodeState,
  ControlFrame,
  FrameEnvelope,
  PreparedChunk,
  PreparedTransfer,
  TransferManifest,
  TransferStats
} from "./types";

export interface PrepareTransferOptions {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  compression?: TransferManifest["compression"];
  originalSize?: number;
  chunkSize?: number;
  framePayloadSize?: number;
  profileId?: number;
}

export function generateSessionId(): string {
  const value = crypto.getRandomValues(new Uint32Array(1))[0];
  return value.toString(16).padStart(8, "0");
}

export async function createManifest(options: PrepareTransferOptions): Promise<TransferManifest> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const compressedSize = options.bytes.length;

  return {
    sessionId: generateSessionId(),
    name: options.name,
    mimeType: options.mimeType,
    originalSize: options.originalSize ?? options.bytes.length,
    compressedSize,
    chunkSize,
    chunkCount: Math.ceil(compressedSize / chunkSize),
    fileHash: await sha256Hex(options.bytes),
    compression: options.compression ?? "none"
  };
}

export async function prepareTransfer(options: PrepareTransferOptions): Promise<PreparedTransfer> {
  const manifest = await createManifest(options);
  const framePayloadSize = options.framePayloadSize ?? DEFAULT_FRAME_PAYLOAD_SIZE;
  const profileId = options.profileId ?? DEFAULT_PROFILE_ID;
  const chunks = chunkPayload(
    manifest.sessionId,
    options.bytes,
    manifest.chunkSize,
    framePayloadSize,
    profileId
  );
  const manifestPayload = encodeManifestPayload(manifest);
  const manifestFrame: FrameEnvelope = {
    sessionId: manifest.sessionId,
    direction: "forward",
    frameType: "manifest",
    chunkId: 0xffff,
    frameId: 0,
    totalFrames: 1,
    profileId,
    chunkLength: manifestPayload.length,
    chunkCrc: crc32(manifestPayload),
    payload: manifestPayload
  };

  return {
    manifest,
    manifestFrame,
    chunks,
    bytes: options.bytes
  };
}

export function chunkPayload(
  sessionId: string,
  bytes: Uint8Array,
  chunkSize: number,
  framePayloadSize: number,
  profileId: number
): PreparedChunk[] {
  const chunks: PreparedChunk[] = [];

  for (let chunkId = 0; chunkId * chunkSize < bytes.length; chunkId += 1) {
    const start = chunkId * chunkSize;
    const chunkBytes = bytes.slice(start, Math.min(bytes.length, start + chunkSize));
    const chunkFrames = buildChunkFrames(sessionId, chunkId, chunkBytes, framePayloadSize, profileId);
    chunks.push(chunkFrames);
  }

  return chunks;
}

export function buildChunkFrames(
  sessionId: string,
  chunkId: number,
  chunkBytes: Uint8Array,
  framePayloadSize: number,
  profileId: number
): PreparedChunk {
  const crc = crc32(chunkBytes);
  const payloads: Uint8Array[] = [];

  for (let offset = 0; offset < chunkBytes.length; offset += framePayloadSize) {
    payloads.push(chunkBytes.slice(offset, Math.min(chunkBytes.length, offset + framePayloadSize)));
  }

  const totalFrames = payloads.length;
  const dataFrames = payloads.map<FrameEnvelope>((payload, frameId) => ({
    sessionId,
    direction: "forward",
    frameType: "data",
    chunkId,
    frameId,
    totalFrames,
    profileId,
    chunkLength: chunkBytes.length,
    chunkCrc: crc,
    payload,
    groupId: Math.floor(frameId / DEFAULT_PARITY_GROUP_SIZE),
    groupSize: DEFAULT_PARITY_GROUP_SIZE
  }));

  const parityFrames: FrameEnvelope[] = [];
  for (let groupStart = 0; groupStart < payloads.length; groupStart += DEFAULT_PARITY_GROUP_SIZE) {
    const group = payloads.slice(groupStart, groupStart + DEFAULT_PARITY_GROUP_SIZE);
    if (group.length < 2) {
      continue;
    }

    const parityPayload = xorPayloads(group);
    parityFrames.push({
      sessionId,
      direction: "forward",
      frameType: "parity",
      chunkId,
      frameId: parityFrames.length,
      totalFrames,
      profileId,
      chunkLength: chunkBytes.length,
      chunkCrc: crc,
      payload: parityPayload,
      groupId: Math.floor(groupStart / DEFAULT_PARITY_GROUP_SIZE),
      groupSize: group.length
    });
  }

  return {
    chunkId,
    bytes: chunkBytes,
    crc32: crc,
    dataFrames,
    parityFrames
  };
}

export function encodeControlFrame(
  frame: ControlFrame,
  profileId = DEFAULT_PROFILE_ID
): FrameEnvelope {
  return {
    sessionId: frame.sessionId,
    direction: "reverse",
    frameType: "control",
    chunkId: 0xfffe,
    frameId: 0,
    totalFrames: 1,
    profileId,
    payload: encodeControlPayload(frame)
  };
}

export function recoverChunkState(state: ChunkDecodeState): Uint8Array | null {
  const resolvedFrames = new Map(state.frames);

  for (const [groupId, parityPayload] of state.parityFrames.entries()) {
    const start = groupId * DEFAULT_PARITY_GROUP_SIZE;
    const expectedIndices = Array.from(
      { length: DEFAULT_PARITY_GROUP_SIZE },
      (_, index) => start + index
    ).filter((frameId) => frameId < state.expectedFrames);
    const missing = expectedIndices.filter((frameId) => !resolvedFrames.has(frameId));

    if (missing.length !== 1) {
      continue;
    }

    const recovered = parityPayload.slice();
    for (const frameId of expectedIndices) {
      if (frameId === missing[0]) {
        continue;
      }

      const payload = resolvedFrames.get(frameId);
      if (!payload) {
        return null;
      }

      for (let index = 0; index < recovered.length; index += 1) {
        recovered[index] ^= payload[index] ?? 0;
      }
    }

    resolvedFrames.set(missing[0], recovered);
  }

  if (resolvedFrames.size !== state.expectedFrames) {
    return null;
  }

  const ordered = Array.from({ length: state.expectedFrames }, (_, frameId) => resolvedFrames.get(frameId));
  if (ordered.some((value) => !value)) {
    return null;
  }

  const merged = new Uint8Array(
    ordered.reduce((total, frame) => total + (frame?.length ?? 0), 0)
  );
  let cursor = 0;
  for (const frame of ordered) {
    if (!frame) {
      return null;
    }
    merged.set(frame, cursor);
    cursor += frame.length;
  }

  const chunkBytes = merged.slice(0, state.chunkLength);
  if (crc32(chunkBytes) !== state.chunkCrc) {
    return null;
  }

  return chunkBytes;
}

export function createChunkDecodeState(frame: FrameEnvelope): ChunkDecodeState {
  return {
    chunkId: frame.chunkId,
    chunkLength: frame.chunkLength ?? frame.payload.length,
    expectedFrames: frame.totalFrames,
    chunkCrc: frame.chunkCrc ?? 0,
    frames: new Map(),
    parityFrames: new Map()
  };
}

export function applyFrameToChunkState(
  state: ChunkDecodeState,
  frame: FrameEnvelope
): { completed: boolean; chunkBytes?: Uint8Array } {
  if (frame.frameType === "parity") {
    state.parityFrames.set(frame.groupId ?? 0, frame.payload);
  } else {
    state.frames.set(frame.frameId, frame.payload);
  }

  const chunkBytes = recoverChunkState(state);
  if (!chunkBytes) {
    return { completed: false };
  }

  return {
    completed: true,
    chunkBytes
  };
}

export function resumeFromCheckpoint(lastConfirmedChunk: number, manifest: TransferManifest): number {
  if (lastConfirmedChunk < 0) {
    return 0;
  }
  return Math.min(lastConfirmedChunk + 1, Math.max(manifest.chunkCount - 1, 0));
}

export function planAdaptiveProfile(stats: TransferStats): AdaptiveDecision {
  if (stats.decodeErrorRate > 0.18 || stats.retransmits > 8) {
    return {
      nextProfileId: 1,
      reason: "High error rate, stay on the most conservative profile."
    };
  }

  if (stats.decodeErrorRate < 0.03 && stats.retransmits < 3 && stats.calibrationScore > 0.75) {
    return {
      nextProfileId: 2,
      reason: "Channel is stable enough to try a denser symbol profile."
    };
  }

  return {
    nextProfileId: 1,
    reason: "Keep the baseline profile until the channel is consistently clean."
  };
}

export function decodeManifestFrame(frame: FrameEnvelope): TransferManifest | null {
  if (frame.frameType !== "manifest") {
    return null;
  }

  const expectedCrc = frame.chunkCrc ?? 0;
  if (crc32(frame.payload) !== expectedCrc) {
    return null;
  }

  return decodeManifestPayload(frame.payload);
}

export function serializeFrame(frame: FrameEnvelope): Uint8Array {
  return encodeFrame(frame);
}
