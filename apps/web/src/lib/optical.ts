import { decodeFrame } from "@airt2/protocol";

const GRID_SIZE = 64;
const CAPACITY_BYTES = (GRID_SIZE * GRID_SIZE) / 8;
const OUTER_RATIO = 0.82;
const BORDER_RATIO = 0.07;
const INNER_PADDING_RATIO = 0.07;

export interface SignalBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SignalSample {
  packet: Uint8Array;
  bounds: SignalBounds;
  threshold: number;
}

function getLuma(red: number, green: number, blue: number): number {
  return red * 0.299 + green * 0.587 + blue * 0.114;
}

function bytesToBits(bytes: Uint8Array, totalBits: number): Uint8Array {
  const bits = new Uint8Array(totalBits);
  for (let bitIndex = 0; bitIndex < totalBits; bitIndex += 1) {
    const byteIndex = Math.floor(bitIndex / 8);
    const shift = 7 - (bitIndex % 8);
    bits[bitIndex] = byteIndex < bytes.length ? (bytes[byteIndex] >> shift) & 1 : 0;
  }
  return bits;
}

function bitsToBytes(bits: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let bitIndex = 0; bitIndex < bits.length; bitIndex += 1) {
    if (bits[bitIndex] === 1) {
      bytes[Math.floor(bitIndex / 8)] |= 1 << (7 - (bitIndex % 8));
    }
  }
  return bytes;
}

function toOpticalPayload(packet: Uint8Array): Uint8Array {
  if (packet.length > CAPACITY_BYTES - 2) {
    throw new Error(`Frame too large for ${GRID_SIZE}x${GRID_SIZE} payload grid.`);
  }

  const payload = new Uint8Array(CAPACITY_BYTES);
  const view = new DataView(payload.buffer);
  view.setUint16(0, packet.length);
  payload.set(packet, 2);
  return payload;
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }
  const position = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[position];
}

function drawFinders(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const marker = size * 0.075;
  const inset = marker * 0.18;

  const drawMarker = (mx: number, my: number) => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(mx, my, marker, marker);
    ctx.fillStyle = "#05070c";
    ctx.fillRect(mx + inset, my + inset, marker - inset * 2, marker - inset * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(mx + inset * 2.4, my + inset * 2.4, marker - inset * 4.8, marker - inset * 4.8);
  };

  drawMarker(x, y);
  drawMarker(x + size - marker, y);
  drawMarker(x, y + size - marker);
}

export function renderSignalCanvas(
  canvas: HTMLCanvasElement,
  packet: Uint8Array | null,
  label: string,
  accent: string
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#03050a");
  gradient.addColorStop(1, "#0a1018");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const outerSize = Math.floor(Math.min(width, height) * OUTER_RATIO);
  const outerX = Math.floor((width - outerSize) / 2);
  const outerY = Math.floor((height - outerSize) / 2);
  const border = Math.max(18, outerSize * BORDER_RATIO);
  const innerPadding = Math.max(18, outerSize * INNER_PADDING_RATIO);

  ctx.fillStyle = "#f6f8ff";
  ctx.fillRect(outerX, outerY, outerSize, outerSize);

  ctx.fillStyle = "#05070c";
  ctx.fillRect(
    outerX + border,
    outerY + border,
    outerSize - border * 2,
    outerSize - border * 2
  );

  drawFinders(ctx, outerX + border * 0.2, outerY + border * 0.2, outerSize - border * 0.4);

  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(outerX + outerSize * 0.12, outerY + outerSize * 0.03, outerSize * 0.76, 8);
  ctx.globalAlpha = 1;

  const dataRect = {
    x: outerX + border + innerPadding,
    y: outerY + border + innerPadding,
    size: outerSize - (border + innerPadding) * 2
  };

  const tile = dataRect.size / GRID_SIZE;
  const payload = packet ? toOpticalPayload(packet) : null;
  const bits = payload ? bytesToBits(payload, GRID_SIZE * GRID_SIZE) : null;

  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let column = 0; column < GRID_SIZE; column += 1) {
      const index = row * GRID_SIZE + column;
      const isSet = bits ? bits[index] === 1 : (row + column) % 2 === 0;
      ctx.fillStyle = isSet ? "#f6f8ff" : "#05070c";
      ctx.fillRect(
        dataRect.x + column * tile,
        dataRect.y + row * tile,
        Math.ceil(tile),
        Math.ceil(tile)
      );
    }
  }

  ctx.fillStyle = "#f6f8ff";
  ctx.font = `${Math.max(18, outerSize * 0.025)}px "IBM Plex Mono", monospace`;
  ctx.fillText(label.toUpperCase(), outerX + border, outerY + outerSize - border * 0.35);
}

