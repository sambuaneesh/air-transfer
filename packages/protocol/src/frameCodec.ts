import {
  DEFAULT_PARITY_GROUP_SIZE,
  FRAME_MAGIC,
  PROTOCOL_VERSION
} from "./constants";
import { crc32 } from "./checksum";
import type {
  ControlFrame,
  ControlType,
  Direction,
  FrameEnvelope,
  FrameType,
  TransferManifest
} from "./types";

const HEADER_SIZE = 27;
const CRC_SIZE = 4;
const MAX_MANIFEST_NAME_BYTES = 24;
const MAX_MANIFEST_MIME_BYTES = 16;

const frameTypeMap: Record<FrameType, number> = {
  manifest: 1,
  data: 2,
  parity: 3,
  control: 4,
  complete: 5
};

const reverseFrameTypeMap = Object.fromEntries(
  Object.entries(frameTypeMap).map(([key, value]) => [value, key as FrameType])
) as Record<number, FrameType>;

const directionMap: Record<Direction, number> = {
  forward: 1,
  reverse: 2
};

const reverseDirectionMap = Object.fromEntries(
  Object.entries(directionMap).map(([key, value]) => [value, key as Direction])
) as Record<number, Direction>;

const controlTypeMap: Record<ControlType, number> = {
  manifest_ack: 1,
  ack: 2,
  nack: 3,
  pause: 4,
  resume: 5,
  recalibrate: 6,
  complete: 7
};

const reverseControlTypeMap = Object.fromEntries(
  Object.entries(controlTypeMap).map(([key, value]) => [value, key as ControlType])
) as Record<number, ControlType>;

function sessionIdToNumber(sessionId: string): number {
  return Number.parseInt(sessionId, 16) >>> 0;
}

