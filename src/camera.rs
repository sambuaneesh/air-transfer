use image::{ImageBuffer, Rgb};
use nokhwa::{
    Camera,
    pixel_format::RgbFormat,
    query,
    utils::{CameraIndex, CameraFormat, FrameFormat, RequestedFormat, Resolution},
};
use std::time::Duration;

use crate::error::Result;

pub type RgbImage = ImageBuffer<Rgb<u8>, Vec<u8>>;

pub struct CameraCapture {
    camera: Camera,
}

impl CameraCapture {
    pub fn new(index: u32, width: u32, height: u32) -> Result<Self> {
        let devices = query(nokhwa::utils::ApiBackend::Auto)
            .map_err(crate::error::Error::Camera)?;

        if devices.is_empty() {
            return Err(crate::error::Error::Camera(
                nokhwa::NokhwaError::GeneralError(
                    "no camera devices found".to_string(),
                ),
            ));
        }

        let idx = index as usize;
        if idx >= devices.len() {
            return Err(crate::error::Error::Camera(
                nokhwa::NokhwaError::GeneralError(format!(
                    "camera index {} out of range (found {} devices)",
                    index,
                    devices.len()
                )),
            ));
        }

        let device_info = &devices[idx];
        log::info!("using camera: {}", device_info.human_name());

        let _resolution = Resolution::new(width, height);
        let format = RequestedFormat::with_formats(
            nokhwa::utils::RequestedFormatType::AbsoluteHighestFrameRate,
            &[FrameFormat::MJPEG],
        );

        let mut camera = Camera::with_backend(
            CameraIndex::Index(index),
            format,
            nokhwa::utils::ApiBackend::Auto,
        )
        .map_err(crate::error::Error::Camera)?;

        camera.open_stream().map_err(crate::error::Error::Camera)?;

        // Let camera auto-exposure settle
        std::thread::sleep(Duration::from_millis(500));

        Ok(Self { camera })
    }

    /// Capture a single frame and decode to RGB
    pub fn capture(&mut self) -> Result<RgbImage> {
        let buffer = self.camera.frame().map_err(crate::error::Error::Camera)?;
        let img = buffer
            .decode_image::<RgbFormat>()
            .map_err(crate::error::Error::Camera)?;
        Ok(img)
    }
}
