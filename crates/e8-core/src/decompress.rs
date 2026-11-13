//! Decompressing gzip and zlib data in a buffer, as Emacs's decompress.c
//! does ([ADR 0075]). E8's buffers are all multibyte: the region's
//! characters are taken as bytes, ASCII and raw bytes, and what comes out goes in as
//! ASCII and raw bytes, which `decode-coding-region` then decodes, as an
//! Emacs unibyte buffer made multibyte would show them.
//!
//! [ADR 0075]: ../../../docs/adr/0075-compression-and-tls-as-emacs-has-them.md

use flate2::{Crc, Decompress, FlushDecompress, Status};

use crate::coding::{char_raw_byte, raw_byte_char};
use crate::editor::Editor;
use crate::error::{Error, Result};

/// What `zlib-decompress-region` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decompressed {
    /// All of it: the region is the decompressed data (t).
    Whole,
    /// Some, and this many bytes of the compressed data were not, as
    /// with ALLOW-PARTIAL.
    Partly(usize),
    /// Nothing: the region is as it was (nil).
    Failed,
}

/// Decompresses gzip or zlib data, telling which by its first bytes as
/// zlib's inflateInit2 with 32 added to its window bits does, as far as it
/// goes: what came out, how much of the input was used, and whether the
/// stream ended as it should, its checksum right.
pub fn inflate(input: &[u8]) -> (Vec<u8>, usize, bool) {
    let mut out = Vec::new();
    if input.len() >= 2 && input[0] == 0x1f && input[1] == 0x8b {
        let header = match gzip_header(input) {
            Ok(header) => header,
            Err(read) => return (out, read, false),
        };
        let (used, ended) = deflate(&input[header..], false, &mut out);
        if !ended {
            return (out, header + used, false);
        }
        // The trailer: the data's CRC-32, then its length modulo 2^32, each
        // read before it is checked, as zlib reads them, so a wrong one
        // leaves only what follows it unread.
        let at = header + used;
        let mut crc = Crc::new();
        crc.update(&out);
        let word = |i: usize| input.get(at + i..at + i + 4).map(|b| u32::from_le_bytes(b.try_into().expect("four bytes")));
        match word(0) {
            None => return (out, input.len(), false),
            Some(sum) if sum != crc.sum() => return (out, at + 4, false),
            Some(_) => {}
        }
        match word(4) {
            None => (out, input.len(), false),
            Some(len) => {
                let whole = len == out.len() as u32;
                (out, at + 8, whole)
            }
        }
    } else {
        let (used, ended) = deflate(input, true, &mut out);
        (out, used, ended)
    }
}

/// Inflates a deflate stream, with zlib's header and checksum if `zlib`:
/// how much input it used and whether the stream ended.
fn deflate(input: &[u8], zlib: bool, out: &mut Vec<u8>) -> (usize, bool) {
    let mut d = Decompress::new(zlib);
    let mut chunk = vec![0u8; 16 * 1024];
    loop {
        let (before_in, before_out) = (d.total_in(), d.total_out());
        let status = d.decompress(&input[before_in as usize..], &mut chunk, FlushDecompress::None);
        out.extend_from_slice(&chunk[..(d.total_out() - before_out) as usize]);
        match status {
            Ok(Status::StreamEnd) => return (d.total_in() as usize, true),
            Ok(_) if d.total_in() != before_in || d.total_out() != before_out => {}
            // Out of input before the end, or data that is not deflate.
            _ => return (d.total_in() as usize, false),
        }
    }
}

/// How long a gzip member's header is, as RFC 1952 lays it out and zlib
/// reads it; else how much of it zlib has read when it fails: the method
/// and flags are checked once read, the header's own CRC once its two
/// bytes are, and a header cut short is read to its end.
fn gzip_header(input: &[u8]) -> std::result::Result<usize, usize> {
    const FHCRC: u8 = 2;
    const FEXTRA: u8 = 4;
    const FNAME: u8 = 8;
    const FCOMMENT: u8 = 16;
    let whole = input.len();
    let (Some(&method), Some(&flags)) = (input.get(2), input.get(3)) else { return Err(whole) };
    // Deflate is the only method, and the top three flags are reserved.
    if method != 8 || flags & 0xe0 != 0 {
        return Err(4);
    }
    let mut at = 10;
    if flags & FEXTRA != 0 {
        let (Some(&lo), Some(&hi)) = (input.get(at), input.get(at + 1)) else { return Err(whole) };
        at += 2 + u16::from_le_bytes([lo, hi]) as usize;
    }
    for flag in [FNAME, FCOMMENT] {
        if flags & flag != 0 {
            let Some(end) = input.get(at..).and_then(|rest| rest.iter().position(|&b| b == 0)) else { return Err(whole) };
            at += end + 1;
        }
    }
    if flags & FHCRC != 0 {
        let Some(sum) = input.get(at..at + 2) else { return Err(whole) };
        let mut crc = Crc::new();
        crc.update(&input[..at]);
        at += 2;
        if u16::from_le_bytes([sum[0], sum[1]]) != (crc.sum() & 0xffff) as u16 {
            return Err(at);
        }
    }
    if at > whole { Err(whole) } else { Ok(at) }
}

