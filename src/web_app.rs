use crate::{
    color, correction, decoder, detection, encoder, error, protocol,
};
use std::sync::{Arc, Mutex};
use wasm_bindgen::prelude::*;
use web_sys::{
    CanvasRenderingContext2d, HtmlCanvasElement, HtmlVideoElement, ImageData,
    MediaStreamConstraints,
};

mod entry {
    use super::*;

    #[wasm_bindgen(start)]
    pub fn start() -> Result<(), JsValue> {
        console_error_panic_hook::set_once();
        let _ = web_sys::console::log_1(&"air-transfer web app initialized".into());
        Ok(())
    }
}

#[wasm_bindgen]
pub struct WebApp {
    palette: Vec<color::PaletteEntry>,
    send_state: Arc<Mutex<Option<WebSendState>>>,
    recv_state: Arc<Mutex<Option<WebRecvState>>>,
}

struct WebSendState {
    grids: Vec<Vec<u8>>,
    current: usize,
    done: bool,
}

struct WebRecvState {
    shards: Vec<Option<Vec<u8>>>,
    total_shards: u32,
    data_len: u32,
    last_frame: Option<u16>,
    output_data: Option<Vec<u8>>,
    output_name: String,
    done: bool,
}

#[wasm_bindgen]
impl WebApp {
    pub fn new() -> Result<WebApp, JsValue> {
        let palette = color::generate_64_color_palette();
        Ok(WebApp {
            palette,
            send_state: Arc::new(Mutex::new(None)),
            recv_state: Arc::new(Mutex::new(None)),
        })
    }

    pub fn prepare_send(&self, data: Vec<u8>) -> Result<u32, JsValue> {
        let compressed = zstd::encode_all(&data[..], 3)
            .map_err(|e| JsValue::from_str(&format!("compress error: {e}")))?;
        let original_len = compressed.len();

        let ecc = correction::EccCodec::new(
            protocol::ECC_DATA_SHARDS,
            protocol::ECC_PARITY_SHARDS,
        ).map_err(|e| JsValue::from_str(&format!("ecc error: {e}")))?;

        let all_shards = ecc.encode(&compressed)
            .map_err(|e| JsValue::from_str(&format!("encode error: {e}")))?;
        let total_shards = all_shards.len();

        let grids: Vec<Vec<u8>> = all_shards.iter().enumerate().map(|(i, shard)| {
            let header = protocol::FrameHeader {
                frame_id: i as u16,
                frame_type: protocol::FrameType::Data,
                payload_shards: total_shards as u8,
                total_shards: total_shards as u8,
                shard_index: i as u8,
                data_len: original_len as u16,
                checksum: xxhash_rust::xxh3::xxh3_64(shard) as u32,
            };
            encoder::build_grid(&header, shard, 6)
        }).collect();

        let count = grids.len() as u32;
        let mut state = self.send_state.lock().unwrap();
        *state = Some(WebSendState {
            grids,
            current: 0,
            done: false,
        });

        Ok(count)
    }

    pub fn render_send_frame(&self, canvas: &HtmlCanvasElement) -> Result<bool, JsValue> {
        let state = self.send_state.lock().unwrap();
        let Some(ref s) = *state else {
            return Ok(false);
        };
        if s.done || s.current >= s.grids.len() {
            return Ok(false);
        }

        let grid = &s.grids[s.current];
        render_grid_to_canvas(canvas, grid, 50, 50)?;
        Ok(true)
    }

    pub fn advance_send_frame(&self) -> bool {
        let mut state = self.send_state.lock().unwrap();
        if let Some(ref mut s) = *state {
            if s.current + 1 >= s.grids.len() {
                s.done = true;
                false
            } else {
                s.current += 1;
                true
            }
        } else {
            false
        }
    }

    pub fn send_current(&self) -> u32 {
        self.send_state.lock().unwrap()
            .as_ref().map(|s| s.current as u32).unwrap_or(0)
    }

    pub fn send_total(&self) -> u32 {
        self.send_state.lock().unwrap()
            .as_ref().map(|s| s.grids.len() as u32).unwrap_or(0)
    }

    pub fn send_done(&self) -> bool {
        self.send_state.lock().unwrap().as_ref().map(|s| s.done).unwrap_or(false)
    }

    pub fn init_receive(&self) {
        let mut state = self.recv_state.lock().unwrap();
        *state = Some(WebRecvState {
            shards: vec![],
            total_shards: 0,
            data_len: 0,
            last_frame: None,
            output_data: None,
            output_name: String::new(),
            done: false,
        });
    }

