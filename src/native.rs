use std::fs;
use std::io::Write;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::Duration;

use clap::Parser;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::WindowId;

use air_transfer::{
    camera, color, correction, decoder, detection, display, encoder, protocol,
};

#[derive(Parser)]
#[command(name = "air-transfer")]
#[command(about = "Air-gapped data transfer via display/camera")]
struct Cli {
    #[arg(short, long, default_value = "send")]
    mode: String,

    #[arg(short, long)]
    input: Option<String>,

    #[arg(short, long)]
    output: Option<String>,

    #[arg(long, default_value = "0")]
    camera: u32,

    #[arg(long, default_value = "640")]
    cam_width: u32,

    #[arg(long, default_value = "480")]
    cam_height: u32,

    #[arg(long)]
    no_fullscreen: bool,
}

pub fn main() -> Result<(), Box<dyn std::error::Error>> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cli = Cli::parse();

    match cli.mode.as_str() {
        "send" => run_send(cli),
        "receive" => run_receive(cli),
        "test-display" => run_test_display(cli),
        other => {
            eprintln!("unknown mode: {other}");
            eprintln!("valid modes: send, receive, test-display");
            std::process::exit(1);
        }
    }
}

// ---- Test Display ----

struct TestDisplayApp {
    renderer: Option<display::Renderer>,
    grid: Vec<u8>,
}

impl ApplicationHandler for TestDisplayApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.renderer.is_none() {
            self.renderer = Some(
                display::Renderer::new(true, event_loop).expect("failed to create renderer"),
            );
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::KeyboardInput {
                event: key_event, ..
            } if key_event.state == ElementState::Pressed => {
                if key_event.logical_key == Key::Named(NamedKey::Escape) {
                    event_loop.exit();
                }
            }
            WindowEvent::RedrawRequested => {
                if let Some(ref mut r) = self.renderer {
                    let fb = r.frame_buffer();
                    let sw = display::grid_width();
                    display::render_grid(fb, sw, &self.grid, 50, 50);
                    r.render().ok();
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(ref mut r) = self.renderer {
            r.window().request_redraw();
        }
    }
}

fn run_test_display(_cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = TestDisplayApp {
        renderer: None,
        grid: encoder::build_handshake_grid(),
    };
    let event_loop = EventLoop::new()?;
    event_loop.run_app(&mut app)?;
    Ok(())
}

// ---- Send Mode ----

enum SendCtrl {
    NextFrame,
}

struct SendApp {
    renderer: Option<display::Renderer>,
    grids: Arc<Vec<Vec<u8>>>,
    current_shard: Arc<Mutex<u32>>,
    done: Arc<AtomicBool>,
    ctrl_rx: std::sync::mpsc::Receiver<SendCtrl>,
}

impl ApplicationHandler for SendApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.renderer.is_none() {
            self.renderer = Some(
                display::Renderer::new(true, event_loop).expect("failed to create renderer"),
            );
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => {
                self.done.store(true, Ordering::SeqCst);
                event_loop.exit();
            }
            WindowEvent::KeyboardInput {
                event: key_event, ..
            } if key_event.state == ElementState::Pressed => {
                if key_event.logical_key == Key::Named(NamedKey::Escape) {
                    self.done.store(true, Ordering::SeqCst);
                    event_loop.exit();
                }
            }
            WindowEvent::RedrawRequested => {
                if let Some(ref mut r) = self.renderer {
                    let shard_idx = *self.current_shard.lock().unwrap() as usize;
                    if shard_idx < self.grids.len() {
                        let fb = r.frame_buffer();
                        let sw = display::grid_width();
                        display::render_grid(fb, sw, &self.grids[shard_idx], 50, 50);
                    }
                    r.render().ok();
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        match self.ctrl_rx.try_recv() {
            Ok(SendCtrl::NextFrame) => {
                let mut s = self.current_shard.lock().unwrap();
                *s += 1;
                if *s >= self.grids.len() as u32 {
                    log::info!("transfer complete!");
                    self.done.store(true, Ordering::SeqCst);
                    event_loop.exit();
                    return;
                }
            }
            Err(_) => {}
        }

        if self.done.load(Ordering::SeqCst) {
            event_loop.exit();
            return;
        }

        if let Some(ref r) = self.renderer {
            r.window().request_redraw();
        }
    }
}

fn run_send(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let input_path = cli.input.as_ref().expect("--input required for send mode");
    let data = fs::read(input_path)?;

    let compressed = zstd::encode_all(&data[..], 3)?;
    let original_len = compressed.len();
    log::info!("input: {} bytes, compressed: {} bytes", data.len(), original_len);

    let ecc = correction::EccCodec::new(
        protocol::ECC_DATA_SHARDS,
        protocol::ECC_PARITY_SHARDS,
    )?;
    let all_shards = ecc.encode(&compressed)?;
    let total_shards = all_shards.len();
    log::info!("encoded into {} shards", total_shards);

    let grids: Arc<Vec<Vec<u8>>> = Arc::new(
        all_shards
            .iter()
            .enumerate()
            .map(|(i, shard)| {
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
            })
            .collect(),
    );

    let (ctrl_tx, ctrl_rx) = std::sync::mpsc::channel::<SendCtrl>();
    let current_shard = Arc::new(Mutex::new(0u32));
    let done = Arc::new(AtomicBool::new(false));

    // Camera ACK detection thread
    let cam_idx = cli.camera;
    let cam_w = cli.cam_width;
    let cam_h = cli.cam_height;
    let done_flag = done.clone();
    let ctrl = ctrl_tx;

    thread::spawn(move || {
        let mut camera = match camera::CameraCapture::new(cam_idx, cam_w, cam_h) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("camera init failed: {e} — using timer fallback");
                while !done_flag.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(500));
                    if ctrl.send(SendCtrl::NextFrame).is_err() {
                        break;
                    }
                }
                return;
            }
        };

