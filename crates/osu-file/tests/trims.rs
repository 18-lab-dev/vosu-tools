use osu_file::{
    audio::{self, Audio},
    map::{self, Options},
    trim::{self, Range, Window},
};
use std::sync::atomic::AtomicBool;

const SOURCE: &str = include_str!("fixtures/trim-source.osu");
const MANIA: &str = include_str!("fixtures/mania.osu");

fn trimmed(ranges: &[(f64, f64)]) -> Options {
    Options {
        trims: ranges
            .iter()
            .map(|&(start_ms, end_ms)| Range { start_ms, end_ms })
            .collect(),
        lead_in_ms: 500.0,
        lead_out_ms: 300.0,
        gap_ms: 2000.0,
        ..Default::default()
    }
}

fn section<'a>(text: &'a str, name: &str) -> Vec<&'a str> {
    text.lines()
        .skip_while(|l| l.trim() != name)
        .skip(1)
        .take_while(|l| !l.starts_with('['))
        .filter(|l| !l.trim().is_empty())
        .collect()
}

#[test]
fn windows_pad_merge_and_place_sections() {
    let o = trimmed(&[(10_000.0, 10_900.0), (900.0, 3100.0)]);
    // Ranges are sorted; the slider at 3000 ends at 3500, so its window runs to
    // 3800; the second section starts after the first plus the 2 s gap.
    assert_eq!(
        trim::windows(SOURCE, &o).unwrap(),
        vec![
            Window {
                source_start: 500.0,
                source_end: 3800.0,
                output_start: 0.0
            },
            Window {
                source_start: 9500.0,
                source_end: 11_100.0,
                output_start: 5300.0
            },
        ]
    );
    // Padded windows that touch merge into one continuous section.
    let merged = trim::windows(SOURCE, &trimmed(&[(900.0, 1600.0), (2000.0, 2100.0)])).unwrap();
    assert_eq!(
        merged,
        vec![Window {
            source_start: 500.0,
            source_end: 2300.0,
            output_start: 0.0
        }]
    );
    // Lead-in never reaches before the start of the audio.
    let early = trim::windows(
        SOURCE,
        &Options {
            lead_in_ms: 5000.0,
            ..trimmed(&[(900.0, 1100.0)])
        },
    )
    .unwrap();
    assert_eq!(early[0].source_start, 0.0);
}

#[test]
fn trimmed_map_golden() {
    let o = trimmed(&[(900.0, 3100.0), (10_000.0, 10_900.0)]);
    let out = map::transform(SOURCE, &o, "out.ogg").unwrap();
    assert_eq!(out.text, include_str!("fixtures/trim-expected.osu"));
    assert_eq!(out.windows.len(), 2);
    assert_eq!(
        out.warnings.len(),
        1,
        "storyboard and video removal is reported"
    );

    // The golden's facts, derived by hand from the fixture:
    // objects keep only the selected ranges, shifted per section, each section
    // starting a new combo; spinner at 6000 and the circle at 12000 are dropped.
    assert_eq!(
        section(&out.text, "[HitObjects]"),
        [
            "64,64,500,5,0,0:0:0:0:",
            "128,64,1000,1,0,0:0:0:0:",
            "192,64,1500,1,0,0:0:0:0:",
            "256,192,2500,2,0,L|396:192,1,140",
            "64,320,5800,5,0,0:0:0:0:",
            "128,320,6200,1,0,0:0:0:0:",
            "192,320,6600,1,0,0:0:0:0:",
        ]
    );
    // Section 1 re-anchors the 120 BPM red line in phase (100 → -400). Section 2
    // anchors it in phase at 9100 → 4900 with the active green line's volume,
    // restores SV 0.5 at its start, then keeps the 150 BPM red line at 10000.
    assert_eq!(
        section(&out.text, "[TimingPoints]"),
        [
            "-400,500,4,2,1,70,1,0",
            "4900,500,4,2,1,60,1,0",
            "5300,-200,4,2,1,60,0,0",
            "5800,400,3,2,0,80,1,1",
        ]
    );
    // The gap is a break; the source break (7500–9500) lies outside both windows.
    // Background stays; video and storyboard go.
    assert_eq!(
        section(&out.text, "[Events]"),
        [
            "2,3300,5300",
            "//Background and Video events",
            "0,0,\"bg.jpg\",0,0",
            "//Break Periods",
            "//Storyboard Layer 0 (Background)",
        ]
    );
    assert_eq!(
        map::value(&out.text, "[General]", "PreviewTime").unwrap(),
        "5800"
    );
    assert_eq!(
        map::value(&out.text, "[Editor]", "Bookmarks").unwrap(),
        "1500,6800"
    );
    assert!(
        map::value(&out.text, "[Metadata]", "Version")
            .unwrap()
            .ends_with("trim 0:01-0:03+0:10-0:11")
    );
}

