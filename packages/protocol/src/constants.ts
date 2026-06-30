import type { CalibrationProfile } from "./types";

export const PROTOCOL_VERSION = 1;
export const FRAME_MAGIC = 0x4132;
export const MAX_SESSION_ID = 0xffffffff;
export const DEFAULT_CHUNK_SIZE = 4096;
export const DEFAULT_FRAME_PAYLOAD_SIZE = 64;
export const DEFAULT_PARITY_GROUP_SIZE = 3;
export const DEFAULT_PROFILE_ID = 1;

export const DEFAULT_CALIBRATION_PROFILE: CalibrationProfile = {
  tileSize: 24,
  captureFps: 10,
  transmitFps: 2,
  lumaThresholds: {
    dark: 70,
    light: 180
  },
  perspective: {
    x: 0.5,
    y: 0.5,
    scale: 1
  },
  profileId: DEFAULT_PROFILE_ID
};