        let palette = color::generate_64_color_palette();

        loop {
            if done_flag.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(Duration::from_millis(100));

            let img = match camera.capture() {
                Ok(i) => i,
                Err(_) => {
                    if ctrl.send(SendCtrl::NextFrame).is_err() { break; }
                    continue;
                }
            };

            if let Some(quad) = detection::detect_frame(&img) {
                let src: [(f32, f32); 4] = [(0.0, 0.0), (50.0, 0.0), (50.0, 50.0), (0.0, 50.0)];
                if let Some(h) = detection::Homography::from_points(&src, &quad.corners) {
                    let (indices, _) = detection::sample_cells(&img, &h, &palette, 50, 50);
                    if let Some(decoded) = decoder::decode_grid(&indices, 50, 50) {
                        if decoded.header.frame_type == protocol::FrameType::Ack {
                            log::info!("received ACK for frame {}", decoded.header.frame_id);
                            if ctrl.send(SendCtrl::NextFrame).is_err() { break; }
                        }
                    }
                }
            }
        }
    });

    let mut app = SendApp {
        renderer: None,
        grids,
        current_shard,
        done,
        ctrl_rx,
    };

    let event_loop = EventLoop::new()?;
    event_loop.run_app(&mut app)?;
    Ok(())
}

// ---- Receive Mode ----

struct ReceiveApp {
    renderer: Option<display::Renderer>,
    ack_display: Arc<Mutex<Option<(u16, bool)>>>,
    done: Arc<AtomicBool>,
}

