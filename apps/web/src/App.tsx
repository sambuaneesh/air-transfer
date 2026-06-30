import {
  DEFAULT_CALIBRATION_PROFILE,
  decodeControlPayload,
  decodeFrame,
  decodeManifestFrame,
  encodeControlFrame,
  prepareTransfer,
  serializeFrame,
  applyFrameToChunkState,
  createChunkDecodeState,
  type ChunkDecodeState,
  type ControlFrame,
  type FrameEnvelope,
  type PreparedTransfer,
  type TransferManifest
} from "@airt2/protocol";
import { scoreCalibration } from "@airt2/simulator";
import { useEffect, useRef, useState } from "react";

import { readVideoFrame, startCamera, stopCamera } from "./lib/camera";
import { decodePacketFromImage, renderSignalCanvas } from "./lib/optical";
import { compressPayload, materializePayload } from "./lib/payload";

type Mode = "sender" | "receiver";
type SenderPhase = "idle" | "manifest" | "sending" | "paused" | "done";
type ReceiverPhase = "idle" | "listening" | "receiving" | "complete";

interface SenderRuntime {
  prepared: PreparedTransfer;
  currentChunkIndex: number;
  frameCursor: number;
  retransmits: number;
  duplicates: number;
  lastControl: ControlFrame | null;
  phase: SenderPhase;
  startedAt: number;
  activeFrame: FrameEnvelope | null;
  calibrationScore: number;
}

interface ReceiverRuntime {
  manifest: TransferManifest | null;
  currentChunkState: ChunkDecodeState | null;
  chunks: Uint8Array[];
  duplicateFrames: number;
  phase: ReceiverPhase;
  activeControl: FrameEnvelope | null;
  calibrationScore: number;
  downloadUrl: string | null;
  receivedName: string | null;
  error: string | null;
  lastConfirmedChunk: number;
  startedAt: number;
}

