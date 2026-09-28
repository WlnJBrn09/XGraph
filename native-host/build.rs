fn main() {
    #[cfg(windows)]
    {
        println!("cargo:rustc-link-lib=advapi32");

        let ico = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("build")
            .join("icon.ico");
        println!("cargo:rerun-if-changed={}", ico.display());
        let mut res = winres::WindowsResource::new();
        if ico.is_file() {
            res.set_icon(ico.to_str().expect("ico path utf-8"));
        }
        res.set("ProductName", "XGraph");
        res.set("FileDescription", "XGraph — local-first drawing app");
        res.set("CompanyName", "XGraph");
        res.set("LegalCopyright", "XGraph");
        if let Err(e) = res.compile() {
            eprintln!("cargo:warning=winres failed (exe icon may be missing): {e}");
        }
    }
}
