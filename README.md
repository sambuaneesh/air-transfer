# air-transfer

**Optical air-gapped data transfer via screen pixels & camera.**

Transfer files between two computers using just their screens and built-in webcams — no WiFi, Bluetooth, USB, or any network required. Think "QR codes on steroids": high-density colored 2D grids with a full bidirectional protocol (ACK/retransmit) for reliable transfer of files up to ~1 MB.

- **Two laptops, screens facing each other's cameras**
- **Full-duplex visual protocol**: one screen shows data frames, the other's camera reads them and responds with visual ACK frames
- **~20 KB/s throughput** (50×50 grid, 64 colors, 2 bits/channel, ~10 fps effective)
- **Reed-Solomon error correction** + zstd compression
- **Rust native binary** + **WASM web app** (browser-based, no install)

```
┌──────────────┐   camera → reads ACK   ┌──────────────┐
│   SENDER     │ ═══════════════════════ │   RECEIVER   │
│              │ ← screen shows data    │              │
│  file.zip →  │   frames               │  camera →    │
│  compress →  │                        │  detect →    │
│  ECC → grid  │ screen → shows ACK ←   │  decode →    │
│  → display   │ ═══════════════════════ │  → file.zip  │
└──────────────┘                        └──────────────┘
```

---

## Quick Start

### Native (Desktop)

```bash
# Prerequisites: Rust 1.80+, build-essential/Xcode CLT, v4l2 (Linux)

# Clone and build
git clone <repo-url> && cd air-transfer
cargo build --release

# Test the display (opens fullscreen grid — Esc to exit)
cargo run --release -- --mode test-display

# Send a file
cargo run --release -- --mode send --input data.zip

# Receive a file (on the other laptop)
cargo run --release -- --mode receive --output data.zip
```

### Web (Browser)

```bash
# Prerequisites: trunk (cargo install trunk), wasm32 target
rustup target add wasm32-unknown-unknown
cargo install trunk

# Start dev server
trunk serve

# Open http://localhost:8080 on both laptops
# One chooses "Send", the other "Receive"
# Face screens toward each other's cameras
```

---

## CLI Parameters (Native)

| Flag | Default | Description |
|------|---------|-------------|
| `-m, --mode` | `send` | Operating mode: `send`, `receive`, or `test-display` |
| `-i, --input` | (required for send) | Path to file to transmit |
| `-o, --output` | `received_output.bin` | Path for received file (receive mode) |
| `--camera` | `0` | Camera device index (0 = built-in webcam) |
| `--cam-width` | `640` | Requested camera capture width |
| `--cam-height` | `480` | Requested camera capture height |
| `--no-fullscreen` | (flag) | Open in windowed instead of fullscreen |

---

## Usage Scenarios

### Scenario 1: Two Laptops, Face-to-Face

1. **Laptop A (Sender):** `cargo run --release -- --mode send --input project.zip`
2. **Laptop B (Receiver):** `cargo run --release -- --mode receive --output project.zip`
3. Align screens so each camera sees the other's full display. Transfer begins automatically.

### Scenario 2: Web Browser Transfer (No Rust Install)

1. `trunk serve` on one machine (or deploy to static host)
2. Open `http://<host>:8080` on both laptops
3. Sender: click **Choose file** → **Prepare**
4. Receiver: click **Start Camera** (grants camera permission)
5. Face screens toward each other's cameras

### Scenario 3: Test Without Two Machines

```bash
cargo run --release -- --mode test-display
```
Opens a fullscreen window with the handshake grid. Press Escape to exit.

### Scenario 4: Windowed Mode for Debugging

```bash
cargo run --release -- --mode send --input data.zip --no-fullscreen --cam-width 320 --cam-height 240
```

### Scenario 5: External Webcam

```bash
cargo run --release -- --mode receive --camera 1 --cam-width 1280 --cam-height 720
```

---

## How It Works

### Frame Structure

Each frame is a grid of colored cells surrounded by a green registration border with distinct corner markers for orientation detection:

