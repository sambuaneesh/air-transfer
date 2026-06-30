use crate::color::PaletteEntry;
use crate::error::Result;

#[cfg(not(target_arch = "wasm32"))]
use crate::camera::RgbImage;

/// Build a calibration mapping from a captured image of the calibration frame.
/// The calibration frame displays all palette colors in known grid positions.
#[cfg(not(target_arch = "wasm32"))]
pub fn calibrate_from_image(
    img: &RgbImage,
    palette: &[PaletteEntry],
    grid_cols: u32,
    grid_rows: u32,
) -> Result<Vec<PaletteEntry>> {
    use crate::color::rgb_to_hsv;

    let mut calibrated = Vec::with_capacity(palette.len());

    for entry in palette {
        let idx = entry.index as u32;
        let col = idx % grid_cols;
        let row = idx / grid_cols;

        let sx = (col as f32 / grid_cols as f32) * img.width() as f32;
        let sy = (row as f32 / grid_rows as f32) * img.height() as f32;
        let cell_w = img.width() as f32 / grid_cols as f32;
        let cell_h = img.height() as f32 / grid_rows as f32;

        let patch_x = ((sx + cell_w * 0.25) as u32).min(img.width() - 1);
        let patch_y = ((sy + cell_h * 0.25) as u32).min(img.height() - 1);
        let patch_w = ((cell_w * 0.5) as u32).max(1);
        let patch_h = ((cell_h * 0.5) as u32).max(1);

        let mut sum_r = 0u64;
        let mut sum_g = 0u64;
        let mut sum_b = 0u64;
        let mut count = 0u64;

        for dy in 0..patch_h {
            for dx in 0..patch_w {
                let px = (patch_x + dx).min(img.width() - 1);
                let py = (patch_y + dy).min(img.height() - 1);
                let pixel = img.get_pixel(px, py);
                sum_r += pixel[0] as u64;
                sum_g += pixel[1] as u64;
                sum_b += pixel[2] as u64;
                count += 1;
            }
        }

        if count > 0 {
            let avg_r = (sum_r / count) as u8;
            let avg_g = (sum_g / count) as u8;
            let avg_b = (sum_b / count) as u8;
            let hsv = rgb_to_hsv(avg_r, avg_g, avg_b);
            calibrated.push(PaletteEntry {
                index: entry.index,
                reference_rgb: (avg_r, avg_g, avg_b),
                reference_hsv: hsv,
            });
        }
    }

    Ok(calibrated)
}
