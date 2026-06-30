export async function startCamera(
  video: HTMLVideoElement
): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 }
    },
    audio: false
  });

  video.srcObject = stream;
  await video.play();
  return stream;
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function readVideoFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement
): ImageData | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width === 0 || height === 0) {
    return null;
  }

  const maxWidth = 960;
  const scale = Math.min(1, maxWidth / width);
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }

  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}
