use crate::encoder::unpack_indices_to_bytes;
use crate::protocol::{FrameHeader, FrameType, HEADER_ROWS};

#[derive(Debug)]
pub struct DecodedFrame {
    pub header: FrameHeader,
    pub payload: Vec<u8>,
}

/// Extract cell indices from a rectified grid (row-major order of palette indices)
pub fn decode_grid(
    cell_indices: &[u8],
    cols: u32,
    _rows: u32,
) -> Option<DecodedFrame> {
    if cell_indices.len() < (HEADER_ROWS * cols) as usize {
        return None;
    }

    let bits_per_cell = 6u32;
    let header_cells = (HEADER_ROWS * cols) as usize;
    let header_indices: Vec<u8> = cell_indices[..header_cells].to_vec();
    let header_bytes = unpack_indices_to_bytes(&header_indices, bits_per_cell);

    let header = FrameHeader::from_bytes(&header_bytes)?;

    if header.frame_type != FrameType::Data {
        return Some(DecodedFrame {
            header,
            payload: vec![],
        });
    }

    let payload_start = header_cells;
    let payload_indices: Vec<u8> = cell_indices[payload_start..].to_vec();
    let payload = unpack_indices_to_bytes(&payload_indices, bits_per_cell);

    // Trim to data_len
    let payload = if header.data_len as usize <= payload.len() {
        payload[..header.data_len as usize].to_vec()
    } else {
        payload
    };

    Some(DecodedFrame { header, payload })
}