    pub fn process_camera_frame(
        &self,
        img_data: &ImageData,
    ) -> Option<ReceivedFrameInfo> {
        let mut recv = self.recv_state.lock().unwrap();
        let Some(ref mut state) = *recv else {
            return None;
        };
        if state.done {
            return None;
        }

        let width = img_data.width();
        let height = img_data.height();
        let data = img_data.data();

        let (indices, _confs) = detection_from_imagedata(&data, width, height, &self.palette);

        let Some(decoded) = decoder::decode_grid(&indices, 50, 50) else {
            return None;
        };

        let header = decoded.header;
        if header.frame_type != protocol::FrameType::Data {
            return None;
        }

        let fid = header.frame_id;
        let is_new = match state.last_frame {
            Some(prev) if fid == prev => false,
            _ => {
                state.last_frame = Some(fid);
                true
            }
        };

        if !is_new {
            return Some(ReceivedFrameInfo {
                frame_id: fid,
                shard_index: header.shard_index as u32,
                total_shards: header.total_shards as u32,
                is_new: false,
                ack_needed: false,
            });
        }

        state.total_shards = header.total_shards as u32;
        state.data_len = header.data_len as u32;

        if state.shards.is_empty() {
            state.shards = vec![None; header.total_shards as usize];
        }
        if (header.shard_index as usize) < state.shards.len() {
            state.shards[header.shard_index as usize] = Some(decoded.payload.clone());
        }

        let complete = state.shards.iter().all(|s| s.is_some());
        if complete {
            let ecc_result = correction::EccCodec::new(
                protocol::ECC_DATA_SHARDS,
                protocol::ECC_PARITY_SHARDS,
            );

            if let Ok(ecc) = ecc_result {
                let all_vecs: Vec<Vec<u8>> = state.shards.iter()
                    .map(|s| s.clone().unwrap_or_default())
                    .collect();

                let orig_len = state.data_len as usize;
                let recovered = ecc.extract_data(&all_vecs, orig_len);

                match zstd::decode_all(&recovered[..]) {
                    Ok(decompressed) => {
                        state.output_data = Some(decompressed);
                        state.done = true;
                    }
                    Err(e) => {
                        let _ = web_sys::console::log_1(&format!("decompress error: {e}").into());
                    }
                }
            }
        }

        Some(ReceivedFrameInfo {
            frame_id: fid,
            shard_index: header.shard_index as u32,
            total_shards: header.total_shards as u32,
            is_new: true,
            ack_needed: true,
        })
    }

    pub fn get_ack_grid(&self, frame_id: u16) -> Vec<u8> {
        encoder::build_ack_grid(frame_id, true)
    }

    pub fn get_handshake_grid(&self) -> Vec<u8> {
        encoder::build_handshake_grid()
    }

    pub fn set_output_name(&self, name: &str) {
        let mut state = self.recv_state.lock().unwrap();
        if let Some(ref mut s) = *state {
            s.output_name = name.to_string();
        }
    }

    pub fn get_received_data(&self) -> Option<Vec<u8>> {
        let state = self.recv_state.lock().unwrap();
        state.as_ref().and_then(|s| s.output_data.clone())
    }

    pub fn recv_done(&self) -> bool {
        self.recv_state.lock().unwrap().as_ref().map(|s| s.done).unwrap_or(false)
    }

    pub fn recv_received(&self) -> u32 {
        let state = self.recv_state.lock().unwrap();
        state.as_ref()
            .map(|s| s.shards.iter().filter(|x| x.is_some()).count() as u32)
            .unwrap_or(0)
    }

    pub fn recv_total(&self) -> u32 {
        let state = self.recv_state.lock().unwrap();
        state.as_ref().map(|s| s.shards.len() as u32).unwrap_or(0)
    }
}

// ---- Canvas rendering ----

