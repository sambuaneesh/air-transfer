use pixels::{Pixels, PixelsBuilder, SurfaceTexture};
use winit::window::{Fullscreen, Window, WindowAttributes};

pub use crate::encoder::palette_index_to_rgb;
use crate::error::Result;

const GRID_CELLS: u32 = 52;
const BORDER_CELLS: u32 = 2;
const CORNER_CELLS: u32 = 2;
const QUIET_CELLS: u32 = 2;
const CELL_PIXELS: u32 = 12;

fn total_cells() -> u32 {
    GRID_CELLS + 2 * (BORDER_CELLS + QUIET_CELLS + CORNER_CELLS)
}

pub fn grid_width() -> u32 {
    total_cells() * CELL_PIXELS
}

pub fn grid_height() -> u32 {
    total_cells() * CELL_PIXELS
}

/// Renderer: `pixels` borrows `window` via SurfaceTexture.
/// Declaration order ensures `pixels` drops before `window`.
pub struct Renderer {
    pixels: Pixels<'static>,
    window: Window,
}

impl Renderer {
    pub fn new(
        fullscreen: bool,
        event_loop: &winit::event_loop::ActiveEventLoop,
    ) -> Result<Self> {
        let width = grid_width();
        let height = grid_height();

        let mut attrs = WindowAttributes::default()
            .with_title("air-transfer")
            .with_inner_size(winit::dpi::LogicalSize::new(width, height))
            .with_resizable(false);

        if fullscreen {
            attrs = attrs.with_fullscreen(Some(Fullscreen::Borderless(None)));
        }

        let window = event_loop
            .create_window(attrs)
            .map_err(|e| crate::error::Error::Display(format!("failed to create window: {e}")))?;

        let surface_texture = SurfaceTexture::new(width, height, &window);

        let pixels = PixelsBuilder::new(width, height, surface_texture)
            .request_adapter_options(pixels::wgpu::RequestAdapterOptions {
                power_preference: pixels::wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .build()
            .map_err(|e| crate::error::Error::Display(format!("failed to create pixels: {e}")))?;

        // SAFETY: `pixels` borrows `window` via SurfaceTexture. Struct layout ensures
        // `pixels` is dropped before `window` (fields dropped in declaration order).
        // We never move `window` out of the struct while `pixels` is alive.
        let pixels: Pixels<'static> = unsafe { std::mem::transmute(pixels) };

        Ok(Self { pixels, window })
    }

    pub fn frame_buffer(&mut self) -> &mut [u8] {
        self.pixels.frame_mut()
    }

    pub fn render(&mut self) -> Result<()> {
        self.pixels
            .render()
            .map_err(|e| crate::error::Error::Display(format!("render error: {e}")))?;
        Ok(())
    }

    pub fn window(&self) -> &Window {
        &self.window
    }
}

pub fn fill_cell(buf: &mut [u8], width: u32, cell_x: u32, cell_y: u32, r: u8, g: u8, b: u8) {
    let x_start = cell_x * CELL_PIXELS;
    let y_start = cell_y * CELL_PIXELS;

    for dy in 0..CELL_PIXELS {
        for dx in 0..CELL_PIXELS {
            let px = x_start + dx;
            let py = y_start + dy;
            let idx = ((py * width + px) * 4) as usize;
            if idx + 3 < buf.len() {
                buf[idx] = r;
                buf[idx + 1] = g;
                buf[idx + 2] = b;
                buf[idx + 3] = 255;
            }
        }
    }
}

pub fn render_grid(
    buf: &mut [u8],
    screen_width: u32,
    grid: &[u8],
    grid_cols: u32,
    grid_rows: u32,
) {
    let total = total_cells();

    for y in 0..total {
        for x in 0..total {
            let in_border_region = (x >= QUIET_CELLS && x < total - QUIET_CELLS)
                && (y >= QUIET_CELLS && y < total - QUIET_CELLS);
            let in_border_stripe = (x >= QUIET_CELLS && x < QUIET_CELLS + BORDER_CELLS)
                || (x >= total - QUIET_CELLS - BORDER_CELLS && x < total - QUIET_CELLS)
                || (y >= QUIET_CELLS && y < QUIET_CELLS + BORDER_CELLS)
                || (y >= total - QUIET_CELLS - BORDER_CELLS && y < total - QUIET_CELLS);

            if !in_border_region {
                fill_cell(buf, screen_width, x, y, 0, 0, 0);
            } else if in_border_stripe {
                fill_cell(buf, screen_width, x, y, 0, 255, 0);
            }
        }
    }

    let tl_x = QUIET_CELLS + BORDER_CELLS;
    let tl_y = QUIET_CELLS + BORDER_CELLS;
    let tr_x = total - QUIET_CELLS - BORDER_CELLS - CORNER_CELLS;
    let tr_y = QUIET_CELLS + BORDER_CELLS;
    let bl_x = QUIET_CELLS + BORDER_CELLS;
    let bl_y = total - QUIET_CELLS - BORDER_CELLS - CORNER_CELLS;

    fill_cell(buf, screen_width, tl_x, tl_y, 255, 0, 0);
    fill_cell(buf, screen_width, tl_x + 1, tl_y, 0, 0, 255);
    fill_cell(buf, screen_width, tl_x, tl_y + 1, 0, 0, 255);
    fill_cell(buf, screen_width, tl_x + 1, tl_y + 1, 255, 0, 0);

    fill_cell(buf, screen_width, tr_x, tr_y, 0, 255, 0);
    fill_cell(buf, screen_width, tr_x + 1, tr_y, 255, 255, 255);
    fill_cell(buf, screen_width, tr_x, tr_y + 1, 255, 255, 255);
    fill_cell(buf, screen_width, tr_x + 1, tr_y + 1, 0, 255, 0);

    fill_cell(buf, screen_width, bl_x, bl_y, 255, 255, 0);
    fill_cell(buf, screen_width, bl_x + 1, bl_y, 0, 255, 255);
    fill_cell(buf, screen_width, bl_x, bl_y + 1, 0, 255, 255);
    fill_cell(buf, screen_width, bl_x + 1, bl_y + 1, 255, 255, 0);

    let br_x = tr_x;
    let br_y = bl_y;
    fill_cell(buf, screen_width, br_x, br_y, 255, 0, 255);
    fill_cell(buf, screen_width, br_x + 1, br_y, 0, 0, 0);
    fill_cell(buf, screen_width, br_x, br_y + 1, 0, 0, 0);
    fill_cell(buf, screen_width, br_x + 1, br_y + 1, 255, 0, 255);

    let data_offset_x = QUIET_CELLS + BORDER_CELLS + CORNER_CELLS;
    let data_offset_y = QUIET_CELLS + BORDER_CELLS + CORNER_CELLS;

    for row in 0..grid_rows {
        for col in 0..grid_cols {
            let idx = (row * grid_cols + col) as usize;
            if idx >= grid.len() {
                continue;
            }
            let color_byte = grid[idx];
            let (r, g, b) = palette_index_to_rgb(color_byte);
            fill_cell(
                buf,
                screen_width,
                data_offset_x + col,
                data_offset_y + row,
                r, g, b,
            );
        }
    }
}


