# air-transfer

**Optical, air-gapped data transfer via display pixels and camera.**

Two laptops face screen-to-camera. Data is encoded as high-density colored 2D grids, displayed on one screen, captured by the other's camera, acknowledged visually, and reassembled — no wires, no WiFi, no Bluetooth.

---

## How it works

1. **Compress** — input file is compressed with Zstandard
2. **ECC encode** — split into shards with Reed-Solomon error correction (16 data + 8 parity)
3. **Encode to grid** — each shard becomes a 50×50 grid of colored cells (64 colors, 6 bits/cell)
4. **Display** — grid rendered fullscreen with green registration border + corner markers
5. **Capture** — receiver's camera detects the green border, rectifies perspective via homography
6. **Decode** — color classification in HSV space, cell extraction, shard reassembly
7. **ACK** — receiver displays a tiny ACK frame on its own screen, sender captures it
8. **Reconstruct** — ECC corrects errors, data decompressed, output written to disk

---

## Installation

### Download prebuilt binaries

Prebuilt binaries for Linux and Windows are in the [releases](../../releases).

| Platform | File |
|----------|------|
| Linux (x86_64) | `air-transfer-v0.1.0-linux-x86_64.tar.gz` |
| Windows (x86_64) | `air-transfer-v0.1.0-windows-x86_64.zip` |

Extract and run:
```bash
# Linux
tar xzf air-transfer-v0.1.0-linux-x86_64.tar.gz
./air-transfer --help

# Windows
# Extract the zip and run air-transfer.exe from Command Prompt or PowerShell
air-transfer.exe --help
```

### Build from source

**Prerequisites per platform:**

| Platform | Toolchain |
|----------|-----------|
| Linux | `build-essential pkg-config libv4l-dev` (Debian) or `base-devel v4l-utils` (Arch) |
| macOS | `xcode-select --install` |
| Windows | [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) or `mingw-w64` |

```bash
git clone https://github.com/user/air-transfer.git
cd air-transfer
cargo build --release
```

### Cross-compile for Windows from Linux

Install the MinGW cross-compiler, then build:

```bash
# Arch
sudo pacman -S mingw-w64-gcc

# Debian/Ubuntu
sudo apt install mingw-w64

# Add Windows target
rustup target add x86_64-pc-windows-gnu

# Build
cargo build --release --target x86_64-pc-windows-gnu
```

### Build all platforms at once

```bash
./scripts/build.sh
```

This produces release packages in `target/release-packages/` — ready to ship.

### Web build (WASM)

```bash
# Install Trunk
cargo install trunk

# Install WASM target
rustup target add wasm32-unknown-unknown

# Build and serve
trunk serve
# Opens at http://localhost:8080
```

---

## Ship / distribute

To create distributable archives for all supported platforms:

```bash
./scripts/build.sh
```

Output:
```
target/release-packages/
├── air-transfer-v0.1.0-linux-x86_64.tar.gz      # Linux binary + README
├── air-transfer-v0.1.0-windows-x86_64.zip       # Windows binary + README
├── linux/                                        # intermediate staging
└── windows/
```

Each archive contains:
- `air-transfer` (or `air-transfer.exe`) — the binary
- `README.md` — usage documentation
- `LICENSE` — MIT

**Windows note:** The `.exe` requires no runtime dependencies. Copy it to any Windows 10+ machine and run.

**Linux note:** Binary links against `glibc` (standard on all desktop distros). For maximum portability, build on the oldest glibc you want to support.

---

## Usage — Native CLI

```bash
# Show help
cargo run -- --help
```

### Send a file

```bash
cargo run -- --mode send --input document.zip
```

The sender opens a fullscreen window, encodes the file into colored grid frames, and displays them sequentially. Position your screen facing the receiver's camera.

### Receive a file

```bash
cargo run -- --mode receive --output received.zip
```

The receiver opens a fullscreen window displaying a handshake grid. It uses the built-in camera to capture the sender's screen, detects and decodes frames, and writes the output file.

### Test the display

```bash
cargo run -- --mode test-display
```

Opens a fullscreen window showing a handshake grid so you can verify the display output looks correct.

### Full CLI reference

| Flag | Default | Description |
|------|---------|-------------|
| `-m, --mode` | `send` | `send`, `receive`, or `test-display` |
| `-i, --input` | — | Path to file to send (required for send mode) |
| `-o, --output` | `received_output.bin` | Path for received file (receive mode) |
| `--camera` | `0` | Camera device index (receive mode / ACK detection) |
| `--cam-width` | `640` | Camera capture width |
| `--cam-height` | `480` | Camera capture height |
| `--no-fullscreen` | false | Disable fullscreen (windowed mode for debugging) |

