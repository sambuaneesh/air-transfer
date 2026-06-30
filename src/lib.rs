pub mod calibration;
pub mod color;
pub mod correction;
pub mod decoder;
pub mod detection;
pub mod encoder;
pub mod error;
pub mod protocol;

#[cfg(not(target_arch = "wasm32"))]
pub mod camera;

#[cfg(not(target_arch = "wasm32"))]
pub mod display;

#[cfg(target_arch = "wasm32")]
mod web_app;
