export interface ChannelConditions {
  noise: number;
  blur: number;
  brightnessDrift: number;
  droppedFrameRate: number;
}

export interface SimulatedFrameResult {
  bytes: Uint8Array;
  dropped: boolean;
  flippedBits: number;
}

export function injectChannelNoise(
  bytes: Uint8Array,
  conditions: ChannelConditions,
  random = Math.random
): SimulatedFrameResult {
  const dropped = random() < conditions.droppedFrameRate;
  if (dropped) {
    return {
      bytes,
      dropped: true,
      flippedBits: 0
    };
  }

  const copy = bytes.slice();
  let flippedBits = 0;
  const bitFlipChance = Math.min(
    0.35,
    conditions.noise * 0.12 + conditions.blur * 0.08 + conditions.brightnessDrift * 0.05
  );

  for (let byteIndex = 0; byteIndex < copy.length; byteIndex += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      if (random() < bitFlipChance) {
        copy[byteIndex] ^= 1 << bit;
        flippedBits += 1;
      }
    }
  }

  return {
    bytes: copy,
    dropped: false,
    flippedBits
  };
}

export function scoreCalibration(conditions: ChannelConditions): number {
  const penalty =
    conditions.noise * 0.35 +
    conditions.blur * 0.35 +
    conditions.brightnessDrift * 0.2 +
    conditions.droppedFrameRate * 0.4;

  return Math.max(0, Math.min(1, 1 - penalty));
}
