fn main() {
    // whisper-cpp-plus-sys enables OpenMP in its bundled ggml CPU build. Some
    // Rust toolchains use lld for final linking, which does not infer the GNU
    // OpenMP runtime from the CMake-built objects.
    if cfg!(target_os = "linux") {
        println!("cargo:rustc-link-lib=gomp");
    }
}