#[test]
fn trims_combine_with_rate_and_mods() {
    let o = Options {
        rate: 1.25,
        mods: vec!["MR".into()],
        ..trimmed(&[(10_000.0, 10_900.0)])
    };
    let out = map::transform(SOURCE, &o, "out.ogg").unwrap();
    // Mirror then trim (9500 → 0) then rate: 10000 → 500 / 1.25 = 400.
    assert_eq!(
        section(&out.text, "[HitObjects]"),
        [
            "448,320,400,5,0,0:0:0:0:",
            "384,320,720,1,0,0:0:0:0:",
            "320,320,1040,1,0,0:0:0:0:",
        ]
    );
    assert_eq!(out.windows[0].source_start, 9500.0);
    // A trimmed map whose PreviewTime lies outside every window previews from
    // its first kept object.
    let early = map::transform(SOURCE, &trimmed(&[(900.0, 2100.0)]), "out.ogg").unwrap();
    assert_eq!(
        map::value(&early.text, "[General]", "PreviewTime").unwrap(),
        "500"
    );
}

#[test]
fn mania_holds_shift_with_their_section() {
    let o = trimmed(&[(2000.0, 2100.0)]);
    let out = map::transform(MANIA, &o, "out.ogg").unwrap();
    // Window 1500..2700 (hold tail 2400 + 300); 2000 → 500, tail 2400 → 900.
    assert_eq!(
        section(&out.text, "[HitObjects]"),
        ["64,192,500,132,0,900:0:0:0:0:", "192,192,600,1,0,0:0:0:0:"]
    );
    // The source break 1500–1800 is clipped to the window but too short to keep.
    assert!(
        !section(&out.text, "[Events]")
            .iter()
            .any(|l| l.starts_with('2'))
    );
}

#[test]
fn invalid_trims_are_rejected() {
    for o in [
        trimmed(&[(5000.0, 4000.0)]),
        trimmed(&[(-1.0, 4000.0)]),
        trimmed(&[(7100.0, 9000.0)]),
        Options {
            gap_ms: -1.0,
            ..trimmed(&[(900.0, 1100.0)])
        },
        Options {
            fade_ms: f64::NAN,
            ..trimmed(&[(900.0, 1100.0)])
        },
    ] {
        assert!(
            map::transform(SOURCE, &o, "out.ogg").is_err(),
            "{:?}",
            o.trims
        );
    }
    let too_many = trimmed(&vec![(900.0, 1100.0); trim::MAX_RANGES + 1]);
    assert!(map::transform(SOURCE, &too_many, "out.ogg").is_err());
}

const SR: u32 = 44_100;
fn clicks(at_ms: &[f64], length_ms: f64) -> Audio {
    let n = (length_ms * f64::from(SR) / 1000.0) as usize;
    let mut left = vec![0.0_f32; n];
    for &t in at_ms {
        left[(t * f64::from(SR) / 1000.0).round() as usize] = 1.0;
    }
    let right = left.iter().map(|v| -v).collect();
    Audio {
        sample_rate: SR,
        channels: vec![left, right],
    }
}
fn peaks(channel: &[f32]) -> Vec<usize> {
    (0..channel.len())
        .filter(|&i| channel[i].abs() > 0.5)
        .collect()
}
fn sample(ms: f64) -> usize {
    (ms * f64::from(SR) / 1000.0).round() as usize
}

#[test]
fn audio_cut_is_sample_exact() {
    let windows =
        trim::windows(SOURCE, &trimmed(&[(900.0, 3100.0), (10_000.0, 10_900.0)])).unwrap();
    // Clicks on every kept object plus two outside the windows.
    let source = clicks(
        &[
            1000.0, 1500.0, 2000.0, 3000.0, 6000.0, 10_000.0, 10_400.0, 10_800.0, 12_000.0,
        ],
        13_000.0,
    );
    let cut = trim::cut(&source, &windows, 0.0).unwrap();
    assert_eq!(cut.channels[0].len(), sample(windows[1].output_end()));
    let expected: Vec<usize> = [500.0, 1000.0, 1500.0, 2500.0, 5800.0, 6200.0, 6600.0]
        .iter()
        .map(|&ms| sample(ms))
        .collect();
    assert_eq!(
        peaks(&cut.channels[0]),
        expected,
        "clicks land on their objects"
    );
    assert_eq!(
        peaks(&cut.channels[1]),
        expected,
        "both channels are cut alike"
    );
    // Every click sits within half a sample of its map time.
    for (&index, ms) in expected
        .iter()
        .zip([500.0, 1000.0, 1500.0, 2500.0, 5800.0, 6200.0, 6600.0])
    {
        assert!((index as f64 / f64::from(SR) * 1000.0 - ms).abs() <= 0.5 / f64::from(SR) * 1000.0);
    }
    // The gap between sections is silent.
    let gap = sample(windows[0].output_end())..sample(windows[1].output_start);
    assert!(cut.channels[0][gap].iter().all(|v| *v == 0.0));
}

