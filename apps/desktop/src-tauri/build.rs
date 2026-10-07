fn main() {
    println!("cargo:rustc-env=WORKER_TARGET={}", std::env::var("TARGET").unwrap());
    tauri_build::build()
}
