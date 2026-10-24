//! Read-only heap/mapping phase profile on a copied lazer directory.
//! cargo run --release -p vosu-lazer-library --example memory_profile -- COPY_DIR
#[cfg(all(target_os = "linux", target_env = "gnu"))]
mod linux {
    use std::path::PathBuf;
    #[repr(C)]
    #[derive(Default)]
    struct Mallinfo {
        arena: usize,
        ordblks: usize,
        smblks: usize,
        hblks: usize,
        hblkhd: usize,
        usmblks: usize,
        fsmblks: usize,
        uordblks: usize,
        fordblks: usize,
        keepcost: usize,
    }
    unsafe extern "C" {
        fn mallinfo2() -> Mallinfo;
        fn malloc_trim(pad: usize) -> i32;
    }
    fn stage(name: &str) {
        let heap = unsafe { mallinfo2() };
        let maps = std::fs::read_to_string("/proc/self/smaps_rollup").unwrap();
        let mut fields = serde_json::Map::new();
        for line in maps.lines() {
            if let Some((key, rest)) = line.split_once(':')
                && [
                    "Rss",
                    "Pss",
                    "Pss_Anon",
                    "Pss_File",
                    "Anonymous",
                    "Private_Dirty",
                ]
                .contains(&key)
            {
                fields.insert(
                    format!("{key}_kib"),
                    rest.split_whitespace()
                        .next()
                        .unwrap()
                        .parse::<u64>()
                        .unwrap()
                        .into(),
                );
            }
        }
        fields.insert("phase".into(), name.into());
        fields.insert("heap_live_bytes".into(), heap.uordblks.into());
        fields.insert("heap_free_retained_bytes".into(), heap.fordblks.into());
        fields.insert("allocator_mmap_bytes".into(), heap.hblkhd.into());
        println!("{}", serde_json::Value::Object(fields));
    }
    pub fn run() {
        let base = PathBuf::from(
            std::env::args_os()
                .nth(1)
                .expect("copied lazer directory required"),
        );
        stage("startup");
        let source = base.join("client.realm");
        let tables = std::thread::spawn(move || realm_reader::read(&source).unwrap())
            .join()
            .unwrap();
        stage("decoded_realm_rows_snapshot_already_closed");
        drop(tables);
        stage("decoded_rows_dropped");
        unsafe {
            malloc_trim(0);
        }
        stage("decoded_rows_trimmed");
        let index = std::thread::spawn(move || vosu_lazer_library::Index::load(&base).unwrap())
            .join()
            .unwrap();
        stage("published_index");
        vosu_lazer_library::release_allocator_pages();
        stage("published_index_trimmed");
        std::hint::black_box(&index);
        drop(index);
        stage("index_dropped");
        unsafe {
            malloc_trim(0);
        }
        stage("index_trimmed");
    }
}
fn main() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    linux::run();
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    eprintln!("memory_profile requires Linux/glibc smaps_rollup and mallinfo2");
}