export function detectSignalBounds(imageData: ImageData): SignalBounds | null {
  const { data, width, height } = imageData;
  let maxLuma = 0;
  let totalLuma = 0;
  let samples = 0;

  for (let index = 0; index < data.length; index += 16) {
    const luma = getLuma(data[index], data[index + 1], data[index + 2]);
    maxLuma = Math.max(maxLuma, luma);
    totalLuma += luma;
    samples += 1;
  }

  const average = totalLuma / Math.max(samples, 1);
  const threshold = Math.max(150, average + (maxLuma - average) * 0.45);

  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let hits = 0;

  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const offset = (y * width + x) * 4;
      const luma = getLuma(data[offset], data[offset + 1], data[offset + 2]);
      if (luma < threshold) {
        continue;
      }

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      hits += 1;
    }
  }

  if (hits < 250) {
    return null;
  }

  const bounds = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };

  if (bounds.width < width * 0.18 || bounds.height < height * 0.18) {
    return null;
  }

  return bounds;
}

export function decodePacketFromImage(imageData: ImageData): SignalSample | null {
  const bounds = detectSignalBounds(imageData);
  if (!bounds) {
    return null;
  }

  const border = Math.max(12, Math.min(bounds.width, bounds.height) * BORDER_RATIO);
  const innerPadding = Math.max(12, Math.min(bounds.width, bounds.height) * INNER_PADDING_RATIO);
  const inner = {
    x: Math.floor(bounds.x + border + innerPadding),
    y: Math.floor(bounds.y + border + innerPadding),
    width: Math.floor(bounds.width - (border + innerPadding) * 2),
    height: Math.floor(bounds.height - (border + innerPadding) * 2)
  };

  if (inner.width <= 0 || inner.height <= 0) {
    return null;
  }

  const cellValues: number[] = [];
  const bits = new Uint8Array(GRID_SIZE * GRID_SIZE);
  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let column = 0; column < GRID_SIZE; column += 1) {
      const startX = inner.x + (column * inner.width) / GRID_SIZE;
      const endX = inner.x + ((column + 1) * inner.width) / GRID_SIZE;
      const startY = inner.y + (row * inner.height) / GRID_SIZE;
      const endY = inner.y + ((row + 1) * inner.height) / GRID_SIZE;

      let total = 0;
      let pixels = 0;
      for (let sampleY = Math.floor(startY); sampleY < Math.floor(endY); sampleY += 1) {
        for (let sampleX = Math.floor(startX); sampleX < Math.floor(endX); sampleX += 1) {
          const offset = (sampleY * imageData.width + sampleX) * 4;
          total += getLuma(
            imageData.data[offset],
            imageData.data[offset + 1],
            imageData.data[offset + 2]
          );
          pixels += 1;
        }
      }

      const mean = total / Math.max(1, pixels);
      cellValues.push(mean);
    }
  }

  const threshold = (quantile(cellValues, 0.25) + quantile(cellValues, 0.75)) / 2;
  for (let index = 0; index < cellValues.length; index += 1) {
    bits[index] = cellValues[index] > threshold ? 1 : 0;
  }

  const payload = bitsToBytes(bits);
  const view = new DataView(payload.buffer);
  const packetLength = view.getUint16(0);
  if (packetLength === 0 || packetLength > CAPACITY_BYTES - 2) {
    return null;
  }

  const packet = payload.slice(2, 2 + packetLength);
  if (!decodeFrame(packet)) {
    return null;
  }

  return {
    packet,
    bounds,
    threshold
  };
}