impl ApplicationHandler for ReceiveApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.renderer.is_none() {
            self.renderer = Some(
                display::Renderer::new(true, event_loop).expect("failed to create renderer"),
            );
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => {
                self.done.store(true, Ordering::SeqCst);
                event_loop.exit();
            }
            WindowEvent::KeyboardInput {
                event: key_event, ..
            } if key_event.state == ElementState::Pressed => {
                if key_event.logical_key == Key::Named(NamedKey::Escape) {
                    self.done.store(true, Ordering::SeqCst);
                    event_loop.exit();
                }
            }
            WindowEvent::RedrawRequested => {
                if let Some(ref mut r) = self.renderer {
                    let ack = self.ack_display.lock().unwrap().take();
                    let grid = if let Some((frame_id, success)) = ack {
                        encoder::build_ack_grid(frame_id, success)
                    } else {
                        encoder::build_handshake_grid()
                    };
                    let fb = r.frame_buffer();
                    let sw = display::grid_width();
                    display::render_grid(fb, sw, &grid, 50, 50);
                    r.render().ok();
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if self.done.load(Ordering::SeqCst) {
            event_loop.exit();
            return;
        }
        if let Some(ref r) = self.renderer {
            r.window().request_redraw();
        }
    }
}

fn run_receive(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let output_path = cli.output.clone().unwrap_or_else(|| "received_output.bin".to_string());
    log::info!("starting receive mode, output -> {output_path}");

    let received_shards: Arc<Mutex<Vec<Option<Vec<u8>>>>> = Arc::new(Mutex::new(Vec::new()));
    let total_shards = Arc::new(Mutex::new(0u32));
    let data_len = Arc::new(Mutex::new(0u32));
    let ack_display: Arc<Mutex<Option<(u16, bool)>>> = Arc::new(Mutex::new(None));
    let done = Arc::new(AtomicBool::new(false));

    let cam_idx = cli.camera;
    let cam_w = cli.cam_width;
    let cam_h = cli.cam_height;
    let shards = received_shards.clone();
    let tot_shards = total_shards.clone();
    let dat_len = data_len.clone();
    let ack_sig = ack_display.clone();
    let done_flag = done.clone();
    let output = output_path.clone();

    thread::spawn(move || {
        let mut camera = match camera::CameraCapture::new(cam_idx, cam_w, cam_h) {
            Ok(c) => c,
            Err(e) => {
                log::error!("camera init failed: {e}");
                done_flag.store(true, Ordering::SeqCst);
                return;
            }
        };

        let palette = color::generate_64_color_palette();
        let mut last_seen_frame: Option<u16> = None;

        loop {
            if done_flag.load(Ordering::SeqCst) { break; }
            let img = match camera.capture() {
                Ok(i) => i,
                Err(e) => {
                    log::warn!("capture error: {e}");
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
            };

            if let Some(quad) = detection::detect_frame(&img) {
                let src: [(f32, f32); 4] = [(0.0, 0.0), (50.0, 0.0), (50.0, 50.0), (0.0, 50.0)];
                if let Some(h) = detection::Homography::from_points(&src, &quad.corners) {
                    let (indices, _) = detection::sample_cells(&img, &h, &palette, 50, 50);
                    if let Some(decoded) = decoder::decode_grid(&indices, 50, 50) {
                        let header = decoded.header;
                        if header.frame_type == protocol::FrameType::Data {
                            let fid = header.frame_id;
                            let is_new = match last_seen_frame {
                                Some(prev) if fid == prev => false,
                                _ => { last_seen_frame = Some(fid); true }
                            };
                            if is_new {
                                log::info!("received frame {fid}, shard {}/{}", header.shard_index, header.total_shards);
                                {
                                    let mut ts = tot_shards.lock().unwrap();
                                    *ts = header.total_shards as u32;
                                }
                                {
                                    let mut dl = dat_len.lock().unwrap();
                                    *dl = header.data_len as u32;
                                }
                                {
                                    let mut s = shards.lock().unwrap();
                                    if s.is_empty() { *s = vec![None; header.total_shards as usize]; }
                                    if (header.shard_index as usize) < s.len() {
                                        s[header.shard_index as usize] = Some(decoded.payload.clone());
                                    }
                                }
                                {
                                    let mut ack = ack_sig.lock().unwrap();
                                    *ack = Some((fid, true));
                                }

                                let complete = {
                                    let s = shards.lock().unwrap();
                                    s.iter().all(|sh| sh.is_some())
                                };
                                if complete {
                                    log::info!("all shards received, reconstructing...");
                                    let ecc = correction::EccCodec::new(
                                        protocol::ECC_DATA_SHARDS,
                                        protocol::ECC_PARITY_SHARDS,
                                    ).unwrap();
                                    let all_vecs: Vec<Vec<u8>> = {
                                        let s = shards.lock().unwrap();
                                        s.iter().map(|sh| sh.clone().unwrap_or_default()).collect()
                                    };
                                    let orig_len = *dat_len.lock().unwrap() as usize;
                                    let recovered = ecc.extract_data(&all_vecs, orig_len);

                                    match zstd::decode_all(&recovered[..]) {
                                        Ok(decompressed) => {
                                            let mut f = fs::File::create(&output).unwrap();
                                            f.write_all(&decompressed).unwrap();
                                            log::info!("written {} bytes to {output}", decompressed.len());
                                        }
                                        Err(e) => log::error!("decompression failed: {e}"),
                                    }
                                    done_flag.store(true, Ordering::SeqCst);
                                }
                            }
                        }
                    }
                }
            }
            thread::sleep(Duration::from_millis(33));
        }
    });

    let mut app = ReceiveApp {
        renderer: None,
        ack_display,
        done,
    };

    let event_loop = EventLoop::new()?;
    event_loop.run_app(&mut app)?;
    Ok(())
}
