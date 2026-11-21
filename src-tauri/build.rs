//! Provide the Windows resource icon from the checked-in PNG at build time.
//! This keeps the PNG as the single icon source and unblocks native Windows builds.
use std::fs;
use std::io::{self, ErrorKind};

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() == Some("windows") {
        write_windows_icon().expect("Unable to generate icons/icon.ico from icons/icon.png");
    }
    tauri_build::build();
}

fn write_windows_icon() -> io::Result<()> {
    let png = fs::read("icons/icon.png")?;
    if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" || &png[12..16] != b"IHDR" {
        return Err(io::Error::new(ErrorKind::InvalidData, "Invalid PNG icon"));
    }
    let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
    if width == 0 || height == 0 {
        return Err(io::Error::new(ErrorKind::InvalidData, "Empty PNG icon"));
    }
    let png_bytes = u32::try_from(png.len())
        .map_err(|_| io::Error::new(ErrorKind::InvalidData, "Icon file is too large"))?;
    let mut ico = Vec::with_capacity(22 + png.len());
    // ICO header: one icon, PNG-compressed payload at byte 22.
    ico.extend_from_slice(&[0, 0, 1, 0, 1, 0]);
    ico.push(if width >= 256 { 0 } else { width as u8 });
    ico.push(if height >= 256 { 0 } else { height as u8 });
    ico.extend_from_slice(&[0, 0]);
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&32u16.to_le_bytes());
    ico.extend_from_slice(&png_bytes.to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes());
    ico.extend_from_slice(&png);
    fs::write("icons/icon.ico", ico)
}
