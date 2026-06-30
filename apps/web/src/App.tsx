import { sha256Hex } from "@airt2/protocol";
import jsQR from "jsqr";
import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  readVideoFrame,
  startCamera,
  stopCamera,
  type CameraPreference
} from "./lib/camera";
import { compressPayload, materializePayload } from "./lib/payload";
import {
  applyShard,
  assembleReceiverSession,
  createReceiverSession,
  parseQrPayload,
  prepareQrTransfer,
  type PreparedQrTransfer,
  type QrManifest,
  type ReceiverSession
} from "./lib/qrTransport";

type Mode = "sender" | "receiver";

const MANIFEST_EVERY = 5;
const DEFAULT_FRAME_INTERVAL_MS = 900;
const DEFAULT_SHARD_SIZE = 32;
const MIN_FRAME_INTERVAL_MS = 50;
const MAX_FRAME_INTERVAL_MS = 5000;
const MIN_SHARD_SIZE = 8;
const MAX_SHARD_SIZE = 512;

interface SenderState {
  prepared: PreparedQrTransfer;
  startedAt: number;
  tick: number;
}

interface ReceiverDiagnostics {
  cameraReady: boolean;
  permissionError: string | null;
  framesSeen: number;
  qrDetections: number;
  manifestHits: number;
  shardHits: number;
  uniqueShards: number;
  duplicates: number;
  lastKind: string;
  guidance: string;
  lastBounds: Bounds | null;
}

interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

