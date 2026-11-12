use std::{io, sync::Arc};

use anyhow::{Context, Result};
use mymind_core::model_runtime::ModelRuntime;
use serde_json::Value;
use tauri::{Emitter, WebviewWindow};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{PBT_APMRESUMEAUTOMATIC, WM_NCDESTROY, WM_POWERBROADCAST},
    },
};

const MYMIND_RESUME_SUBCLASS: usize = 1;

struct ResumeHandler {
    window: WebviewWindow,
    model: Arc<ModelRuntime>,
}

unsafe extern "system" fn handle(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass_id: usize,
    handler: usize,
) -> LRESULT {
    let handler = handler as *mut ResumeHandler;
    if message == WM_POWERBROADCAST && wparam == PBT_APMRESUMEAUTOMATIC as WPARAM {
        // Windows delivers subclass callbacks on the owning window thread.
        let data = unsafe { &*handler };
        let _ = data.window.emit_to("main", "planner-changed", Value::Null);
        let model = data.model.clone();
        tauri::async_runtime::spawn(async move {
            model.resume().await;
        });
    } else if message == WM_NCDESTROY {
        unsafe {
            RemoveWindowSubclass(hwnd, Some(handle), subclass_id);
            drop(Box::from_raw(handler));
        }
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

pub fn install(window: &WebviewWindow, model: Arc<ModelRuntime>) -> Result<()> {
    let hwnd = window.hwnd()?.0 as HWND;
    let data = Box::into_raw(Box::new(ResumeHandler {
        window: window.clone(),
        model,
    }));
    // Ownership transfers to the window until WM_NCDESTROY after a successful install.
    if unsafe { SetWindowSubclass(hwnd, Some(handle), MYMIND_RESUME_SUBCLASS, data as usize) } == 0
    {
        unsafe {
            drop(Box::from_raw(data));
        }
        return Err(io::Error::last_os_error())
            .context("Could not subscribe to Windows resume events.");
    }
    Ok(())
}
