//! cargo run -p vosu-lazer-library --example audit -- COPIED_DATA_DIR [SOURCE_ASSET_DIR]
//! Optional SOURCE_ASSET_DIR copies only five map files + one skin asset into the
//! already-copied Realm's file tree. It never writes the source or copies Realm.
use md5::{Digest, Md5};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};
fn copy_asset(base: &Path, source: &Path, target: &Path) {
    let relative = target.strip_prefix(base).unwrap();
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::copy(source.join(relative), target).unwrap();
}
fn main() {
    let base = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .expect("copied lazer data dir required"),
    );
    let source = std::env::args_os().nth(2).map(PathBuf::from);
    let start = Instant::now();
    let index = vosu_lazer_library::Index::load(&base).expect("load");
    let cold = start.elapsed();
    let md5 = index.md5s().next().expect("at least one map");
    let start = Instant::now();
    for _ in 0..100_000 {
        std::hint::black_box(index.contains_md5(std::hint::black_box(&md5)));
    }
    let indexed = start.elapsed() / 100_000;
    let start = Instant::now();
    for _ in 0..10_000 {
        std::hint::black_box(index.beatmap(std::hint::black_box(&md5)));
    }
    let api = start.elapsed() / 10_000;
    let mut checked = 0;
    for md5 in index.md5s() {
        let Some(map) = index.beatmap(&md5) else {
            continue;
        };
        let p = Path::new(map["osu_path"].as_str().unwrap());
        if let Some(source) = source.as_ref() {
            copy_asset(&base, source, p);
        }
        if p.is_file() {
            let bytes = std::fs::read(p).unwrap();
            assert_eq!(
                format!("{:x}", Md5::digest(bytes)),
                md5,
                "MD5 must match the mapped file"
            );
            checked += 1;
        }
        if checked == 5 {
            break;
        }
    }
    assert_eq!(checked, 5, "five resolved .osu files must exist");
    if let Some(source) = source.as_ref()
        && let Some(file) = index.skin_asset("skin.ini")
    {
        copy_asset(&base, source, &file.path);
    }
    println!(
        "schema={} sets={} maps={} skins={} scores={} cold_ms={:.3} md5_lookup_ns={} response_us={:.3} md5_file_spotchecks={}",
        index.schema,
        index.counts[0],
        index.counts[1],
        index.counts[2],
        index.counts[3],
        cold.as_secs_f64() * 1000.,
        indexed.as_nanos(),
        api.as_secs_f64() * 1e6,
        checked
    );
}