function emptyReceiverState(): ReceiverRuntime {
  return {
    manifest: null,
    currentChunkState: null,
    chunks: [],
    duplicateFrames: 0,
    phase: "idle",
    activeControl: null,
    calibrationScore: 0,
    downloadUrl: null,
    receivedName: null,
    error: null,
    lastConfirmedChunk: -1,
    startedAt: 0
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

function App() {
  const [mode, setMode] = useState<Mode>("sender");
  const [message, setMessage] = useState("Transfer payloads optically across two laptop screens.");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("Point each laptop camera at the other screen, then calibrate before starting.");
  const [senderRuntime, setSenderRuntime] = useState<SenderRuntime | null>(null);
  const [receiverRuntime, setReceiverRuntime] = useState<ReceiverRuntime>(() => emptyReceiverState());
  const [senderCameraEnabled, setSenderCameraEnabled] = useState(false);
  const [receiverCameraEnabled, setReceiverCameraEnabled] = useState(false);
  const [senderStageFullscreen, setSenderStageFullscreen] = useState(false);
  const [receiverStageFullscreen, setReceiverStageFullscreen] = useState(false);

  const senderVideoRef = useRef<HTMLVideoElement | null>(null);
  const receiverVideoRef = useRef<HTMLVideoElement | null>(null);
  const senderCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const receiverCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const senderCaptureCanvasRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const receiverCaptureCanvasRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const senderStreamRef = useRef<MediaStream | null>(null);
  const receiverStreamRef = useRef<MediaStream | null>(null);

  const senderRuntimeRef = useRef<SenderRuntime | null>(null);
  const receiverRuntimeRef = useRef<ReceiverRuntime>(receiverRuntime);

  useEffect(() => {
    senderRuntimeRef.current = senderRuntime;
  }, [senderRuntime]);

  useEffect(() => {
    receiverRuntimeRef.current = receiverRuntime;
  }, [receiverRuntime]);

  useEffect(() => {
    return () => {
      stopCamera(senderStreamRef.current);
      stopCamera(receiverStreamRef.current);
      const url = receiverRuntimeRef.current.downloadUrl;
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  useEffect(() => {
    const canvas = senderCanvasRef.current;
    if (!canvas) {
      return;
    }

    canvas.width = Math.floor(window.innerWidth * (senderStageFullscreen ? window.devicePixelRatio : 1.2));
    canvas.height = Math.floor((senderStageFullscreen ? window.innerHeight : 560) * (senderStageFullscreen ? window.devicePixelRatio : 1.2));
    const packet = senderRuntime?.activeFrame ? serializeFrame(senderRuntime.activeFrame) : null;
    renderSignalCanvas(canvas, packet, "forward channel", "#68f0c1");
  }, [senderRuntime?.activeFrame, senderStageFullscreen]);

  useEffect(() => {
    const canvas = receiverCanvasRef.current;
    if (!canvas) {
      return;
    }

    canvas.width = Math.floor(window.innerWidth * (receiverStageFullscreen ? window.devicePixelRatio : 1.2));
    canvas.height = Math.floor((receiverStageFullscreen ? window.innerHeight : 560) * (receiverStageFullscreen ? window.devicePixelRatio : 1.2));
    const packet = receiverRuntime.activeControl ? serializeFrame(receiverRuntime.activeControl) : null;
    renderSignalCanvas(canvas, packet, "reverse control", "#ffd26f");
  }, [receiverRuntime.activeControl, receiverStageFullscreen]);

  useEffect(() => {
    if (!senderRuntime || !senderCameraEnabled) {
      return;
    }

    let intervalId = 0;
    intervalId = window.setInterval(() => {
      setSenderRuntime((current) => {
        if (!current) {
          return current;
        }

        if (current.phase === "paused" || current.phase === "done") {
          return current;
        }

        if (current.phase === "manifest") {
          return {
            ...current,
            activeFrame: current.prepared.manifestFrame
          };
        }

        const chunk = current.prepared.chunks[current.currentChunkIndex];
        if (!chunk) {
          return {
            ...current,
            phase: "done",
            activeFrame: null
          };
        }

        const cycle = [...chunk.dataFrames, ...chunk.parityFrames];
        const activeFrame = cycle[current.frameCursor % cycle.length];

        return {
          ...current,
          activeFrame,
          frameCursor: current.frameCursor + 1
        };
      });
    }, 1000 / DEFAULT_CALIBRATION_PROFILE.transmitFps);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [senderRuntime, senderCameraEnabled]);

  useEffect(() => {
    if (!senderCameraEnabled || !senderVideoRef.current) {
      return;
    }

    let disposed = false;
    let animationFrame = 0;

    const boot = async () => {
      if (!senderVideoRef.current) {
        return;
      }

      senderStreamRef.current = await startCamera(senderVideoRef.current);
      const loop = () => {
        if (disposed || !senderVideoRef.current) {
          return;
        }

        const image = readVideoFrame(senderVideoRef.current, senderCaptureCanvasRef.current);
        if (image) {
          const decoded = decodePacketFromImage(image);
          const calibration = scoreCalibration({
            noise: decoded ? 0.06 : 0.2,
            blur: decoded ? 0.08 : 0.2,
            brightnessDrift: decoded ? Math.abs(decoded.threshold - 128) / 255 : 0.25,
            droppedFrameRate: 0.02
          });

          setSenderRuntime((current) =>
            current
              ? {
                  ...current,
                  calibrationScore: calibration
                }
              : current
          );

          if (decoded) {
            const frame = decodeFrame(decoded.packet);
            if (frame?.frameType === "control") {
              const control = decodeControlPayload(frame.payload, frame.sessionId);
              if (control) {
                setSenderRuntime((current) => {
                  if (!current || control.sessionId !== current.prepared.manifest.sessionId) {
                    return current;
                  }

                  if (
                    current.lastControl?.controlType === control.controlType &&
                    current.lastControl?.ackChunk === control.ackChunk &&
                    current.lastControl?.nackChunk === control.nackChunk
                  ) {
                    return {
                      ...current,
                      duplicates: current.duplicates + 1,
                      lastControl: control
                    };
                  }

                  if (control.controlType === "manifest_ack") {
                    setStatus("Manifest acknowledged. Streaming payload frames.");
                    return {
                      ...current,
                      phase: "sending",
                      lastControl: control,
                      frameCursor: 0
                    };
                  }

                  if (control.controlType === "pause") {
                    setStatus("Receiver asked the sender to pause.");
                    return {
                      ...current,
                      phase: "paused",
                      lastControl: control
                    };
                  }

                  if (control.controlType === "resume") {
                    setStatus("Receiver resumed the link.");
                    return {
                      ...current,
                      phase: current.phase === "paused" ? "sending" : current.phase,
                      lastControl: control
                    };
                  }

                  if (control.controlType === "nack" && control.nackChunk !== undefined) {
                    setStatus(`Chunk ${control.nackChunk} needs retransmission.`);
                    return {
                      ...current,
                      currentChunkIndex: control.nackChunk,
                      frameCursor: 0,
                      retransmits: current.retransmits + 1,
                      lastControl: control,
                      phase: "sending"
                    };
                  }

                  if (control.controlType === "ack" && control.ackChunk !== undefined) {
                    const nextChunk = control.ackChunk + 1;
                    if (nextChunk >= current.prepared.manifest.chunkCount) {
                      setStatus("All chunks acknowledged. Waiting for final completion signal.");
                      return {
                        ...current,
                        phase: "done",
                        currentChunkIndex: nextChunk,
                        activeFrame: null,
                        lastControl: control
                      };
                    }

                    setStatus(`Chunk ${control.ackChunk} confirmed. Advancing to chunk ${nextChunk}.`);
                    return {
                      ...current,
                      currentChunkIndex: nextChunk,
                      frameCursor: 0,
                      lastControl: control,
                      phase: "sending"
                    };
                  }

                  if (control.controlType === "complete") {
                    setStatus("Receiver completed the file and verified integrity.");
                    return {
                      ...current,
                      phase: "done",
                      activeFrame: null,
                      lastControl: control
                    };
                  }

                  return {
                    ...current,
                    lastControl: control
                  };
                });
              }
            }
          }
        }

        animationFrame = window.requestAnimationFrame(loop);
      };

      animationFrame = window.requestAnimationFrame(loop);
    };

    void boot();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      stopCamera(senderStreamRef.current);
      senderStreamRef.current = null;
    };
  }, [senderCameraEnabled]);

  useEffect(() => {
    if (!receiverCameraEnabled || !receiverVideoRef.current) {
      return;
    }

    let disposed = false;
    let animationFrame = 0;

    const boot = async () => {
      if (!receiverVideoRef.current) {
        return;
      }

      receiverStreamRef.current = await startCamera(receiverVideoRef.current);
      const loop = () => {
        if (disposed || !receiverVideoRef.current) {
          return;
        }

        const image = readVideoFrame(receiverVideoRef.current, receiverCaptureCanvasRef.current);
        if (image) {
          const decoded = decodePacketFromImage(image);
          const calibration = scoreCalibration({
            noise: decoded ? 0.05 : 0.22,
            blur: decoded ? 0.09 : 0.24,
            brightnessDrift: decoded ? Math.abs(decoded.threshold - 128) / 255 : 0.24,
            droppedFrameRate: 0.02
          });

          if (decoded) {
            const envelope = decodeFrame(decoded.packet);
            if (envelope?.direction === "forward") {
              setReceiverRuntime((current) => {
                const nextState = {
                  ...current,
                  calibrationScore: calibration
                };

                if (envelope.frameType === "manifest") {
                  const manifest = decodeManifestFrame(envelope);
                  if (!manifest) {
                    return nextState;
                  }

                  if (current.downloadUrl) {
                    URL.revokeObjectURL(current.downloadUrl);
                  }

                  setStatus(`Manifest received for ${manifest.name}.`);
                  return {
                    ...emptyReceiverState(),
                    manifest,
                    phase: "receiving",
                    startedAt: Date.now(),
                    calibrationScore: calibration,
                    chunks: new Array(manifest.chunkCount),
                    activeControl: encodeControlFrame({
                      sessionId: manifest.sessionId,
                      controlType: "manifest_ack",
                      receiverState: 1
                    }),
                    lastConfirmedChunk: -1
                  };
                }

                if (!current.manifest || current.manifest.sessionId !== envelope.sessionId) {
                  return nextState;
                }

                if (envelope.chunkId < current.lastConfirmedChunk + 1) {
                  return {
                    ...nextState,
                    duplicateFrames: current.duplicateFrames + 1,
                    activeControl: encodeControlFrame({
                      sessionId: current.manifest.sessionId,
                      controlType: "ack",
                      ackChunk: current.lastConfirmedChunk,
                      receiverState: 2
                    })
                  };
                }

                if (envelope.chunkId > current.lastConfirmedChunk + 1) {
                  return {
                    ...nextState,
                    activeControl: encodeControlFrame({
                      sessionId: current.manifest.sessionId,
                      controlType: "nack",
                      nackChunk: current.lastConfirmedChunk + 1,
                      receiverState: 2
                    })
                  };
                }

                let chunkState = current.currentChunkState;
                if (!chunkState || chunkState.chunkId !== envelope.chunkId) {
                  chunkState = createChunkDecodeState(envelope);
                }

                if (
                  envelope.frameType === "data" &&
                  chunkState.frames.has(envelope.frameId)
                ) {
                  return {
                    ...nextState,
                    duplicateFrames: current.duplicateFrames + 1
                  };
                }

                const result = applyFrameToChunkState(chunkState, envelope);
                if (!result.completed || !result.chunkBytes) {
                  return {
                    ...nextState,
                    currentChunkState: chunkState
                  };
                }

                const chunks = [...current.chunks];
                chunks[envelope.chunkId] = result.chunkBytes;
                const lastConfirmedChunk = envelope.chunkId;

                if (lastConfirmedChunk === current.manifest.chunkCount - 1) {
                  void finalizeReceiverTransfer(current.manifest, chunks, current.downloadUrl)
                    .then(({ url, error, receivedName }) => {
                      setReceiverRuntime((latest) => ({
                        ...latest,
                        phase: error ? "receiving" : "complete",
                        downloadUrl: url,
                        error,
                        receivedName,
                        activeControl: encodeControlFrame({
                          sessionId: current.manifest!.sessionId,
                          controlType: error ? "nack" : "complete",
                          nackChunk: error ? lastConfirmedChunk : undefined,
                          receiverState: error ? 3 : 4
                        })
                      }));
                    })
                    .catch((error: Error) => {
                      setReceiverRuntime((latest) => ({
                        ...latest,
                        error: error.message,
                        activeControl: encodeControlFrame({
                          sessionId: current.manifest!.sessionId,
                          controlType: "nack",
                          nackChunk: lastConfirmedChunk,
                          receiverState: 3
                        })
                      }));
                    });

                  setStatus("All chunks reconstructed. Verifying final payload.");
                  return {
                    ...nextState,
                    chunks,
                    currentChunkState: null,
                    lastConfirmedChunk,
                    activeControl: encodeControlFrame({
                      sessionId: current.manifest.sessionId,
                      controlType: "ack",
                      ackChunk: lastConfirmedChunk,
                      receiverState: 3
                    })
                  };
                }

                setStatus(`Chunk ${lastConfirmedChunk} verified on receiver.`);
                return {
                  ...nextState,
                  chunks,
                  currentChunkState: null,
                  lastConfirmedChunk,
                  activeControl: encodeControlFrame({
                    sessionId: current.manifest.sessionId,
                    controlType: "ack",
                    ackChunk: lastConfirmedChunk,
                    receiverState: 2
                  })
                };
              });
            }
          } else {
            setReceiverRuntime((current) => ({
              ...current,
              calibrationScore: calibration
            }));
          }
        }

        animationFrame = window.requestAnimationFrame(loop);
      };

      animationFrame = window.requestAnimationFrame(loop);
    };

    void boot();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      stopCamera(receiverStreamRef.current);
      receiverStreamRef.current = null;
    };
  }, [receiverCameraEnabled]);

  async function startSender(): Promise<void> {
    const payload = await resolvePayload(file, message);
    const compressed = await compressPayload(payload.bytes);
    const prepared = await prepareTransfer({
      name: payload.name,
      mimeType: payload.mimeType,
      bytes: compressed.bytes,
      compression: compressed.compression,
      originalSize: compressed.originalSize
    });

    setSenderRuntime({
      prepared,
      currentChunkIndex: 0,
      frameCursor: 0,
      retransmits: 0,
      duplicates: 0,
      lastControl: null,
      phase: "manifest",
      startedAt: Date.now(),
      activeFrame: prepared.manifestFrame,
      calibrationScore: 0
    });
    setSenderCameraEnabled(true);
    setStatus("Sender is repeating the manifest. Wait for manifest ACK from the receiver.");
  }

  function stopSenderSession(): void {
    setSenderRuntime(null);
    setSenderCameraEnabled(false);
    setStatus("Sender reset. Camera stopped.");
  }

  function startReceiver(): void {
    setReceiverRuntime({
      ...emptyReceiverState(),
      phase: "listening",
      activeControl: null,
      startedAt: Date.now()
    });
    setReceiverCameraEnabled(true);
    setStatus("Receiver is listening for manifest frames and rendering the control channel.");
  }

  function stopReceiverSession(): void {
    setReceiverCameraEnabled(false);
    if (receiverRuntime.downloadUrl) {
      URL.revokeObjectURL(receiverRuntime.downloadUrl);
    }
    setReceiverRuntime(emptyReceiverState());
    setStatus("Receiver reset. Camera stopped.");
  }

  function requestFullscreen(stage: "sender" | "receiver"): void {
    const element =
      stage === "sender" ? senderCanvasRef.current?.parentElement : receiverCanvasRef.current?.parentElement;
    if (!element) {
      return;
    }
    void element.requestFullscreen();
    if (stage === "sender") {
      setSenderStageFullscreen(true);
    } else {
      setReceiverStageFullscreen(true);
    }
  }

  const activeStats =
    mode === "sender" && senderRuntime
      ? {
          phase: senderRuntime.phase,
          chunk: `${Math.min(senderRuntime.currentChunkIndex + 1, senderRuntime.prepared.manifest.chunkCount)} / ${senderRuntime.prepared.manifest.chunkCount}`,
          payload: formatBytes(senderRuntime.prepared.manifest.originalSize),
          elapsed: formatSeconds(Date.now() - senderRuntime.startedAt),
          calibration: `${Math.round(senderRuntime.calibrationScore * 100)}%`,
          retransmits: senderRuntime.retransmits.toString(),
          duplicates: senderRuntime.duplicates.toString()
        }
      : {
          phase: receiverRuntime.phase,
          chunk: receiverRuntime.manifest
            ? `${Math.max(receiverRuntime.lastConfirmedChunk + 1, 0)} / ${receiverRuntime.manifest.chunkCount}`
            : "0 / 0",
          payload: receiverRuntime.manifest ? formatBytes(receiverRuntime.manifest.originalSize) : "0 B",
          elapsed: receiverRuntime.startedAt ? formatSeconds(Date.now() - receiverRuntime.startedAt) : "0.0 s",
          calibration: `${Math.round(receiverRuntime.calibrationScore * 100)}%`,
          retransmits: "0",
          duplicates: receiverRuntime.duplicateFrames.toString()
        };

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">Optical Transfer Workspace</p>
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
              One screen carries payload frames. The other screen carries compact ACK/NACK control frames.
              Both devices use their laptop webcams to decode the opposite fullscreen stage.
            </p>
          </div>

          {mode === "sender" ? (
            <section className="rail">
              <label className="field">
                <span>Payload file</span>
                <input
                  type="file"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </label>

              <label className="field">
                <span>Fallback text payload</span>
                <textarea
                  rows={5}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </label>

              <div className="action-row">
                <button className="solid" onClick={() => void startSender()} type="button">
                  Start Sender
                </button>
                <button className="ghost" onClick={stopSenderSession} type="button">
                  Reset
                </button>
              </div>

              <div className={senderStageFullscreen ? "signal-stage is-fullscreen" : "signal-stage"}>
                <canvas ref={senderCanvasRef} />
                <div className="signal-stage__overlay">
                  <p>Forward optical payload</p>
                  <button className="ghost" onClick={() => requestFullscreen("sender")} type="button">
                    Fullscreen stage
                  </button>
                </div>
              </div>

              <div className="camera-row">
                <video muted playsInline ref={senderVideoRef} />
                <div className="camera-copy">
                  <p>ACK camera</p>
                  <span>Use this laptop camera to read the receiver’s reverse control screen.</span>
                </div>
              </div>
            </section>
          ) : (
            <section className="rail">
              <div className="action-row">
                <button className="solid" onClick={startReceiver} type="button">
                  Start Receiver
                </button>
                <button className="ghost" onClick={stopReceiverSession} type="button">
                  Reset
                </button>
              </div>

              <div className={receiverStageFullscreen ? "signal-stage is-fullscreen" : "signal-stage"}>
                <canvas ref={receiverCanvasRef} />
                <div className="signal-stage__overlay">
                  <p>Reverse optical control</p>
                  <button className="ghost" onClick={() => requestFullscreen("receiver")} type="button">
                    Fullscreen stage
                  </button>
                </div>
              </div>

              <div className="camera-row">
                <video muted playsInline ref={receiverVideoRef} />
                <div className="camera-copy">
                  <p>Receive camera</p>
                  <span>Use this laptop camera to lock onto the sender’s payload stage.</span>
                </div>
              </div>

              {receiverRuntime.downloadUrl ? (
                <a className="download-link" download={receiverRuntime.receivedName ?? "payload.bin"} href={receiverRuntime.downloadUrl}>
                  Download reconstructed payload
                </a>
              ) : null}
              {receiverRuntime.error ? <p className="error">{receiverRuntime.error}</p> : null}
            </section>
          )}
        </section>

        <aside className="side-pane">
          <section className="telemetry">
            <h2>Link telemetry</h2>
            <dl>
              <div>
                <dt>Phase</dt>
                <dd>{activeStats.phase}</dd>
              </div>
              <div>
                <dt>Chunk</dt>
                <dd>{activeStats.chunk}</dd>
              </div>
              <div>
                <dt>Payload</dt>
                <dd>{activeStats.payload}</dd>
              </div>
              <div>
                <dt>Elapsed</dt>
                <dd>{activeStats.elapsed}</dd>
              </div>
              <div>
                <dt>Calibration</dt>
                <dd>{activeStats.calibration}</dd>
              </div>
              <div>
                <dt>Retransmits</dt>
                <dd>{activeStats.retransmits}</dd>
              </div>
              <div>
                <dt>Duplicates</dt>
                <dd>{activeStats.duplicates}</dd>
              </div>
            </dl>
          </section>

          <section className="notes">
            <h2>Field notes</h2>
            <ul>
              <li>Keep both stages fullscreen and max brightness during active transfer.</li>
              <li>Monochrome high-contrast cells survive webcam exposure drift better than color-coded payloads.</li>
              <li>Manifest and chunk ACK use the same reverse channel renderer, so both peers can reuse one decoder.</li>
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

async function finalizeReceiverTransfer(
  manifest: TransferManifest,
  chunks: Uint8Array[],
  previousUrl: string | null
): Promise<{ url: string | null; error: string | null; receivedName: string | null }> {
  const totalLength = chunks.reduce((sum, chunk) => sum + (chunk?.length ?? 0), 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    if (!chunk) {
      return {
        url: null,
        error: "A chunk was missing during final assembly.",
        receivedName: null
      };
    }
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  const payload = await materializePayload(merged, manifest.compression);
  const hashBuffer = await crypto.subtle.digest("SHA-256", new Uint8Array(payload));
  const hash = Array.from(new Uint8Array(hashBuffer))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

  if (hash !== manifest.fileHash) {
    return {
      url: previousUrl,
      error: "Whole-file hash mismatch after reconstruction.",
      receivedName: null
    };
  }

  if (previousUrl) {
    URL.revokeObjectURL(previousUrl);
  }

  const blob = new Blob([new Uint8Array(payload)], { type: manifest.mimeType });
  return {
    url: URL.createObjectURL(blob),
    error: null,
    receivedName: manifest.name
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

  const fallback = new TextEncoder().encode(message.trim() || "Air T2 optical payload");
  return {
    bytes: fallback,
    name: "message.txt",
    mimeType: "text/plain"
  };
}

export default App;