impl Editor {
    /// Replaces the gzip or zlib data from `start` to `end` with the data
    /// it holds, as Emacs's `zlib-decompress-region`: on failure the region
    /// stays as it was, or with `allow_partial` becomes what was
    /// decompressed. Point stays where it was, or at the end if the buffer
    /// shrank past it.
    pub fn zlib_decompress_region(&mut self, start: usize, end: usize, allow_partial: bool) -> Result<Decompressed> {
        let (start, end) = (start.min(end), start.max(end));
        // Within the accessible part, as validate_region checks, and a
        // buffer that may change, as modify_text checks first.
        let (begv, zv) = (self.buffer().point_min(), self.buffer().point_max());
        if start < begv || end > zv {
            return Err(Error::signal("args-out-of-range", "Args out of range", vec![crate::Value::Number(start as f64), crate::Value::Number(end as f64)]));
        }
        let text = self.buffer().slice(start..end);
        // ASCII and raw bytes, as a unibyte buffer holds: other characters,
        // such as é decoded from UTF-8, are text, which zlib cannot read.
        let bytes: Option<Vec<u8>> = text.chars().map(|c| if c.is_ascii() { Some(c as u8) } else { char_raw_byte(c) }).collect();
        let Some(bytes) = bytes else {
            // Where Emacs refuses a multibyte buffer, E8 refuses text that is not bytes.
            return Err(Error::new("The region holds characters that are not bytes"));
        };
        self.barf_if_buffer_read_only()?;
        let (out, used, whole) = inflate(&bytes);
        let result = match (whole, allow_partial) {
            (true, _) => Decompressed::Whole,
            (false, true) => Decompressed::Partly(bytes.len() - used),
            (false, false) => return Ok(Decompressed::Failed),
        };
        let point = self.buffer().point();
        let new: String = out.iter().map(|&b| raw_byte_char(b)).collect();
        self.replace_range(start, end, &new)?;
        let len = self.buffer().len();
        self.buffer_mut().set_point(point.min(len));
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::inflate;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// The data Emacs 30's zlib-decompress-region was given: "héllo world\n"
    /// 40 times in UTF-8, gzipped and zlib-compressed, and how much of each
    /// it left undecompressed with ALLOW-PARTIAL.
    #[test]
    fn inflating_reads_as_far_as_zlib_does() {
        let text = "héllo world\n".repeat(40);
        let gz = hex("1f8b08000000000002ffcb38bc3227275fa13cbf2827852b6394335239007b3307f008020000");
        let z = hex("789ccb38bc3227275fa13cbf2827852b639433523900ab17d909");
        assert_eq!(inflate(&gz), (text.clone().into_bytes(), 38, true));
        assert_eq!(inflate(&z), (text.clone().into_bytes(), 26, true));
        // Cut in half: all of it read, the stream not ended (0 left).
        let (out, used, ended) = inflate(&gz[..19]);
        assert_eq!((used, ended), (19, false));
        assert!(text.as_bytes().starts_with(&out));
        // Not compressed: 19 of 21 bytes left.
        assert_eq!(inflate(b"not compressed at all").1, 2);
        // A wrong CRC: its 4 bytes read, the length's 4 left.
        let mut bad = gz.clone();
        bad[32] ^= 0xff;
        let (out, used, ended) = inflate(&bad);
        assert_eq!((out.len(), used, ended), (text.len(), 34, false));
        // The wrong CRC with the length cut short: the CRC still read and refused, 1 of 35 left.
        assert_eq!(inflate(&bad[..35]).1, 34);
    }

    /// Headers zlib refuses, and how much of each it has read by then.
    #[test]
    fn gzip_headers_are_read_as_zlib_reads_them() {
        let gz = hex("1f8b08000000000002ffcb38bc3227275fa13cbf2827852b6394335239007b3307f008020000");
        let with = |f: &dyn Fn(&mut Vec<u8>)| {
            let mut g = gz.clone();
            f(&mut g);
            inflate(&g)
        };
        // A method other than deflate, or a reserved flag: refused once read, 4 bytes in.
        assert_eq!(with(&|g| g[2] = 7).1..=with(&|g| g[2] = 7).1, 4..=4);
        assert!(!with(&|g| g[3] |= 0x20).2);
        assert_eq!(with(&|g| g[3] |= 0x20).1, 4);
        // The header's own CRC: checked once its two bytes are read.
        let hcrc = |right: bool| {
            with(&|g| {
                g[3] |= 2;
                let mut crc = flate2::Crc::new();
                crc.update(&g[..10]);
                let sum = (crc.sum() & 0xffff) as u16 ^ if right { 0 } else { 1 };
                g.splice(10..10, sum.to_le_bytes());
            })
        };
        assert!(hcrc(true).2);
        assert_eq!((hcrc(false).1, hcrc(false).2), (12, false));
        // A file name with no end: all of it read, as zlib reads what it is given.
        let mut cut = gz[..10].to_vec();
        cut[3] |= 8;
        cut.extend_from_slice(b"abc");
        assert_eq!(inflate(&cut), (Vec::new(), 13, false));
    }
}
