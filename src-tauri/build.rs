fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "planner_request",
            "planner_audio",
            "planner_speak",
        ]),
    ))
    .expect("build MYMIND desktop command permissions");
}
