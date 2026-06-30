use serde::{Deserialize, Serialize};

pub const GRID_COLS: u32 = 50;
pub const GRID_ROWS: u32 = 50;
pub const HEADER_ROWS: u32 = 2;
pub const ECC_PARITY_SHARDS: usize = 8;
pub const ECC_DATA_SHARDS: usize = 16;
pub const CELL_BITS: u32 = 6;
pub const REF_CELL_INTERVAL: u32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FrameType {
    Data = 0,
    Ack = 1,
    Handshake = 2,
    Calibration = 3,
}

impl FrameType {
    pub fn from_bits(bits: u8) -> Option<Self> {
        match bits {
            0 => Some(Self::Data),
            1 => Some(Self::Ack),
            2 => Some(Self::Handshake),
            3 => Some(Self::Calibration),
            _ => None,
        }
    }

    pub fn to_bits(self) -> u8 {
        self as u8
    }
}

/// Header stored in the first HEADER_ROWS of the grid
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameHeader {
    pub frame_id: u16,
    pub frame_type: FrameType,
    pub payload_shards: u8,
    pub total_shards: u8,
    pub shard_index: u8,
    pub data_len: u16,
    pub checksum: u32,
}

/// A data shard after ECC encoding
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataShard {
    pub frame_id: u16,
    pub shard_index: u8,
    pub total_shards: u8,
    pub data: Vec<u8>,
}

/// Protocol state for send side
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendState {
    Idle,
    WaitingForHandshake,
    Sending,
    WaitingForAck,
}

/// Protocol state for receive side
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiveState {
    Idle,
    WaitingForData,
    Decoding,
}

impl FrameHeader {
    /// Serialize header into a compact byte representation for grid encoding
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(10);
        buf.extend_from_slice(&self.frame_id.to_le_bytes());
        buf.push(self.frame_type.to_bits());
        buf.push(self.payload_shards);
        buf.push(self.total_shards);
        buf.push(self.shard_index);
        buf.extend_from_slice(&self.data_len.to_le_bytes());
        buf.extend_from_slice(&self.checksum.to_le_bytes());
        buf
    }

    /// Deserialize header from bytes extracted from grid
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() < 10 {
            return None;
        }
        let frame_id = u16::from_le_bytes([data[0], data[1]]);
        let frame_type = FrameType::from_bits(data[2])?;
        Some(Self {
            frame_id,
            frame_type,
            payload_shards: data[3],
            total_shards: data[4],
            shard_index: data[5],
            data_len: u16::from_le_bytes([data[6], data[7]]),
            checksum: u32::from_le_bytes([data[8], data[9], 0, 0]),
        })
    }
}