function numberToSessionId(value: number): string {
  return value.toString(16).padStart(8, "0");
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (normalized.length !== 64) {
    return new Uint8Array(32);
  }

  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    const value = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
    bytes[index] = Number.isNaN(value) ? 0 : value;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function encodeFrame(frame: FrameEnvelope): Uint8Array {
  const payload = frame.payload;
  const buffer = new ArrayBuffer(HEADER_SIZE + payload.length + CRC_SIZE);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint16(0, FRAME_MAGIC);
  view.setUint8(2, PROTOCOL_VERSION);
  view.setUint8(3, frameTypeMap[frame.frameType]);
  view.setUint8(4, directionMap[frame.direction]);
  view.setUint8(5, frame.profileId);
  view.setUint32(6, sessionIdToNumber(frame.sessionId));
  view.setUint16(10, frame.chunkId);
  view.setUint16(12, frame.frameId);
  view.setUint16(14, frame.totalFrames);
  view.setUint16(16, frame.chunkLength ?? payload.length);
  view.setUint16(18, payload.length);
  view.setUint32(20, frame.chunkCrc ?? 0);
  view.setUint8(24, frame.groupId ?? 0);
  view.setUint8(25, frame.groupSize ?? DEFAULT_PARITY_GROUP_SIZE);
  view.setUint8(26, 0);
  bytes.set(payload, HEADER_SIZE);

  const frameCrc = crc32(bytes.subarray(0, HEADER_SIZE + payload.length));
  view.setUint32(HEADER_SIZE + payload.length, frameCrc);

  return bytes;
}

export function decodeFrame(packet: Uint8Array): FrameEnvelope | null {
  if (packet.length < HEADER_SIZE + CRC_SIZE) {
    return null;
  }

  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (view.getUint16(0) !== FRAME_MAGIC || view.getUint8(2) !== PROTOCOL_VERSION) {
    return null;
  }

  const payloadLength = view.getUint16(18);
  if (packet.length !== HEADER_SIZE + payloadLength + CRC_SIZE) {
    return null;
  }

  const declaredCrc = view.getUint32(HEADER_SIZE + payloadLength);
  const actualCrc = crc32(packet.subarray(0, HEADER_SIZE + payloadLength));
  if (declaredCrc !== actualCrc) {
    return null;
  }

  const frameType = reverseFrameTypeMap[view.getUint8(3)];
  const direction = reverseDirectionMap[view.getUint8(4)];
  if (!frameType || !direction) {
    return null;
  }

  return {
    sessionId: numberToSessionId(view.getUint32(6)),
    frameType,
    direction,
    profileId: view.getUint8(5),
    chunkId: view.getUint16(10),
    frameId: view.getUint16(12),
    totalFrames: view.getUint16(14),
    chunkLength: view.getUint16(16),
    payload: packet.slice(HEADER_SIZE, HEADER_SIZE + payloadLength),
    chunkCrc: view.getUint32(20),
    groupId: view.getUint8(24),
    groupSize: view.getUint8(25)
  };
}

export function encodeManifestPayload(manifest: TransferManifest): Uint8Array {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(manifest.name).slice(0, MAX_MANIFEST_NAME_BYTES);
  const mimeBytes = encoder.encode(manifest.mimeType).slice(0, MAX_MANIFEST_MIME_BYTES);
  const hashBytes = hexToBytes(manifest.fileHash);
  const buffer = new ArrayBuffer(51 + nameBytes.length + mimeBytes.length);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint32(0, sessionIdToNumber(manifest.sessionId));
  view.setUint32(4, manifest.originalSize);
  view.setUint32(8, manifest.compressedSize);
  view.setUint16(12, manifest.chunkSize);
  view.setUint16(14, manifest.chunkCount);
  bytes.set(hashBytes, 16);
  view.setUint8(48, manifest.compression === "gzip" ? 1 : 0);
  view.setUint8(49, nameBytes.length);
  bytes.set(nameBytes, 50);
  view.setUint8(50 + nameBytes.length, mimeBytes.length);
  bytes.set(mimeBytes, 51 + nameBytes.length);

  return bytes;
}

export function decodeManifestPayload(payload: Uint8Array): TransferManifest {
  if (payload.length < 51) {
    throw new Error("Manifest payload too short.");
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const nameLength = view.getUint8(49);
  const mimeLengthOffset = 50 + nameLength;
  if (payload.length < mimeLengthOffset + 1) {
    throw new Error("Manifest payload is truncated before MIME length.");
  }

  const mimeLength = view.getUint8(mimeLengthOffset);
  const mimeStart = mimeLengthOffset + 1;
  if (payload.length < mimeStart + mimeLength) {
    throw new Error("Manifest payload is truncated before MIME bytes.");
  }

  const decoder = new TextDecoder();
  return {
    sessionId: numberToSessionId(view.getUint32(0)),
    originalSize: view.getUint32(4),
    compressedSize: view.getUint32(8),
    chunkSize: view.getUint16(12),
    chunkCount: view.getUint16(14),
    fileHash: bytesToHex(payload.slice(16, 48)),
    compression: view.getUint8(48) === 1 ? "gzip" : "none",
    name: decoder.decode(payload.slice(50, 50 + nameLength)),
    mimeType: decoder.decode(payload.slice(mimeStart, mimeStart + mimeLength))
  };
}

export function encodeControlPayload(frame: ControlFrame): Uint8Array {
  const reason = frame.recalibrateReason ?? "";
  const reasonBytes = new TextEncoder().encode(reason);
  const buffer = new ArrayBuffer(8 + reasonBytes.length);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(0, controlTypeMap[frame.controlType]);
  view.setUint16(1, frame.ackChunk ?? 0xffff);
  view.setUint16(3, frame.nackChunk ?? 0xffff);
  view.setUint8(5, frame.receiverState ?? 0);
  view.setUint16(6, reasonBytes.length);
  bytes.set(reasonBytes, 8);

  return bytes;
}

export function decodeControlPayload(payload: Uint8Array, sessionId: string): ControlFrame | null {
  if (payload.length < 8) {
    return null;
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const controlType = reverseControlTypeMap[view.getUint8(0)];
  if (!controlType) {
    return null;
  }

  const reasonLength = view.getUint16(6);
  if (payload.length !== 8 + reasonLength) {
    return null;
  }

  const reason = new TextDecoder().decode(payload.subarray(8));
  const ackChunk = view.getUint16(1);
  const nackChunk = view.getUint16(3);

  return {
    sessionId,
    controlType,
    ackChunk: ackChunk === 0xffff ? undefined : ackChunk,
    nackChunk: nackChunk === 0xffff ? undefined : nackChunk,
    receiverState: view.getUint8(5),
    recalibrateReason: reason || undefined
  };
}
