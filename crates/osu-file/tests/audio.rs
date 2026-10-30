use osu_file::audio::{self, Audio};
use std::sync::atomic::AtomicBool;

fn tone() -> Audio {
    Audio {
        sample_rate: 44100,
        channels: vec![
            (0..44100)
                .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 44100.0).sin() * 0.5)
                .collect(),
        ],
    }
}

/// Lazer hands out extensionless hash paths, and stable maps ship misnamed
/// audio: the decoder must follow the bytes, not the name.
#[test]
fn decoder_follows_content_not_name() {
    let never = AtomicBool::new(false);
    let dir = tempfile::tempdir().unwrap();
    let source = tone();

    let vorbis = dir.path().join("vorbis.ogg");
    audio::encode(&source, &vorbis, &never).unwrap();
    for name in ["3f9a0c1e2b", "really-vorbis.mp3"] {
        let path = dir.path().join(name);
        std::fs::copy(&vorbis, &path).unwrap();
        let decoded = audio::decode(&path, &never).unwrap();
        assert_eq!(decoded.sample_rate, 44100, "{name}");
        assert!(decoded.channels[0].len().abs_diff(44100) < 100, "{name}");
    }

    let wav = dir.path().join("really-wav.ogg");
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 22050,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(&wav, spec).unwrap();
    for _ in 0..1000 {
        w.write_sample(1000_i16).unwrap();
    }
    w.finalize().unwrap();
    let decoded = audio::decode(&wav, &never).unwrap();
    assert_eq!(
        (decoded.sample_rate, decoded.channels[0].len()),
        (22050, 1000)
    );

    for (name, bytes) in [
        ("flac", b"fLaC\0\0\0\x22rest-of-stream".as_slice()),
        ("garbage", b"not audio at all".as_slice()),
    ] {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        let error = audio::decode(&path, &never).err().unwrap().to_string();
        assert!(error.contains("not supported"), "{name}: {error}");
    }
}
