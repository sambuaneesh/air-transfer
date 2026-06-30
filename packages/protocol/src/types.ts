export type CompressionKind = "none" | "gzip";

export type FrameType = "manifest" | "data" | "parity" | "control" | "complete";

export type Direction = "forward" | "reverse";

export type ControlType =
  | "manifest_ack"
  | "ack"
  | "nack"
  | "pause"
  | "resume"
  | "recalibrate"
  | "complete";

export interface TransferManifest {
  sessionId: string;
  name: string;
  mimeType: string;
  originalSize: number;
  compressedSize: number;
  chunkSize: number;
  chunkCount: number;
  fileHash: string;
  compression: CompressionKind;
}

export interface FrameEnvelope {
  sessionId: string;
  direction: Direction;
  frameType: FrameType;
  chunkId: number;
  frameId: number;
  profileId: number;
  totalFrames: number;
  payload: Uint8Array;
  chunkLength?: number;
  chunkCrc?: number;
  groupId?: number;
  groupSize?: number;
}

export interface ControlFrame {
  sessionId: string;
  controlType: ControlType;
  ackChunk?: number;
  nackChunk?: number;
  receiverState?: number;
  recalibrateReason?: string;
}

export interface CalibrationProfile {
  tileSize: number;
  captureFps: number;
  transmitFps: number;
  lumaThresholds: {
    dark: number;
    light: number;
  };
  perspective: {
    x: number;
    y: number;
    scale: number;
  };
  profileId: number;
}

export interface TransferStats {
  goodput: number;
  decodeErrorRate: number;
  retransmits: number;
  duplicateFrames: number;
  calibrationScore: number;
  elapsedTimeMs: number;
}

export interface PreparedChunk {
  chunkId: number;
  bytes: Uint8Array;
  crc32: number;
  dataFrames: FrameEnvelope[];
  parityFrames: FrameEnvelope[];
}

export interface PreparedTransfer {
  manifest: TransferManifest;
  manifestFrame: FrameEnvelope;
  chunks: PreparedChunk[];
  bytes: Uint8Array;
}

export interface ChunkDecodeState {
  chunkId: number;
  chunkLength: number;
  expectedFrames: number;
  chunkCrc: number;
  frames: Map<number, Uint8Array>;
  parityFrames: Map<number, Uint8Array>;
}

export interface AdaptiveDecision {
  nextProfileId: number;
  reason: string;
}