function emptyDiagnostics(): ReceiverDiagnostics {
  return {
    cameraReady: false,
    permissionError: null,
    framesSeen: 0,
    qrDetections: 0,
    manifestHits: 0,
    shardHits: 0,
    uniqueShards: 0,
    duplicates: 0,
    lastKind: "none",
    guidance: "Receiver idle.",
    lastBounds: null
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatSeconds(ms: number): string {
  return `${Math.max(0, ms / 1000).toFixed(1)} s`;
}

function getCurrentFrameText(state: SenderState | null): string | null {
  if (!state) {
    return null;
  }

  if (state.tick % MANIFEST_EVERY === 0) {
    return state.prepared.manifestText;
  }

  const shardIndex = Math.floor(state.tick / MANIFEST_EVERY) % state.prepared.shardTexts.length;
  return state.prepared.shardTexts[shardIndex];
}

function getCurrentFrameLabel(state: SenderState | null): string {
  if (!state) {
    return "QR Broadcast Idle";
  }

  if (state.tick % MANIFEST_EVERY === 0) {
    return "Manifest";
  }

  const shardIndex = Math.floor(state.tick / MANIFEST_EVERY) % state.prepared.shardTexts.length;
  return `Shard ${shardIndex + 1} / ${state.prepared.manifest.totalShards}`;
}

async function renderQrStage(
  canvas: HTMLCanvasElement,
  text: string | null,
  label: string
): Promise<void> {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);

  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#04060a");
  gradient.addColorStop(1, "#0c131b");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  const stageSize = Math.floor(Math.min(width, height) * 0.82);
  const qrSize = Math.floor(stageSize * 0.78);
  const qrX = Math.floor((width - qrSize) / 2);
  const qrY = Math.floor((height - qrSize) / 2);

  context.fillStyle = "#f7f9ff";
  context.fillRect(
    qrX - Math.floor(qrSize * 0.11),
    qrY - Math.floor(qrSize * 0.11),
    Math.floor(qrSize * 1.22),
    Math.floor(qrSize * 1.22)
  );

  if (text) {
    const offscreen = document.createElement("canvas");
    await QRCode.toCanvas(offscreen, text, {
      errorCorrectionLevel: "H",
      margin: 2,
      width: qrSize,
      color: {
        dark: "#05070c",
        light: "#f7f9ff"
      }
    });
    context.drawImage(offscreen, qrX, qrY, qrSize, qrSize);
  } else {
    context.fillStyle = "#05070c";
    context.fillRect(qrX, qrY, qrSize, qrSize);
  }

  context.strokeStyle = "#68f0c1";
  context.lineWidth = Math.max(4, stageSize * 0.008);
  context.strokeRect(
    qrX - Math.floor(qrSize * 0.11),
    qrY - Math.floor(qrSize * 0.11),
    Math.floor(qrSize * 1.22),
    Math.floor(qrSize * 1.22)
  );

  context.fillStyle = "#f7f9ff";
  context.font = `${Math.max(20, stageSize * 0.04)}px "IBM Plex Mono", monospace`;
  context.fillText(label.toUpperCase(), Math.max(28, width * 0.06), height - Math.max(40, height * 0.07));

  context.fillStyle = "#8ea2b8";
  context.font = `${Math.max(14, stageSize * 0.022)}px "IBM Plex Mono", monospace`;
  context.fillText(
    "Large QR, low bitrate, infinite loop broadcast",
    Math.max(28, width * 0.06),
    Math.max(42, height * 0.08)
  );
}

function qrBoundsFromLocation(
  location: NonNullable<ReturnType<typeof jsQR>>["location"],
  width: number,
  height: number
): Bounds {
  const xs = [
    location.topLeftCorner.x,
    location.topRightCorner.x,
    location.bottomLeftCorner.x,
    location.bottomRightCorner.x
  ];
  const ys = [
    location.topLeftCorner.y,
    location.topRightCorner.y,
    location.bottomLeftCorner.y,
    location.bottomRightCorner.y
  ];

  const minX = Math.max(0, Math.min(...xs));
  const maxX = Math.min(width, Math.max(...xs));
  const minY = Math.max(0, Math.min(...ys));
  const maxY = Math.min(height, Math.max(...ys));

  return {
    left: (minX / width) * 100,
    top: (minY / height) * 100,
    width: ((maxX - minX) / width) * 100,
    height: ((maxY - minY) / height) * 100
  };
}

function App() {
  const [mode, setMode] = useState<Mode>("sender");
  const [message, setMessage] = useState("Air T2 QR broadcast payload");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState(
    "This build uses an infinite-loop QR broadcast. Sender repeats manifest and shard QRs forever; receiver only needs to scan and accumulate."
  );
  const [frameIntervalMs, setFrameIntervalMs] = useState(DEFAULT_FRAME_INTERVAL_MS);
  const [shardSize, setShardSize] = useState(DEFAULT_SHARD_SIZE);
  const [senderState, setSenderState] = useState<SenderState | null>(null);
  const [receiverDiagnostics, setReceiverDiagnostics] = useState<ReceiverDiagnostics>(() => emptyDiagnostics());
  const [receiverEnabled, setReceiverEnabled] = useState(false);
  const [receiverCameraPreference, setReceiverCameraPreference] = useState<CameraPreference>("back");
  const [receiverManifest, setReceiverManifest] = useState<QrManifest | null>(null);
  const [receiverProgress, setReceiverProgress] = useState({ received: 0, total: 0, startedAt: 0 });
  const [receiverDownloadUrl, setReceiverDownloadUrl] = useState<string | null>(null);
  const [receiverDownloadName, setReceiverDownloadName] = useState<string | null>(null);
  const [receiverError, setReceiverError] = useState<string | null>(null);
  const [senderFullscreen, setSenderFullscreen] = useState(false);

  const senderCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const senderLabRef = useRef<HTMLDivElement | null>(null);
  const receiverVideoRef = useRef<HTMLVideoElement | null>(null);
  const receiverCaptureCanvasRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const receiverStreamRef = useRef<MediaStream | null>(null);
  const receiverLabRef = useRef<HTMLDivElement | null>(null);
  const receiverSessionRef = useRef<ReceiverSession | null>(null);

  const senderFrameText = useMemo(() => getCurrentFrameText(senderState), [senderState]);
  const senderFrameLabel = useMemo(() => getCurrentFrameLabel(senderState), [senderState]);

  useEffect(() => {
    return () => {
      stopCamera(receiverStreamRef.current);
      if (receiverDownloadUrl) {
        URL.revokeObjectURL(receiverDownloadUrl);
      }
    };
  }, [receiverDownloadUrl]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setSenderFullscreen(document.fullscreenElement === senderLabRef.current);
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    const canvas = senderCanvasRef.current;
    if (!canvas) {
      return;
    }

    const container = canvas.parentElement;
    const bounds = container?.getBoundingClientRect();
    canvas.width = Math.max(420, Math.floor((bounds?.width ?? 760) * window.devicePixelRatio));
    canvas.height = Math.max(420, Math.floor((bounds?.height ?? 760) * window.devicePixelRatio));

    let cancelled = false;
    void renderQrStage(canvas, senderFrameText, senderFrameLabel).catch(() => {
      if (!cancelled) {
        setStatus("QR rendering failed for the current frame.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [senderFrameText, senderFrameLabel, senderFullscreen]);

  useEffect(() => {
    if (!senderState) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setSenderState((current) =>
        current
          ? {
              ...current,
              tick: current.tick + 1
            }
          : current
      );
    }, frameIntervalMs);

    return () => window.clearInterval(intervalId);
  }, [senderState, frameIntervalMs]);

  useEffect(() => {
    if (!receiverEnabled || !receiverVideoRef.current) {
      return;
    }

    let disposed = false;
    let frameHandle = 0;

    const boot = async () => {
      if (!receiverVideoRef.current) {
        return;
      }

      try {
        receiverStreamRef.current = await startCamera(receiverVideoRef.current, receiverCameraPreference);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Camera access failed.";
        setReceiverDiagnostics((current) => ({
          ...current,
          permissionError: message,
          guidance: "Camera permission failed. Allow camera access and retry."
        }));
        setStatus("Receiver camera could not start. Allow camera permission and retry.");
        return;
      }

        setReceiverDiagnostics((current) => ({
          ...current,
          cameraReady: true,
          guidance:
            receiverCameraPreference === "back"
              ? "Back camera live. Point it at the sender QR and hold steady until the manifest is decoded."
              : receiverCameraPreference === "front"
                ? "Front camera live. Point it at the sender QR and hold steady until the manifest is decoded."
                : "Camera live. Point it at the sender QR and hold steady until the manifest is decoded."
        }));

      const loop = () => {
        if (disposed || !receiverVideoRef.current) {
          return;
        }

        const image = readVideoFrame(receiverVideoRef.current, receiverCaptureCanvasRef.current);
        if (image) {
          setReceiverDiagnostics((current) => ({
            ...current,
            framesSeen: current.framesSeen + 1
          }));

          const code = jsQR(image.data, image.width, image.height, {
            inversionAttempts: "dontInvert"
          });

          if (code) {
            const parsed = parseQrPayload(code.data);
            const bounds = qrBoundsFromLocation(code.location, image.width, image.height);

            setReceiverDiagnostics((current) => ({
              ...current,
              qrDetections: current.qrDetections + 1,
              lastBounds: bounds,
              lastKind: parsed?.manifest ? "manifest" : parsed?.shard ? "shard" : "unknown"
            }));

            if (parsed?.manifest) {
              const currentSession = receiverSessionRef.current;
              const sameSession =
                currentSession?.manifest.sessionId === parsed.manifest.sessionId &&
                currentSession.manifest.hash === parsed.manifest.hash;

              if (!sameSession) {
                if (
                  currentSession &&
                  currentSession.received.size > 0 &&
                  currentSession.received.size < currentSession.manifest.totalShards
                ) {
                  setReceiverDiagnostics((current) => ({
                    ...current,
                    manifestHits: current.manifestHits + 1,
                    guidance: "A different manifest was seen, but the receiver is staying on the active session until it completes."
                  }));
                } else {
                  const session = createReceiverSession(parsed.manifest);
                  receiverSessionRef.current = session;
                  setReceiverManifest(parsed.manifest);
                  setReceiverProgress({
                    received: 0,
                    total: parsed.manifest.totalShards,
                    startedAt: Date.now()
                  });
                  setReceiverDiagnostics((current) => ({
                    ...current,
                    manifestHits: current.manifestHits + 1,
                    guidance: "Manifest decoded. Receiver is now collecting shard QRs in any order."
                  }));
                  setStatus(
                    `Manifest locked for ${parsed.manifest.name}. Collecting ${parsed.manifest.totalShards} shards in any order.`
                  );
                }
              } else {
                setReceiverDiagnostics((current) => ({
                  ...current,
                  manifestHits: current.manifestHits + 1,
                  guidance: "Manifest reacquired. Continuing the current shard collection without resetting progress."
                }));
              }
            }

            if (parsed?.shard && receiverSessionRef.current) {
              const result = applyShard(receiverSessionRef.current, parsed.shard);

              setReceiverDiagnostics((current) => ({
                ...current,
                shardHits: current.shardHits + 1,
                uniqueShards: receiverSessionRef.current?.received.size ?? current.uniqueShards,
                duplicates: current.duplicates + (result.duplicate ? 1 : 0),
                guidance: result.complete
                  ? "All shards received. Verifying payload."
                  : "Shard decoded. Keep the camera steady while remaining shards accumulate."
              }));

              setReceiverProgress((current) => ({
                ...current,
                received: receiverSessionRef.current?.received.size ?? current.received
              }));

              if (result.complete) {
                void finalizeQrSession(receiverSessionRef.current, receiverDownloadUrl)
                  .then(({ url, name, error }) => {
                    if (error) {
                      setReceiverError(error);
                      setStatus(error);
                      return;
                    }

                    setReceiverError(null);
                    setReceiverDownloadUrl(url);
                    setReceiverDownloadName(name);
                    setStatus("Transfer complete. Payload verified and ready to download.");
                  })
                  .catch((error: Error) => {
                    setReceiverError(error.message);
                    setStatus(error.message);
                  });
              }
            }
          }
        }

        frameHandle = window.requestAnimationFrame(loop);
      };

      frameHandle = window.requestAnimationFrame(loop);
    };

    void boot();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameHandle);
      stopCamera(receiverStreamRef.current);
      receiverStreamRef.current = null;
    };
  }, [receiverEnabled, receiverDownloadUrl, receiverCameraPreference]);

  async function startSender(): Promise<void> {
    const payload = await resolvePayload(file, message);
    const compressed = await compressPayload(payload.bytes);
    const prepared = await prepareQrTransfer({
      bytes: compressed.bytes,
      name: payload.name,
      mimeType: payload.mimeType,
      compression: compressed.compression,
      originalSize: compressed.originalSize,
      shardSize
    });

    setSenderState({
      prepared,
      startedAt: Date.now(),
      tick: 0
    });
    setStatus(
      `Broadcasting ${prepared.manifest.totalShards} QR shards in an infinite loop at about ${(1000 / frameIntervalMs).toFixed(2)} fps with ${shardSize} byte shards.`
    );
  }

  function stopSender(): void {
    setSenderState(null);
    setStatus("Sender stopped.");
  }

  function startReceiverSession(): void {
    if (receiverDownloadUrl) {
      URL.revokeObjectURL(receiverDownloadUrl);
    }

    setReceiverDownloadUrl(null);
    setReceiverDownloadName(null);
    setReceiverError(null);
    setReceiverManifest(null);
    setReceiverProgress({ received: 0, total: 0, startedAt: Date.now() });
    receiverSessionRef.current = null;
    setReceiverDiagnostics({
      ...emptyDiagnostics(),
      guidance: "Receiver is starting. Point the camera at the sender QR."
    });
    setReceiverEnabled(true);
    setStatus("Receiver is scanning QR frames. Manifest can arrive at any time because the sender loops forever.");
  }

  function stopReceiverSession(): void {
    setReceiverEnabled(false);
    receiverSessionRef.current = null;
    setReceiverDiagnostics(emptyDiagnostics());
    setStatus("Receiver stopped.");
  }

  function requestFullscreen(target: "sender" | "receiver"): void {
    const element = target === "sender" ? senderLabRef.current : receiverLabRef.current;
    if (!element) {
      return;
    }

    void element.requestFullscreen();
  }

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">QR Broadcast Mode</p>
          <h1>Air T2</h1>
        </div>
        <div className="mode-switch">
          <button
            className={mode === "sender" ? "mode-switch__button is-active" : "mode-switch__button"}
            onClick={() => setMode("sender")}
            type="button"
          >
            Sender
          </button>
          <button
            className={mode === "receiver" ? "mode-switch__button is-active" : "mode-switch__button"}
            onClick={() => setMode("receiver")}
            type="button"
          >
            Receiver
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="main-pane">
          <div className="intro">
            <p>
              This version stops reinventing the visual code. The sender loops a large QR manifest plus small QR shards
              forever. The receiver is just a still camera that grabs whichever valid shards it can decode.
            </p>
          </div>

          {mode === "sender" ? (
            <section className="rail">
              <label className="field">
                <span>Payload file</span>
                <input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              </label>

              <label className="field">
                <span>Fallback text payload</span>
                <textarea rows={5} value={message} onChange={(event) => setMessage(event.target.value)} />
              </label>

              <div className="control-grid">
                <label className="field">
                  <span>Frame interval</span>
                  <input
                    type="range"
                    min={MIN_FRAME_INTERVAL_MS}
                    max={MAX_FRAME_INTERVAL_MS}
                    step={10}
                    value={frameIntervalMs}
                    onChange={(event) => setFrameIntervalMs(Number.parseInt(event.target.value, 10))}
                  />
                  <small>{frameIntervalMs} ms per frame ({(1000 / frameIntervalMs).toFixed(2)} fps)</small>
                </label>

                <label className="field">
                  <span>Shard size</span>
                  <input
                    type="range"
                    min={MIN_SHARD_SIZE}
                    max={MAX_SHARD_SIZE}
                    step={8}
                    value={shardSize}
                    onChange={(event) => setShardSize(Number.parseInt(event.target.value, 10))}
                  />
                  <small>{shardSize} bytes per QR shard</small>
                </label>
              </div>

              <div className="action-row">
                <button className="solid" onClick={() => void startSender()} type="button">
                  Start Broadcast
                </button>
                <button className="ghost" onClick={stopSender} type="button">
                  Stop
                </button>
              </div>

              <div className="link-lab" ref={senderLabRef}>
                <div className={senderFullscreen ? "signal-stage is-fullscreen" : "signal-stage"}>
                  <canvas ref={senderCanvasRef} />
                  <div className="signal-stage__overlay">
                    <p>{senderFrameLabel}</p>
                    <button className="ghost" onClick={() => requestFullscreen("sender")} type="button">
                      Fullscreen lab
                    </button>
                  </div>
                </div>

                <div className="lab-side">
                  <section className="protocol-panel">
                    <h2>Broadcast behavior</h2>
                    <ul>
                      <li>Every loop repeats the manifest QR, then small shard QRs.</li>
                      <li>The receiver does not need ACKs, ordering, or simultaneous lock.</li>
                      <li>If the camera decodes any shard, it keeps it and waits for the rest.</li>
                    </ul>
                  </section>

                  <section className="telemetry">
                    <h2>Sender telemetry</h2>
                    <dl>
                      <div>
                        <dt>State</dt>
                        <dd>{senderState ? "broadcasting" : "idle"}</dd>
                      </div>
                      <div>
                        <dt>Payload</dt>
                        <dd>{senderState ? formatBytes(senderState.prepared.manifest.originalSize) : "0 B"}</dd>
                      </div>
                      <div>
                        <dt>Compressed</dt>
                        <dd>{senderState ? formatBytes(senderState.prepared.manifest.compressedSize) : "0 B"}</dd>
                      </div>
                      <div>
                        <dt>Shard size</dt>
                        <dd>{senderState ? `${senderState.prepared.manifest.shardSize} B` : `${shardSize} B`}</dd>
                      </div>
                      <div>
                        <dt>Total shards</dt>
                        <dd>{senderState ? senderState.prepared.manifest.totalShards : 0}</dd>
                      </div>
                      <div>
                        <dt>Frame rate</dt>
                        <dd>{(1000 / frameIntervalMs).toFixed(2)} fps</dd>
                      </div>
                      <div>
                        <dt>Elapsed</dt>
                        <dd>{senderState ? formatSeconds(Date.now() - senderState.startedAt) : "0.0 s"}</dd>
                      </div>
                    </dl>
                  </section>
                </div>
              </div>
            </section>
          ) : (
            <section className="rail">
              <label className="field">
                <span>Receiver camera</span>
                <select
                  value={receiverCameraPreference}
                  onChange={(event) => setReceiverCameraPreference(event.target.value as CameraPreference)}
                >
                  <option value="back">Back camera</option>
                  <option value="front">Front camera</option>
                  <option value="auto">Auto</option>
                </select>
                <small>On mobile, choose the back camera for better focus and a wider field of view.</small>
              </label>

              <div className="action-row">
                <button className="solid" onClick={startReceiverSession} type="button">
                  Start Receiver
                </button>
                <button className="ghost" onClick={stopReceiverSession} type="button">
                  Stop
                </button>
              </div>

              <div className="link-lab" ref={receiverLabRef}>
                <div className="camera-frame camera-frame--large">
                  <video muted playsInline ref={receiverVideoRef} />
                  <TrackingOverlay diagnostics={receiverDiagnostics} />
                </div>

                <div className="lab-side">
                  <div className="signal-stage signal-stage--status">
                    <div className="receiver-board">
                      <p className="receiver-board__eyebrow">Receiver</p>
                      <h2>{receiverManifest ? receiverManifest.name : "Waiting For Manifest"}</h2>
                      <p>
                        {receiverManifest
                          ? `Collecting shard QRs for ${formatBytes(receiverManifest.originalSize)}.`
                          : "Point the camera at the sender QR. Hold steady until one manifest QR is decoded."}
                      </p>
                      <button className="ghost" onClick={() => requestFullscreen("receiver")} type="button">
                        Fullscreen lab
                      </button>
                    </div>
                  </div>

                  <CameraDiagnosticsPanel diagnostics={receiverDiagnostics} />
                </div>
              </div>

              {receiverDownloadUrl ? (
                <a className="download-link" download={receiverDownloadName ?? "payload.bin"} href={receiverDownloadUrl}>
                  Download reconstructed payload
                </a>
              ) : null}
              {receiverError ? <p className="error">{receiverError}</p> : null}
            </section>
          )}
        </section>

        <aside className="side-pane">
          <section className="telemetry">
            <h2>Progress</h2>
            <dl>
              <div>
                <dt>Mode</dt>
                <dd>{mode}</dd>
              </div>
              <div>
                <dt>Manifest</dt>
                <dd>{receiverManifest ? "locked" : "not yet"}</dd>
              </div>
              <div>
                <dt>Shards</dt>
                <dd>
                  {receiverProgress.total > 0
                    ? `${receiverProgress.received} / ${receiverProgress.total}`
                    : senderState
                      ? `${senderState.prepared.manifest.totalShards} broadcast`
                      : "0 / 0"}
                </dd>
              </div>
              <div>
                <dt>Payload</dt>
                <dd>
                  {receiverManifest
                    ? formatBytes(receiverManifest.originalSize)
                    : senderState
                      ? formatBytes(senderState.prepared.manifest.originalSize)
                      : "0 B"}
                </dd>
              </div>
              <div>
                <dt>Elapsed</dt>
                <dd>{receiverProgress.startedAt ? formatSeconds(Date.now() - receiverProgress.startedAt) : "0.0 s"}</dd>
              </div>
            </dl>
          </section>

          <section className="notes">
            <h2>Field notes</h2>
            <ul>
              <li>Use maximum screen brightness and fill the camera view with the QR.</li>
              <li>This build prefers working slowly over pushing bitrate.</li>
              <li>If manifest locks but shard count stalls, move closer and keep the screen square to the camera.</li>
            </ul>
          </section>

          <section className="status-strip">
            <p>{status}</p>
          </section>
        </aside>
      </main>
    </div>
  );
}

function CameraDiagnosticsPanel({ diagnostics }: { diagnostics: ReceiverDiagnostics }) {
  return (
    <section className="debug-panel">
      <h2>Receiver Diagnostics</h2>
      <p className="debug-status">{diagnostics.guidance}</p>
      <dl>
        <div>
          <dt>Camera</dt>
          <dd>{diagnostics.cameraReady ? "live" : "idle"}</dd>
        </div>
        <div>
          <dt>Frames seen</dt>
          <dd>{diagnostics.framesSeen}</dd>
        </div>
        <div>
          <dt>QR detections</dt>
          <dd>{diagnostics.qrDetections}</dd>
        </div>
        <div>
          <dt>Manifest hits</dt>
          <dd>{diagnostics.manifestHits}</dd>
        </div>
        <div>
          <dt>Shard hits</dt>
          <dd>{diagnostics.shardHits}</dd>
        </div>
        <div>
          <dt>Unique shards</dt>
          <dd>{diagnostics.uniqueShards}</dd>
        </div>
        <div>
          <dt>Duplicates</dt>
          <dd>{diagnostics.duplicates}</dd>
        </div>
        <div>
          <dt>Last kind</dt>
          <dd>{diagnostics.lastKind}</dd>
        </div>
      </dl>
      {diagnostics.permissionError ? <p className="error">{diagnostics.permissionError}</p> : null}
    </section>
  );
}

function TrackingOverlay({ diagnostics }: { diagnostics: ReceiverDiagnostics }) {
  return (
    <div className="camera-overlay">
      <div className="camera-overlay__hud">
        <span>{diagnostics.cameraReady ? "camera live" : "camera idle"}</span>
        <span>{diagnostics.qrDetections > 0 ? "qr seen" : "scanning"}</span>
        <span>{diagnostics.uniqueShards > 0 ? `${diagnostics.uniqueShards} shards saved` : "no shards yet"}</span>
      </div>
      {diagnostics.lastBounds ? (
        <div
          className="camera-overlay__box"
          style={{
            left: `${diagnostics.lastBounds.left}%`,
            top: `${diagnostics.lastBounds.top}%`,
            width: `${diagnostics.lastBounds.width}%`,
            height: `${diagnostics.lastBounds.height}%`
          }}
        >
          <span>{diagnostics.lastKind}</span>
        </div>
      ) : (
        <div className="camera-overlay__scan">
          <span>align sender QR here</span>
        </div>
      )}
    </div>
  );
}

async function finalizeQrSession(
  session: ReceiverSession,
  previousUrl: string | null
): Promise<{ url: string | null; name: string | null; error: string | null }> {
  const assembled = assembleReceiverSession(session);
  if (!assembled) {
    return {
      url: null,
      name: null,
      error: "Receiver completed without all shards present."
    };
  }

  const compressedHash = await sha256Hex(assembled);
  if (compressedHash !== session.manifest.hash) {
    return {
      url: null,
      name: null,
      error: "Shard set assembled, but hash verification failed."
    };
  }

  const payload = await materializePayload(assembled, session.manifest.compression);
  if (previousUrl) {
    URL.revokeObjectURL(previousUrl);
  }

  const blob = new Blob([new Uint8Array(payload)], { type: session.manifest.mimeType });
  return {
    url: URL.createObjectURL(blob),
    name: session.manifest.name,
    error: null
  };
}

async function resolvePayload(
  file: File | null,
  message: string
): Promise<{ bytes: Uint8Array; name: string; mimeType: string }> {
  if (file) {
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      name: file.name,
      mimeType: file.type || "application/octet-stream"
    };
  }

  return {
    bytes: new TextEncoder().encode(message.trim() || "Air T2 QR broadcast payload"),
    name: "message.txt",
    mimeType: "text/plain"
  };
}

export default App;
