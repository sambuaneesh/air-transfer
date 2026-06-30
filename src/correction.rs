use reed_solomon_erasure::galois_8::ReedSolomon;

use crate::error::Result;

pub struct EccCodec {
    codec: ReedSolomon,
    data_shards: usize,
    parity_shards: usize,
}

impl EccCodec {
    pub fn new(data_shards: usize, parity_shards: usize) -> Result<Self> {
        let codec = ReedSolomon::new(data_shards, parity_shards)
            .map_err(|e| crate::error::Error::Ecc(format!("failed to create ECC codec: {e}")))?;
        Ok(Self {
            codec,
            data_shards,
            parity_shards,
        })
    }

    /// Split data into shards of equal size, then encode parity
    pub fn encode(&self, data: &[u8]) -> Result<Vec<Vec<u8>>> {
        let total_shards = self.data_shards + self.parity_shards;

        // Pad data to fill data_shards evenly
        let shard_size = (data.len() + self.data_shards - 1) / self.data_shards;
        let _padded_len = shard_size * self.data_shards;

        let mut shards: Vec<Vec<u8>> = (0..total_shards)
            .map(|_| vec![0u8; shard_size])
            .collect();

        // Copy data into first data_shards
        for (i, chunk) in data.chunks(shard_size).enumerate() {
            if i < self.data_shards {
                shards[i][..chunk.len()].copy_from_slice(chunk);
            }
        }

        // Clone into Box<[u8]> for ReedSolomon::encode
        let mut boxed: Vec<Box<[u8]>> = shards.iter().map(|s| s.clone().into_boxed_slice()).collect();

        self.codec.encode(&mut boxed)
            .map_err(|e| crate::error::Error::Ecc(format!("encode error: {e}")))?;

        Ok(boxed.into_iter().map(|b| b.into_vec()).collect())
    }

    /// Reconstruct missing/corrupt shards (None = missing)
    pub fn reconstruct(&self, shards: &[Option<Vec<u8>>]) -> Result<Vec<Vec<u8>>> {
        let total_shards = self.data_shards + self.parity_shards;
        if shards.len() != total_shards {
            return Err(crate::error::Error::Ecc(format!(
                "expected {} shards, got {}",
                total_shards,
                shards.len()
            )));
        }

        let shard_size = shards
            .iter()
            .find_map(|s| s.as_ref().map(|v| v.len()))
            .unwrap_or(0);

        if shard_size == 0 {
            return Err(crate::error::Error::Ecc("all shards are empty".to_string()));
        }

        let mut boxed: Vec<Option<Box<[u8]>>> = shards
            .iter()
            .map(|s| {
                s.as_ref().map(|v| v.clone().into_boxed_slice())
            })
            .collect();

        self.codec.reconstruct(&mut boxed)
            .map_err(|e| crate::error::Error::Ecc(format!("reconstruct error: {e}")))?;

        Ok(boxed
            .into_iter()
            .map(|b| b.unwrap_or_else(|| vec![0u8; shard_size].into_boxed_slice()).into_vec())
            .collect())
    }

    pub fn extract_data(&self, shards: &[Vec<u8>], original_len: usize) -> Vec<u8> {
        let mut data = Vec::with_capacity(original_len);
        for shard in shards.iter().take(self.data_shards) {
            data.extend_from_slice(shard);
        }
        data.truncate(original_len);
        data
    }
}
