fn main() {
    println!("cargo:rerun-if-env-changed=STUDENT_CENTER_UPDATER_ENDPOINT");
    println!("cargo:rerun-if-env-changed=STUDENT_CENTER_UPDATER_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=STUDENT_CENTER_SUPABASE_URL");
    println!("cargo:rerun-if-env-changed=STUDENT_CENTER_SUPABASE_PUBLISHABLE_KEY");
    tauri_build::build()
}