### Scenarios

**Scenario A: Two laptops, same room**

```bash
# Laptop A (sender)
cargo run -- --mode send --input secrets.zip

# Laptop B (receiver)
cargo run -- --mode receive --output secrets.zip
```

1. Position laptops so their screens face each other's cameras
2. Align for best camera view of the other screen
3. Both laptops will detect each other and begin transfer automatically
4. Sender advances frames as ACKs are received
5. Press Escape on either side to cancel

**Scenario B: Send-only display (no ACK)**

If the receiver doesn't have the app, the sender can still display frames on a timer (500ms per frame). The receiver could use a phone camera to record, then process later.

```bash
cargo run -- --mode send --input data.zip
```

**Scenario C: Quick display test**

```bash
cargo run -- --mode test-display --no-fullscreen
```

---

## Usage — Web Application

```bash
trunk serve
```

Opens the browser-based UI at `http://localhost:8080`.

### Send tab
1. Choose a file
2. Click **Prepare** — file is compressed, ECC-encoded, split into grid frames
3. The send canvas displays frames in sequence
4. Face your screen toward the receiver's camera

### Receive tab
1. Click **Start Camera** — browser requests camera permission
2. The camera captures the sender's screen
3. Detected frames are decoded, shards collected
4. When complete, click **Download received file** to save

### Web app layout

```
┌─────────────┐  ┌───────────────┐
│   ↑ SEND    │  │   ↓ RECEIVE   │
│             │  │               │
│ file picker │  │ [Start Cam]   │
│ [Prepare]   │  │               │
│             │  │ progress bar  │
│ progress    │  │               │
│   bar       │  │ ACK canvas    │
│             │  │               │
│ grid canvas │  │ [Download]    │
└─────────────┘  └───────────────┘
```

---

## Protocol details

| Property | Value |
|----------|-------|
| Grid size | 52×52 cells (50×50 payload + 2 header rows + borders) |
| Bits per cell | 6 (2 bits per RGB channel, 64 colors) |
| Payload per frame | ~2,000 bytes |
| Header | 2 rows, frame ID + type + ECC params + checksum |
| Color space | HSV classification with Euclidean nearest-neighbor |
| Registration | Green border + 4 distinct corner marker patterns |
| Rectification | 8-DOF perspective homography via DLT |
| Error correction | Reed-Solomon GF(2⁸), 16 data + 8 parity shards |
| Compression | Zstandard (level 3) |
| ACK frame | Tiny 8×8 equivalent, 1 bit/channel, robust |
| Protocol | Stop-and-wait with frame ID sequencing |

### Performance

For a 1 MB file on two laptops screen-to-camera:
- **Compression**: ~700 KB (depends on file type)
- **Shards**: ~350 frames
- **At 5-10 fps effective**: 35-70 seconds
- **ACK overhead**: negligible (ACK frame is tiny and decoded in <1 frame)

---

## Architecture

```
src/
├── main.rs         # Entry point (dispatches native or WASM)
├── lib.rs          # Shared module declarations
├── native.rs       # Native CLI app (winit + pixels + nokhwa)
├── web_app.rs      # WASM browser app (canvas + getUserMedia)
├── protocol.rs     # Frame types, headers, serde
├── encoder.rs      # Data → grid encoding, palette index conversion
├── decoder.rs      # Grid → data decoding
├── color.rs        # HSV conversion, classification, palettes
├── detection.rs    # Border detection, homography, cell sampling
├── correction.rs   # Reed-Solomon ECC wrapper
├── calibration.rs  # Palette calibration from captured frames
├── display.rs      # Native fullscreen pixel grid renderer
├── camera.rs       # Native nokhwa camera capture
└── error.rs        # Error types
```

### Shared core (works on native + WASM)
`protocol`, `encoder`, `decoder`, `color`, `detection`, `correction`, `calibration`, `error`

### Native only
`native.rs` → `display.rs` + `camera.rs` (winit/pixels/nokhwa)

### WASM only
`web_app.rs` → canvas 2D rendering + getUserMedia camera

---

## Dependencies

| Crate | Purpose | Platform |
|-------|---------|----------|
| `image` | Image buffer types | All |
| `reed-solomon-erasure` | ECC | All |
| `zstd` | Compression | All |
| `postcard` + `serde` | Serialization | All |
| `xxhash-rust` | Checksums | All |
| `winit` + `pixels` | Display rendering | Native only |
| `nokhwa` | Camera capture | Native only |
| `clap` | CLI parsing | Native only |
| `wasm-bindgen` + `web-sys` | Browser API bindings | WASM only |
| `trunk` | WASM bundler/dev server | WASM only |

---

## License

MIT
