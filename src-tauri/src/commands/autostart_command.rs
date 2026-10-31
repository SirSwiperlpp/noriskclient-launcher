use crate::error::{AppError, CommandError};
use tauri::{command, AppHandle};
use tauri_plugin_autostart::ManagerExt;

#[command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), CommandError> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| CommandError::from(AppError::Other(e.to_string())))
}

#[command]
pub fn is_autostart_enabled(app: AppHandle) -> Result<bool, CommandError> {
    app.autolaunch()
        .is_enabled()
        .map_err(|e| CommandError::from(AppError::Other(e.to_string())))
}
