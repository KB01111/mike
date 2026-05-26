#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, path::BaseDirectory};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

struct NextSidecar(Mutex<Option<CommandChild>>);

fn wait_for_server(host: &str, port: u16, max_attempts: u32) -> Result<(), String> {
    let addr = format!("{}:{}", host, port);
    for attempt in 1..=max_attempts {
        if let Ok(_stream) = TcpStream::connect_timeout(
            &addr.parse().map_err(|e| format!("Invalid address: {}", e))?,
            Duration::from_millis(100),
        ) {
            println!("[next-sidecar] Server ready on {}", addr);
            return Ok(());
        }
        if attempt < max_attempts {
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    Err(format!("Server did not become ready on {} after {} attempts", addr, max_attempts))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            #[cfg(not(debug_assertions))]
            {
                let resource_dir = app.path().resolve("", BaseDirectory::Resource)?;
                let next_dir = resource_dir.join(".next").join("standalone");
                let sidecar = app
                    .shell()
                    .sidecar("mike-next-sidecar")?
                    .env("PORT", "3070")
                    .env("HOSTNAME", "127.0.0.1")
                    .env(
                        "MIKE_NEXT_STANDALONE_DIR",
                        next_dir.to_string_lossy().to_string(),
                    );
                let (mut rx, child) = sidecar.spawn()?;
                app.manage(NextSidecar(Mutex::new(Some(child))));

                tauri::async_runtime::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(line) => {
                                println!("[next-sidecar] {}", String::from_utf8_lossy(&line));
                            }
                            CommandEvent::Stderr(line) => {
                                eprintln!("[next-sidecar] {}", String::from_utf8_lossy(&line));
                            }
                            _ => {}
                        }
                    }
                });

                // Wait for the Next.js server to be ready before continuing
                wait_for_server("127.0.0.1", 3070, 50)?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Mike desktop");
}