#[test]
fn audio_fades_shape_section_edges() {
    let windows = vec![Window {
        source_start: 1000.0,
        source_end: 2000.0,
        output_start: 0.0,
    }];
    let tone = Audio {
        sample_rate: SR,
        channels: vec![vec![1.0; sample(3000.0)]],
    };
    let cut = trim::cut(&tone, &windows, 100.0).unwrap();
    let c = &cut.channels[0];
    let edge = sample(100.0);
    assert_eq!(c.len(), sample(1000.0));
    assert_eq!(c[0], 0.0, "fade-in starts silent");
    assert!((c[edge / 2] - 0.5).abs() < 1e-3, "raised-cosine midpoint");
    assert!(
        c[edge..c.len() - edge].iter().all(|v| *v == 1.0),
        "full level between fades"
    );
    assert_eq!(*c.last().unwrap(), 0.0, "fade-out ends silent");
    assert!(
        c.windows(2).take(edge).all(|w| w[1] >= w[0]),
        "monotonic fade-in"
    );
}

#[test]
fn audio_cut_survives_rate_change_and_vorbis() {
    let o = Options {
        rate: 1.5,
        ..trimmed(&[(900.0, 3100.0), (10_000.0, 10_900.0)])
    };
    let out = map::transform(SOURCE, &o, "out.ogg").unwrap();
    let source = clicks(
        &[1000.0, 1500.0, 2000.0, 3000.0, 10_000.0, 10_400.0, 10_800.0],
        13_000.0,
    );
    let cut = trim::cut(&source, &out.windows, 0.0).unwrap();
    let never = AtomicBool::new(false);
    let changed = audio::change(&cut, o.rate, false, &never, |_| {}).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cut.ogg");
    audio::encode(&changed, &path, &never).unwrap();
    let decoded = audio::decode(&path, &never).unwrap();
    // Each object time in the final .osu matches its click in the decoded audio
    // to within 1 ms (resampling and Vorbis smear a click over a few samples).
    let objects: Vec<f64> = section(&out.text, "[HitObjects]")
        .iter()
        .map(|l| l.split(',').nth(2).unwrap().parse().unwrap())
        .collect();
    assert_eq!(objects.len(), 7);
    let c = &decoded.channels[0];
    for t in objects {
        let centre = sample(t);
        let (best, _) = (centre.saturating_sub(sample(5.0))..(centre + sample(5.0)).min(c.len()))
            .map(|i| (i, c[i].abs()))
            .fold((0, 0.0_f32), |a, b| if b.1 > a.1 { b } else { a });
        let error_ms = (best as f64 - (t * f64::from(SR) / 1000.0)).abs() / f64::from(SR) * 1000.0;
        assert!(
            error_ms <= 1.0,
            "object at {t} ms: click {error_ms:.3} ms away"
        );
    }
}

#[test]
fn resampled_clicks_stay_on_time() {
    let source = clicks(&[1000.0, 2000.0, 3000.0], 4000.0);
    let never = AtomicBool::new(false);
    for preserve in [false, true] {
        for rate in [0.75, 1.25, 1.5, 2.0] {
            let out = audio::change(&source, rate, preserve, &never, |_| {}).unwrap();
            let c = &out.channels[0];
            assert_eq!(c.len(), (sample(4000.0) as f64 / rate).round() as usize);
            for t in [1000.0, 2000.0, 3000.0] {
                let expected = t * f64::from(SR) / 1000.0 / rate;
                let range = (expected - 2000.0) as usize..(expected + 2000.0) as usize;
                let peak = range
                    .max_by(|&i, &j| c[i].abs().total_cmp(&c[j].abs()))
                    .unwrap();
                // Resampling is within one sample (≈0.02 ms); the stretcher
                // places transients within half a millisecond (measured ≤12
                // samples at 1.25×).
                let tolerance = if preserve {
                    0.5 * f64::from(SR) / 1000.0
                } else {
                    1.0
                };
                assert!(
                    (peak as f64 - expected).abs() <= tolerance,
                    "preserve={preserve} rate={rate} t={t}: peak {peak}, expected {expected:.1}"
                );
            }
        }
    }
}
