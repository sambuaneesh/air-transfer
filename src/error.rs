use thiserror::Error;

#[derive(Error, Debug)]
pub enum Error {
    #[error("camera error: {0}")]
    Camera(#[from] nokhwa::NokhwaError),

    #[error("display error: {0}")]
    Display(String),

    #[error("image processing error: {0}")]
    Image(#[from] image::ImageError),

    #[error("serialization error: {0}")]
    Serialization(#[from] postcard::Error),

    #[error("compression error: {0}")]
    Compression(String),

    #[error("ECC error: {0}")]
    Ecc(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("protocol error: {0}")]
    Protocol(String),

    #[error("calibration error: {0}")]
    Calibration(String),

    #[error("detection error: {0}")]
    Detection(String),
}

pub type Result<T> = std::result::Result<T, Error>;
