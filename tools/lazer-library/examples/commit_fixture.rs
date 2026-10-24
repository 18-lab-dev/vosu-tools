//! Real native commits for service refresh integration tests, synthetic fixtures only.
//! create/commit COPY_DIR; never points this helper at a user's library.
use std::{
    ffi::{CString, c_char},
    path::PathBuf,
};
unsafe extern "C" {
    fn vosu_realm_test_commits(path: *const c_char, count: i32) -> i32;
}
fn main() {
    let action = std::env::args().nth(1).expect("create or commit");
    let base = PathBuf::from(std::env::args_os().nth(2).expect("synthetic directory"));
    let path = base.join("client.realm");
    if action == "create" {
        std::fs::create_dir_all(&base).unwrap();
        realm_reader::fixture(&path, false).unwrap();
        return;
    }
    assert_eq!(action, "commit");
    let tables = realm_reader::read(&path).unwrap();
    assert_eq!(tables.rows["class_Beatmap"].len(), 1);
    assert_eq!(
        tables.rows["class_Beatmap"][0]["ID"],
        "00000000-0000-0000-0000-000000000002"
    );
    assert_eq!(
        tables.rows["class_Score"][0]["ID"],
        "00000000-0000-0000-0000-000000000004"
    );
    drop(tables);
    let path = CString::new(path.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { vosu_realm_test_commits(path.as_ptr(), 200) }, 0);
}
