#[derive(Debug, Clone, Copy)]
pub struct Hsv {
    pub h: f32,
    pub s: f32,
    pub v: f32,
}

pub fn rgb_to_hsv(r: u8, g: u8, b: u8) -> Hsv {
    let rf = r as f32 / 255.0;
    let gf = g as f32 / 255.0;
    let bf = b as f32 / 255.0;

    let max = rf.max(gf).max(bf);
    let min = rf.min(gf).min(bf);
    let delta = max - min;

    let h = if delta == 0.0 {
        0.0
    } else if (max - rf).abs() < f32::EPSILON {
        60.0 * (((gf - bf) / delta) % 6.0)
    } else if (max - gf).abs() < f32::EPSILON {
        60.0 * (((bf - rf) / delta) + 2.0)
    } else {
        60.0 * (((rf - gf) / delta) + 4.0)
    };

    let h = if h < 0.0 { h + 360.0 } else { h };
    let s = if max == 0.0 { 0.0 } else { delta / max };
    let v = max;

    Hsv { h, s, v }
}

#[derive(Debug, Clone)]
pub struct PaletteEntry {
    pub index: u8,
    pub reference_rgb: (u8, u8, u8),
    pub reference_hsv: Hsv,
}

/// Generates the 64-color palette (2 bits per channel: 0, 85, 170, 255)
pub fn generate_64_color_palette() -> Vec<PaletteEntry> {
    let levels = [0u8, 85, 170, 255];
    let mut palette = Vec::with_capacity(64);

    for r_idx in 0..4u8 {
        for g_idx in 0..4u8 {
            for b_idx in 0..4u8 {
                let r = levels[r_idx as usize];
                let g = levels[g_idx as usize];
                let b = levels[b_idx as usize];
                let hsv = rgb_to_hsv(r, g, b);
                let index = (r_idx << 4) | (g_idx << 2) | b_idx;
                palette.push(PaletteEntry {
                    index,
                    reference_rgb: (r, g, b),
                    reference_hsv: hsv,
                });
            }
        }
    }
    palette
}

/// Generates an 8-color palette (1 bit per channel: 0 or 255) for robust mode
pub fn generate_8_color_palette() -> Vec<PaletteEntry> {
    let mut palette = Vec::with_capacity(8);
    for r_idx in 0..2u8 {
        for g_idx in 0..2u8 {
            for b_idx in 0..2u8 {
                let r = r_idx * 255;
                let g = g_idx * 255;
                let b = b_idx * 255;
                let hsv = rgb_to_hsv(r, g, b);
                let index = (r_idx << 2) | (g_idx << 1) | b_idx;
                palette.push(PaletteEntry {
                    index,
                    reference_rgb: (r, g, b),
                    reference_hsv: hsv,
                });
            }
        }
    }
    palette
}

/// HSV euclidean distance with hue wrap-around
pub fn hsv_distance(a: &Hsv, b: &Hsv) -> f32 {
    let dh = {
        let raw = (a.h - b.h).abs();
        if raw > 180.0 { 360.0 - raw } else { raw }
    };
    let ds = a.s - b.s;
    let dv = a.v - b.v;
    (dh * dh + ds * ds + dv * dv).sqrt()
}

/// Classify an RGB pixel against a calibrated palette
/// Returns (palette_index, confidence) where confidence is 0.0-1.0
pub fn classify_cell(
    r: u8,
    g: u8,
    b: u8,
    palette: &[PaletteEntry],
) -> (u8, f32) {
    let hsv = rgb_to_hsv(r, g, b);

    // Black and near-black: treat as explicit black (index 0)
    if hsv.v < 0.08 {
        return (0, 1.0);
    }
    // Very low saturation: treat as white/gray
    if hsv.s < 0.08 {
        // Scale from black (v=0) to white (v=1)
        // Map to palette indices: black=0, dark=8, mid=16, white=63
        if hsv.v < 0.25 {
            return (0, 0.9); // index of (0,0,0) in 64-color palette
        } else if hsv.v < 0.50 {
            return (0x24, 0.7); // (85,85,85) -> index 36
        } else if hsv.v < 0.75 {
            return (0x3f, 0.7); // (170,170,170) -> index 63
        } else {
            return (0x3f, 0.9); // (255,255,255) -> index 63
        }
    }

    let mut best_idx = 0u8;
    let mut best_dist = f32::MAX;
    let mut second_dist = f32::MAX;

    for entry in palette {
        let dist = hsv_distance(&hsv, &entry.reference_hsv);
        if dist < best_dist {
            second_dist = best_dist;
            best_dist = dist;
            best_idx = entry.index;
        } else if dist < second_dist {
            second_dist = dist;
        }
    }

    let confidence = if second_dist > 0.0 {
        (1.0 - best_dist / second_dist).clamp(0.0, 1.0)
    } else {
        1.0
    };

    (best_idx, confidence)
}
