#!/usr/bin/env bash
set -euo pipefail

APP="air-transfer"
VERSION="${VERSION:-0.1.0}"
RELEASE_DIR="target/release-packages"

PLATFORMS=(
    "linux:x86_64-unknown-linux-gnu"
    "windows:x86_64-pc-windows-gnu"
)

echo "=== $APP v$VERSION release builder ==="
echo ""

check_prereq() {
    local target="$1"
    case "$target" in
        x86_64-pc-windows-gnu)
            if ! command -v x86_64-w64-mingw32-gcc &>/dev/null; then
                echo "  [WARN] mingw-w64 not found - skipping Windows build"
                echo "    Install: sudo pacman -S mingw-w64-gcc   (Arch)"
                echo "             sudo apt install mingw-w64      (Debian/Ubuntu)"
                return 1
            fi
            ;;
    esac
    return 0
}

rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

BUILT=0

for entry in "${PLATFORMS[@]}"; do
    PLATFORM="${entry%%:*}"
    TARGET="${entry##*:}"

    if ! check_prereq "$TARGET"; then
        continue
    fi

    echo ""
    echo "--- Building $APP for $PLATFORM ($TARGET) ---"

    cargo build --release --target "$TARGET"

    BIN_DIR="$RELEASE_DIR/$PLATFORM"
    mkdir -p "$BIN_DIR"

    BINARY="target/$TARGET/release/$APP"
    if [[ "$PLATFORM" == "windows" ]]; then
        cp "$BINARY.exe" "$BIN_DIR/$APP.exe"
    else
        cp "$BINARY" "$BIN_DIR/$APP"
    fi

    cp README.md "$BIN_DIR/"
    echo "MIT License" > "$BIN_DIR/LICENSE"

    echo "  -> $BIN_DIR/"
    BUILT=$((BUILT + 1))
done

# Package archives
echo ""
echo "=== Creating archives ==="

for dir in "$RELEASE_DIR"/*/; do
    [ -d "$dir" ] || continue
    platform=$(basename "$dir")

    if [[ "$platform" == "windows" ]]; then
        archive="$RELEASE_DIR/${APP}-v${VERSION}-windows-x86_64.zip"
        zip -rj "$archive" "$dir/"
    else
        archive="$RELEASE_DIR/${APP}-v${VERSION}-linux-x86_64.tar.gz"
        tar -czf "$archive" -C "$dir" .
    fi
    echo "  $archive"
done

echo ""
if [[ $BUILT -gt 0 ]]; then
    echo "=== Done: $BUILT platform(s) built ==="
    ls -lh "$RELEASE_DIR"/air-transfer-v* 2>/dev/null
else
    echo "=== No builds produced. Install toolchains first ==="
fi
