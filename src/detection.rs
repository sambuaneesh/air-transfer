use image::RgbImage;

use crate::color::{PaletteEntry, classify_cell, rgb_to_hsv};

/// A detected quadrilateral in the image
#[derive(Debug, Clone)]
pub struct Quad {
    pub corners: [(f32, f32); 4],
}

/// Homography matrix (3×3, row-major)
#[derive(Debug, Clone)]
pub struct Homography {
    m: [f32; 9],
}

impl Homography {
    /// Compute homography from 4 point correspondences using DLT
    pub fn from_points(src: &[(f32, f32); 4], dst: &[(f32, f32); 4]) -> Option<Self> {
        let mut a = [[0.0f32; 9]; 8];

        for i in 0..4 {
            let (x, y) = src[i];
            let (u, v) = dst[i];

            a[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, -u];
            a[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, -v];
        }

        // Solve A*h = 0 using power iteration on A^T*A
        // Simple: use SVD-like approach via normalization + least squares
        // We normalize points for numerical stability

        let (sx, sy, src_norm) = normalize_points(src);
        let (dx, dy, dst_norm) = normalize_points(dst);

        let mut an = [[0.0f32; 9]; 8];
        for i in 0..4 {
            let (x, y) = src_norm[i];
            let (u, v) = dst_norm[i];
            an[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, -u];
            an[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, -v];
        }

        // Build ATA (9×9)
        let mut ata = [[0.0f32; 9]; 9];
        for i in 0..9 {
            for j in 0..9 {
                let mut sum = 0.0;
                for k in 0..8 {
                    sum += an[k][i] * an[k][j];
                }
                ata[i][j] = sum;
            }
        }

        // Power iteration to find smallest eigenvector
        let mut v = [1.0f32; 9];
        for _ in 0..20 {
            let mut new_v = [0.0f32; 9];
            for i in 0..9 {
                for j in 0..9 {
                    new_v[i] += ata[i][j] * v[j];
                }
            }
            // Normalize
            let norm: f32 = new_v.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm < 1e-10 {
                break;
            }
            for i in 0..9 {
                new_v[i] /= norm;
            }
            v = new_v;
        }

        let mut h_flat = [0.0f32; 9];
        for i in 0..9 {
            h_flat[i] = v[i];
        }

        // Denormalize
        let h = denormalize_homography(&h_flat, sx, sy, dx, dy);

        Some(Self { m: h })
    }

    /// Apply homography to transform a point
    pub fn transform(&self, x: f32, y: f32) -> (f32, f32) {
        let w = self.m[6] * x + self.m[7] * y + self.m[8];
        if w.abs() < 1e-8 {
            return (0.0, 0.0);
        }
        let u = (self.m[0] * x + self.m[1] * y + self.m[2]) / w;
        let v = (self.m[3] * x + self.m[4] * y + self.m[5]) / w;
        (u, v)
    }
}

fn normalize_points(points: &[(f32, f32); 4]) -> (f32, f32, [(f32, f32); 4]) {
    let cx: f32 = points.iter().map(|p| p.0).sum::<f32>() / 4.0;
    let cy: f32 = points.iter().map(|p| p.1).sum::<f32>() / 4.0;

    let mean_dist: f32 = points
        .iter()
        .map(|p| ((p.0 - cx).powi(2) + (p.1 - cy).powi(2)).sqrt())
        .sum::<f32>()
        / 4.0;

    let scale = if mean_dist > 0.0 {
        1.4142 / mean_dist
    } else {
        1.0
    };

    let norm: [(f32, f32); 4] = points
        .map(|(x, y)| ((x - cx) * scale, (y - cy) * scale));

    (cx, cy, norm)
}

fn denormalize_homography(h: &[f32; 9], sx: f32, sy: f32, dx: f32, dy: f32) -> [f32; 9] {
    // Simplified denormalization — apply the inverse normalizing transforms
    let t_src = [
        [1.0, 0.0, sx],
        [0.0, 1.0, sy],
        [0.0, 0.0, 1.0],
    ];
    let t_dst_inv = [
        [1.0, 0.0, -dx],
        [0.0, 1.0, -dy],
        [0.0, 0.0, 1.0],
    ];

    // h = T_dst^(-1) * h_norm * T_src
    let mut result = [0.0f32; 9];
    for i in 0..3 {
        for j in 0..3 {
            let mut sum = 0.0;
            for k in 0..3 {
                let mut inner = 0.0;
                for l in 0..3 {
                    inner += t_dst_inv[i][l] * h[l * 3 + k];
                }
                sum += inner * t_src[k][j];
            }
            result[i * 3 + j] = sum;
        }
    }
    result
}

