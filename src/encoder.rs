use crate::color::PaletteEntry;
use crate::protocol::{
    FrameHeader, FrameType, GRID_COLS, GRID_ROWS, HEADER_ROWS,
    REF_CELL_INTERVAL,
};

/// Pack bits into palette-indices (6 bits per cell for 2-bit/channel)
pub fn pack_bits_into_indices(data: &[u8], bits_per_cell: u32) -> Vec<u8> {
    assert!(bits_per_cell <= 8);
    let mut indices = Vec::new();
    let mut bit_buf: u16 = 0;
    let mut bit_count: u32 = 0;

    for &byte in data {
        bit_buf = (bit_buf << 8) | byte as u16;
        bit_count += 8;

        while bit_count >= bits_per_cell {
            bit_count -= bits_per_cell;
            let idx = ((bit_buf >> bit_count) & ((1 << bits_per_cell) - 1)) as u8;
            indices.push(idx);
        }
    }

    if bit_count > 0 {
        let idx = ((bit_buf & ((1 << bit_count) - 1)) << (bits_per_cell - bit_count)) as u8;
        indices.push(idx);
    }

    indices
}

/// Unpack palette indices back into bytes
pub fn unpack_indices_to_bytes(indices: &[u8], bits_per_cell: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut bit_buf: u16 = 0;
    let mut bit_count: u32 = 0;

    for &idx in indices {
        bit_buf = (bit_buf << bits_per_cell) | idx as u16;
        bit_count += bits_per_cell;

        while bit_count >= 8 {
            bit_count -= 8;
            bytes.push(((bit_buf >> bit_count) & 0xFF) as u8);
        }
    }

    bytes
}

/// Build a full grid of palette indices from a frame header and payload data
pub fn build_grid(
    header: &FrameHeader,
    payload: &[u8],
    bits_per_cell: u32,
) -> Vec<u8> {
    let total_cells = (GRID_COLS * GRID_ROWS) as usize;
    let mut grid = vec![0u8; total_cells];

    // Encode header into first HEADER_ROWS rows
    let header_bytes = header.to_bytes();
    let header_indices = pack_bits_into_indices(&header_bytes, bits_per_cell);
    let header_cells = HEADER_ROWS as usize * GRID_COLS as usize;

    for (i, &idx) in header_indices.iter().enumerate() {
        if i < header_cells {
            grid[i] = idx;
        }
    }

    // Encode payload
    let payload_indices = pack_bits_into_indices(payload, bits_per_cell);
    let payload_start = header_cells;

    for (i, &idx) in payload_indices.iter().enumerate() {
        let grid_idx = payload_start + i;
        if grid_idx < total_cells {
            grid[grid_idx] = idx;
        }
    }

    // Place reference cells (every REF_CELL_INTERVAL-th row/col)
    // Reference cells use known indices for calibration tracking
    let ref_indices: [u8; 4] = [0x00, 0x15, 0x2A, 0x3F];
    for row in 0..GRID_ROWS {
        for col in 0..GRID_COLS {
            if row % REF_CELL_INTERVAL == 0 && col % REF_CELL_INTERVAL == 0 {
                let ref_idx_idx = ((row / REF_CELL_INTERVAL) + (col / REF_CELL_INTERVAL)) % 4;
                grid[(row * GRID_COLS + col) as usize] = ref_indices[ref_idx_idx as usize];
            }
        }
    }

    grid
}

/// Convert a 6-bit palette index (2 bits per channel) to RGB
pub fn palette_index_to_rgb(idx: u8) -> (u8, u8, u8) {
    let r = ((idx >> 4) & 0x03) * 85;
    let g = ((idx >> 2) & 0x03) * 85;
    let b = (idx & 0x03) * 85;
    (r, g, b)
}

/// Render grid to RGBA buffer for display
pub fn grid_to_rgba(grid: &[u8], cols: u32, rows: u32) -> Vec<u8> {
    let mut buf = vec![0u8; (cols * rows * 4) as usize];
    for row in 0..rows {
        for col in 0..cols {
            let idx = (row * cols + col) as usize;
            if idx < grid.len() {
                let (r, g, b) = palette_index_to_rgb(grid[idx]);
                let px = (idx * 4) as usize;
                buf[px] = r;
                buf[px + 1] = g;
                buf[px + 2] = b;
                buf[px + 3] = 255;
            }
        }
    }
    buf
}

/// Build an ACK frame grid (tiny, robust)
pub fn build_ack_grid(frame_id: u16, success: bool) -> Vec<u8> {
    let ack_type: u8 = if success { 0 } else { 1 };
    let header = FrameHeader {
        frame_id,
        frame_type: FrameType::Ack,
        payload_shards: 1,
        total_shards: 1,
        shard_index: 0,
        data_len: 1,
        checksum: ack_type as u32,
    };
    build_grid(&header, &[ack_type], 6)
}

/// Build a handshake frame grid
pub fn build_handshake_grid() -> Vec<u8> {
    let header = FrameHeader {
        frame_id: 0,
        frame_type: FrameType::Handshake,
        payload_shards: 0,
        total_shards: 0,
        shard_index: 0,
        data_len: 0,
        checksum: 0,
    };
    build_grid(&header, &[], 6)
}

/// Build a calibration frame grid with all palette colors in known positions
pub fn build_calibration_grid(palette: &[PaletteEntry]) -> Vec<u8> {
    let header = FrameHeader {
        frame_id: 1,
        frame_type: FrameType::Calibration,
        payload_shards: 0,
        total_shards: 0,
        shard_index: 0,
        data_len: palette.len() as u16,
        checksum: 0,
    };
    let total_cells = (GRID_COLS * GRID_ROWS) as usize;
    let mut grid = vec![0u8; total_cells];

    // Place palette colors in grid
    for (i, entry) in palette.iter().enumerate() {
        if i < total_cells {
            grid[i] = entry.index;
        }
    }

    // Overwrite first rows with header
    let header_bytes = header.to_bytes();
    let header_indices = pack_bits_into_indices(&header_bytes, 6);
    for (i, &idx) in header_indices.iter().enumerate() {
        let header_cells = HEADER_ROWS as usize * GRID_COLS as usize;
        if i < header_cells {
            grid[i] = idx;
        }
    }

    grid
}