- **Quiet zone**: 2-cell black border
- **Registration border**: 2-cell solid green (#00ff00)
- **Corner markers**: 2×2 distinct color blocks (R/B, G/W, Y/C, M/K)
- **Header**: 2 rows, 1-bit/channel (8 colors) for robust decoding — contains frame_id, type, shard info, CRC
- **Payload**: 50 × 50 cells, 2 bits per RGB channel = 64 colors, 6 bits per cell = ~1,875 bytes per frame
- **Reference cells**: Every 8th row/col contains known palette colors for per-frame calibration

### Protocol

**Stop-and-wait with visual ACK:**

1. **Handshake**: Both sides display a known "ready" pattern; cameras detect each other
2. **Data frames**: Sender encodes file into Reed-Solomon shards, displays them sequentially
3. **ACK frames**: Receiver decodes each frame, displays a tiny ACK grid on its screen
4. **Sender's camera** detects the ACK and advances to the next frame
5. **Timeout + retransmit** if ACK not detected within ~500ms
6. **Assembly**: Receiver collects all shards → ECC decode → zstd decompress → output file

### Encoding Pipeline

- **Compression**: zstd level 3
- **ECC**: Reed-Solomon GF(2⁸), 8 parity shards per 16 data shards (tolerates up to 8 lost shards)
- **Color**: 64-color palette (2 bits per RGB channel = 6 bits/cell)
- **Header**: Frame ID (u16), type (2 bits), shard count/index, data length, checksum

### Detection Pipeline (Receiver)

1. Green border thresholded in HSV → binary mask
2. Contour detection → quadrilateral → 4 corner points
3. Homography (perspective transform) via DLT
4. Cell centers sampled through homography with bilinear interpolation
5. Color classification: nearest-neighbor in HSV space against calibrated palette
6. Header decoded from first 2 grid rows
7. Payload cells unpacked into bytes

---

## Project Structure

```
src/
├── lib.rs            # Library root — shared modules
├── main.rs           # Binary entry (calls native module)
├── native.rs         # Native-only CLI + winit/pixels app logic
├── web_app.rs        # WASM-only browser UI (Canvas + getUserMedia)
├── display.rs        # Native display (pixels + winit, GPU rendering)
├── camera.rs         # Native camera (nokhwa)
├── encoder.rs        # Data → grid cells (palette + layout)
├── decoder.rs        # Grid cells → data (classification + extraction)
├── protocol.rs       # Frame types, serde structs, constants
├── correction.rs     # Reed-Solomon ECC encode/decode
├── detection.rs      # Border detection, homography, cell sampling
├── color.rs          # RGB↔HSV, palette, cell classifier
├── calibration.rs    # Palette measurement from calibration frame
└── error.rs          # Error types (thiserror)
```

---

## Build Targets

| Target | Command | Output |
|--------|---------|--------|
| Native debug | `cargo build` | `target/debug/air-transfer` |
| Native release | `cargo build --release` | `target/release/air-transfer` |
| WASM (check) | `cargo check --target wasm32-unknown-unknown` | type-check |
| WASM (serve) | `trunk serve` | Browser at localhost:8080 |
| WASM (dist) | `trunk build --release` | `dist/` for static hosting |

**Linux**: `sudo usermod -aG video $USER` may be needed for camera access (log out/in after).
**macOS**: First camera access triggers a system permission dialog.

---

## Limitations & Future

- **Max file**: ~1 MB (larger files time out or exceed practical shard count)
- **Lighting**: Works best with consistent indoor lighting; avoid direct sunlight on screens
- **Camera quality**: Built-in 720p webcams work; higher-res cameras improve reliability
- **Alignment**: Screens should face each other directly; significant tilt reduces detection

### Planned
- Adaptive bits-per-channel based on measured error rate
- Multi-frame pipelining for higher throughput
- External camera optimization (higher resolution → denser grids)
- Mobile support via web app (phone camera + screen)
- Audio out-of-band ACK (beep detection) for faster turnaround

---

## License

MIT