/// Detect the green registration border and return the 4 corner points
pub fn detect_frame(img: &RgbImage) -> Option<Quad> {
    // Threshold for green border in HSV space
    let (width, height) = (img.width() as usize, img.height() as usize);
    let mut mask = vec![false; width * height];

    for y in 0..height {
        for x in 0..width {
            let px = img.get_pixel(x as u32, y as u32);
            let hsv = rgb_to_hsv(px[0], px[1], px[2]);

            // Green: hue 80-160, high saturation, moderate-high value
            let is_green = hsv.h > 70.0 && hsv.h < 170.0 && hsv.s > 0.35 && hsv.v > 0.25;

            // Also match the corner markers (red, blue, yellow, cyan, magenta, white)
            let is_corner_color =
                (hsv.s > 0.3 && hsv.v > 0.2)
                || (hsv.s < 0.15 && hsv.v > 0.7); // white

            mask[y * width + x] = is_green || is_corner_color;
        }
    }

    // Find connected components in the mask
    // Simple approach: find bounding box of mask pixels
    let mut min_x = width;
    let mut max_x = 0usize;
    let mut min_y = height;
    let mut max_y = 0usize;
    let mut count = 0usize;

    for y in 0..height {
        for x in 0..width {
            if mask[y * width + x] {
                count += 1;
                if x < min_x { min_x = x; }
                if x > max_x { max_x = x; }
                if y < min_y { min_y = y; }
                if y > max_y { max_y = y; }
            }
        }
    }

    // Need a reasonable number of mask pixels
    let total_pixels = width * height;
    if count < total_pixels / 50 || count > total_pixels / 2 {
        return None;
    }

    // The bounding box gives rough corners
    // For now return the bbox as the quad — refinement happens in later phases
    Some(Quad {
        corners: [
            (min_x as f32, min_y as f32),
            (max_x as f32, min_y as f32),
            (max_x as f32, max_y as f32),
            (min_x as f32, max_y as f32),
        ],
    })
}

/// Sample cell centers from the rectified frame using the homography
pub fn sample_cells(
    img: &RgbImage,
    homography: &Homography,
    palette: &[PaletteEntry],
    cols: u32,
    rows: u32,
) -> (Vec<u8>, Vec<f32>) {
    let mut indices = Vec::with_capacity((cols * rows) as usize);
    let mut confidences = Vec::with_capacity((cols * rows) as usize);

    for row in 0..rows {
        for col in 0..cols {
            // Screen-space cell center (0 to 1 normalized)
            let sx = (col as f32 + 0.5) / cols as f32;
            let sy = (row as f32 + 0.5) / rows as f32;

            // Map screen coords → target cell coords (cols × rows space)
            let tx = sx * cols as f32;
            let ty = sy * rows as f32;

            // Apply homography to get image-space coordinates
            let (ix, iy) = homography.transform(tx, ty);

            // Sample with bilinear interpolation
            let sample = if ix >= 0.0 && iy >= 0.0 && ix < (img.width() - 1) as f32 && iy < (img.height() - 1) as f32 {
                let fx = ix.fract();
                let fy = iy.fract();
                let x0 = ix.floor() as u32;
                let y0 = iy.floor() as u32;
                let x1 = (x0 + 1).min(img.width() - 1);
                let y1 = (y0 + 1).min(img.height() - 1);

                let p00 = img.get_pixel(x0, y0);
                let p10 = img.get_pixel(x1, y0);
                let p01 = img.get_pixel(x0, y1);
                let p11 = img.get_pixel(x1, y1);

                let r = bilinear_interp(p00[0], p10[0], p01[0], p11[0], fx, fy);
                let g = bilinear_interp(p00[1], p10[1], p01[1], p11[1], fx, fy);
                let b = bilinear_interp(p00[2], p10[2], p01[2], p11[2], fx, fy);
                (r, g, b)
            } else {
                (0u8, 0u8, 0u8)
            };

            let (idx, conf) = classify_cell(sample.0, sample.1, sample.2, palette);
            indices.push(idx);
            confidences.push(conf);
        }
    }

    (indices, confidences)
}

fn bilinear_interp(v00: u8, v10: u8, v01: u8, v11: u8, fx: f32, fy: f32) -> u8 {
    let top = v00 as f32 + (v10 as f32 - v00 as f32) * fx;
    let bot = v01 as f32 + (v11 as f32 - v01 as f32) * fx;
    (top + (bot - top) * fy) as u8
}