pub fn render_grid_to_canvas(
    canvas: &HtmlCanvasElement,
    grid: &[u8],
    cols: u32,
    rows: u32,
) -> Result<(), JsValue> {
    let ctx: CanvasRenderingContext2d = canvas
        .get_context("2d")?
        .ok_or_else(|| JsValue::from_str("no 2d context"))?
        .unchecked_into();

    let cell_size: f64 = 12.0;
    let border_cells: f64 = 6.0; // quiet + border + corner
    let total_cells: f64 = 60.0;
    let canvas_size: f64 = total_cells * cell_size;

    canvas.set_width(canvas_size as u32);
    canvas.set_height(canvas_size as u32);

    // Black background
    ctx.set_fill_style(&JsValue::from_str("black"));
    ctx.fill_rect(0.0, 0.0, canvas_size, canvas_size);

    // Green registration border
    ctx.set_fill_style(&JsValue::from_str("#00ff00"));
    let b = 2.0 * cell_size;
    ctx.fill_rect(b, b, canvas_size - 2.0 * b, 2.0 * cell_size);
    ctx.fill_rect(b, b, 2.0 * cell_size, canvas_size - 2.0 * b);
    ctx.fill_rect(canvas_size - b - 2.0 * cell_size, b, 2.0 * cell_size, canvas_size - 2.0 * b);
    ctx.fill_rect(b, canvas_size - b - 2.0 * cell_size, canvas_size - 2.0 * b, 2.0 * cell_size);

    // Corner markers
    let cx = b + 2.0 * cell_size;
    let cy = cx;
    draw_cell(&ctx, cx, cy, cell_size, 255, 0, 0);
    draw_cell(&ctx, cx + cell_size, cy, cell_size, 0, 0, 255);
    draw_cell(&ctx, cx, cy + cell_size, cell_size, 0, 0, 255);
    draw_cell(&ctx, cx + cell_size, cy + cell_size, cell_size, 255, 0, 0);

    let rx = canvas_size - b - 2.0 * cell_size - 2.0 * cell_size;
    draw_cell(&ctx, rx, cy, cell_size, 0, 255, 0);
    draw_cell(&ctx, rx + cell_size, cy, cell_size, 255, 255, 255);
    draw_cell(&ctx, rx, cy + cell_size, cell_size, 255, 255, 255);
    draw_cell(&ctx, rx + cell_size, cy + cell_size, cell_size, 0, 255, 0);

    let by = canvas_size - b - 2.0 * cell_size - 2.0 * cell_size;
    draw_cell(&ctx, cx, by, cell_size, 255, 255, 0);
    draw_cell(&ctx, cx + cell_size, by, cell_size, 0, 255, 255);
    draw_cell(&ctx, cx, by + cell_size, cell_size, 0, 255, 255);
    draw_cell(&ctx, cx + cell_size, by + cell_size, cell_size, 255, 255, 0);

    draw_cell(&ctx, rx, by, cell_size, 255, 0, 255);
    draw_cell(&ctx, rx + cell_size, by, cell_size, 0, 0, 0);
    draw_cell(&ctx, rx, by + cell_size, cell_size, 0, 0, 0);
    draw_cell(&ctx, rx + cell_size, by + cell_size, cell_size, 255, 0, 255);

    // Render payload grid
    let offset = cx + 2.0 * cell_size;
    for row in 0..rows {
        for col in 0..cols {
            let idx = (row * cols + col) as usize;
            if idx < grid.len() {
                let color = grid[idx];
                let (r, g, b) = crate::encoder::palette_index_to_rgb(color);
                let x = offset + col as f64 * cell_size;
                let y = offset + row as f64 * cell_size;
                draw_cell(&ctx, x, y, cell_size, r, g, b);
            }
        }
    }

    Ok(())
}

fn draw_cell(ctx: &CanvasRenderingContext2d, x: f64, y: f64, size: f64, r: u8, g: u8, b: u8) {
    let color = format!("#{r:02x}{g:02x}{b:02x}");
    ctx.set_fill_style(&JsValue::from_str(&color));
    ctx.fill_rect(x, y, size, size);
}

// ---- Detection from ImageData ----
// In browser: assume camera sees the screen fairly well-aligned

fn detection_from_imagedata(
    data: &[u8],
    width: u32,
    height: u32,
    palette: &[color::PaletteEntry],
) -> (Vec<u8>, Vec<f32>) {
    let cols = 50u32;
    let rows = 50u32;
    let mut indices = Vec::with_capacity((cols * rows) as usize);
    let mut confs = Vec::with_capacity((cols * rows) as usize);

    let margin_x = width as f32 * 0.15;
    let margin_y = height as f32 * 0.15;
    let usable_w = width as f32 - 2.0 * margin_x;
    let usable_h = height as f32 - 2.0 * margin_y;
    let cell_w = usable_w / cols as f32;
    let cell_h = usable_h / rows as f32;

    for row in 0..rows {
        for col in 0..cols {
            let sx = (margin_x + col as f32 * cell_w + cell_w * 0.5) as u32;
            let sy = (margin_y + row as f32 * cell_h + cell_h * 0.5) as u32;

            let mut sum_r = 0u32;
            let mut sum_g = 0u32;
            let mut sum_b = 0u32;
            let mut count = 0u32;
            let patch: i32 = 3;

            for dy in -patch..=patch {
                for dx in -patch..=patch {
                    let px = (sx as i32 + dx).clamp(0, width as i32 - 1) as u32;
                    let py = (sy as i32 + dy).clamp(0, height as i32 - 1) as u32;
                    let idx = ((py * width + px) * 4) as usize;
                    if idx + 2 < data.len() {
                        sum_r += data[idx] as u32;
                        sum_g += data[idx + 1] as u32;
                        sum_b += data[idx + 2] as u32;
                        count += 1;
                    }
                }
            }

            let r = (sum_r / count) as u8;
            let g = (sum_g / count) as u8;
            let b = (sum_b / count) as u8;

            let (idx, conf) = color::classify_cell(r, g, b, palette);
            indices.push(idx);
            confs.push(conf);
        }
    }

    (indices, confs)
}

#[wasm_bindgen]
#[derive(Clone)]
pub struct ReceivedFrameInfo {
    pub frame_id: u16,
    pub shard_index: u32,
    pub total_shards: u32,
    pub is_new: bool,
    pub ack_needed: bool,
}

#[wasm_bindgen]
impl ReceivedFrameInfo {
    pub fn frame_id(&self) -> u16 { self.frame_id }
    pub fn shard_index(&self) -> u32 { self.shard_index }
    pub fn total_shards(&self) -> u32 { self.total_shards }
    pub fn is_new(&self) -> bool { self.is_new }
    pub fn ack_needed(&self) -> bool { self.ack_needed }
}
