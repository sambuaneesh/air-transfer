import { describe, expect, it } from "vitest";

import { decodeFrame, encodeFrame } from "../src/frameCodec";
import {
  applyFrameToChunkState,
  buildChunkFrames,
  createChunkDecodeState,
  planAdaptiveProfile,
  resumeFromCheckpoint
} from "../src/session";
import { crc32 } from "../src/checksum";

describe("frame codec", () => {
  it("round-trips encoded frames", () => {
    const frame = {
      sessionId: "1a2b3c4d",
      direction: "forward" as const,
      frameType: "data" as const,
      chunkId: 3,
      frameId: 1,
      totalFrames: 4,
      profileId: 1,
      chunkLength: 200,
      chunkCrc: 123456,
      payload: new Uint8Array([1, 2, 3, 4]),
      groupId: 0,
      groupSize: 3
    };

    const encoded = encodeFrame(frame);
    const decoded = decodeFrame(encoded);

    expect(decoded).toEqual(frame);
  });
});

describe("chunk parity recovery", () => {
  it("recovers a missing frame from parity", () => {
    const bytes = new Uint8Array(Array.from({ length: 900 }, (_, index) => index % 251));
    const chunk = buildChunkFrames("abcdef12", 0, bytes, 300, 1);
    const firstFrame = chunk.dataFrames[0];
    const state = createChunkDecodeState(firstFrame);

    for (const frame of chunk.dataFrames) {
      if (frame.frameId === 1) {
        continue;
      }
      applyFrameToChunkState(state, frame);
    }

    for (const frame of chunk.parityFrames) {
      const result = applyFrameToChunkState(state, frame);
      if (result.completed) {
        expect(result.chunkBytes).toEqual(bytes);
        expect(crc32(result.chunkBytes ?? new Uint8Array())).toBe(chunk.crc32);
        return;
      }
    }

    throw new Error("Parity recovery did not complete.");
  });
});

describe("session helpers", () => {
  it("resumes from the next chunk after the last confirmed chunk", () => {
    expect(
      resumeFromCheckpoint(2, {
        sessionId: "12345678",
        name: "demo.bin",
        mimeType: "application/octet-stream",
        originalSize: 12,
        compressedSize: 12,
        chunkSize: 4,
        chunkCount: 3,
        fileHash: "abc",
        compression: "none"
      })
    ).toBe(2);
  });

  it("keeps the conservative profile when the link is noisy", () => {
    const decision = planAdaptiveProfile({
      goodput: 1000,
      decodeErrorRate: 0.24,
      retransmits: 12,
      duplicateFrames: 3,
      calibrationScore: 0.8,
      elapsedTimeMs: 5000
    });

    expect(decision.nextProfileId).toBe(1);
  });
});
