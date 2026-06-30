export type CameraPreference = "auto" | "back" | "front";

async function openCamera(
  video: HTMLVideoElement,
  constraints: MediaTrackConstraints
): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: constraints,
    audio: false
  });

  video.srcObject = stream;
  await video.play();
  return stream;
}

export async function startCamera(
  video: HTMLVideoElement,
  preference: CameraPreference = "auto"
): Promise<MediaStream> {
  const baseConstraints: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 }
  };

  const attempts: MediaTrackConstraints[] =
    preference === "back"
      ? [
          {
            ...baseConstraints,
            facingMode: { exact: "environment" }
          },
          {
            ...baseConstraints,
            facingMode: { ideal: "environment" }
          },
          baseConstraints
        ]
      : preference === "front"
        ? [
            {
              ...baseConstraints,
              facingMode: { exact: "user" }
            },
            {
              ...baseConstraints,
              facingMode: { ideal: "user" }
            },
            baseConstraints
          ]
        : [baseConstraints];

  let lastError: unknown;
  for (const constraints of attempts) {
    try {
      return await openCamera(video, constraints);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Camera access failed.");
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
