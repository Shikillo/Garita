//! Garita de escritorio — backend Tauri.
//!
//! El estado autoritativo vive aquí (en Rust), envuelto en un `Mutex<Store>`.
//! Cada command mutador aplica el cambio, persiste en disco y devuelve el
//! `Store` completo para que el frontend re-pinte. `model.rs` es el mismo
//! fichero que usa la versión TUI, por lo que ambas apps comparten
//! `<config_dir>/xietiao/store.json`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod model;
mod todoist;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{Duration, Local, NaiveDate, NaiveTime, SecondsFormat, TimeZone, Utc};
use tauri::State;

use model::{PomodoroSession, Project, Recurrence, Store, Subtask, Todo, TrashItem, TrashKind};

/// Estado global de la app: el `Store` protegido por un mutex.
struct AppState(Mutex<Store>);

/// Aplica una mutación al store, guarda en disco y devuelve una copia.
fn with_store<F: FnOnce(&mut Store)>(state: &State<AppState>, f: F) -> Store {
    let mut store = state.0.lock().unwrap();
    f(&mut store);
    let _ = store.save();
    store.clone()
}

/// Separa los `#tags` del texto de un to-do. Devuelve (título sin tags, tags en minúsculas).
/// (Portado tal cual de la versión TUI.)
fn parse_tags(text: &str) -> (String, Vec<String>) {
    let mut title_words = Vec::new();
    let mut tags = Vec::new();
    for word in text.split_whitespace() {
        if let Some(tag) = word.strip_prefix('#') {
            let tag = tag.trim().to_lowercase();
            if !tag.is_empty() && !tags.contains(&tag) {
                tags.push(tag);
            }
        } else {
            title_words.push(word);
        }
    }
    let title = title_words.join(" ");
    if title.is_empty() {
        (text.trim().to_string(), tags)
    } else {
        (title, tags)
    }
}

// --- Lectura -------------------------------------------------------------

#[tauri::command]
fn get_store(state: State<AppState>) -> Store {
    state.0.lock().unwrap().clone()
}

// --- Proyectos -------------------------------------------------------------

#[tauri::command]
fn add_project(state: State<AppState>, name: String) -> Store {
    with_store(&state, |s| {
        let name = name.trim();
        if !name.is_empty() {
            s.projects.push(Project::new(name));
        }
    })
}

#[tauri::command]
fn rename_project(state: State<AppState>, project: usize, name: String) -> Store {
    with_store(&state, |s| {
        if let (Some(p), false) = (s.projects.get_mut(project), name.trim().is_empty()) {
            p.name = name.trim().to_string();
        }
    })
}

/// Borra un proyecto mandándolo a la papelera (recuperable).
#[tauri::command]
fn delete_project(state: State<AppState>, project: usize) -> Store {
    with_store(&state, |s| {
        if project < s.projects.len() {
            let p = s.projects.remove(project);
            // Sus tareas pendientes ya exportadas deben borrarse en Todoist.
            for t in &p.todos {
                if let (false, Some(id)) = (t.done, &t.todoist_id) {
                    s.todoist_deleted.push(id.clone());
                }
            }
            s.trash.push(TrashItem {
                kind: TrashKind::Project(p),
                deleted_at: Some(Local::now().date_naive()),
            });
        }
    })
}

#[tauri::command]
fn move_project(state: State<AppState>, project: usize, delta: isize) -> Store {
    with_store(&state, |s| {
        let j = project as isize + delta;
        if j >= 0 && (j as usize) < s.projects.len() {
            s.projects.swap(project, j as usize);
        }
    })
}

// --- To-dos -----------------------------------------------------------------

#[tauri::command]
fn add_todo(state: State<AppState>, project: usize, text: String) -> Store {
    with_store(&state, |s| {
        if text.trim().is_empty() {
            return;
        }
        if let Some(p) = s.projects.get_mut(project) {
            let (title, tags) = parse_tags(&text);
            let mut todo = Todo::new(title);
            todo.tags = tags;
            p.todos.push(todo);
        }
    })
}

/// Reescribe título y tags de una tarea a partir de texto libre con `#tags`.
#[tauri::command]
fn edit_todo(state: State<AppState>, project: usize, todo: usize, text: String) -> Store {
    with_store(&state, |s| {
        if text.trim().is_empty() {
            return;
        }
        if let Some(t) = s.projects.get_mut(project).and_then(|p| p.todos.get_mut(todo)) {
            let (title, tags) = parse_tags(&text);
            t.title = title;
            t.tags = tags;
        }
    })
}

/// Marca una tarea como hecha. Si es recurrente, genera la siguiente
/// aparición justo debajo (misma lógica que la TUI).
fn complete_todo(p: &mut Project, todo: usize, today: NaiveDate) {
    let mut regen: Option<(usize, Todo)> = None;
    if let Some(t) = p.todos.get_mut(todo) {
        t.done = true;
        t.completed_at = Some(today);
        if t.recurrence != Recurrence::None {
            let base = t.date.unwrap_or(today);
            if let Some(next) = t.recurrence.next_date(base) {
                let mut copy = t.clone();
                copy.done = false;
                copy.completed_at = None;
                copy.date = Some(next);
                copy.todoist_id = None; // la nueva aparición aún no está en Todoist
                copy.image = None; // ni comparte la imagen (evita borrados a medias)
                for sub in &mut copy.subtasks {
                    sub.done = false;
                }
                regen = Some((todo + 1, copy));
            }
        }
    }
    if let Some((pos, copy)) = regen {
        p.todos.insert(pos.min(p.todos.len()), copy);
    }
}

/// Completa/descompleta una tarea.
#[tauri::command]
fn toggle_todo(state: State<AppState>, project: usize, todo: usize) -> Store {
    with_store(&state, |s| {
        let Some(p) = s.projects.get_mut(project) else { return };
        let Some(t) = p.todos.get_mut(todo) else { return };
        if t.done {
            t.done = false;
            t.completed_at = None;
        } else {
            complete_todo(p, todo, Local::now().date_naive());
        }
    })
}

/// Borra una tarea mandándola a la papelera (recuperable).
#[tauri::command]
fn delete_todo(state: State<AppState>, project: usize, todo: usize) -> Store {
    with_store(&state, |s| {
        let Some(p) = s.projects.get_mut(project) else { return };
        if todo < p.todos.len() {
            let t = p.todos.remove(todo);
            let name = p.name.clone();
            // Si estaba exportada y pendiente, debe borrarse en Todoist.
            if let (false, Some(id)) = (t.done, &t.todoist_id) {
                s.todoist_deleted.push(id.clone());
            }
            s.trash.push(TrashItem {
                kind: TrashKind::Todo { project: name, todo: t },
                deleted_at: Some(Local::now().date_naive()),
            });
        }
    })
}

#[tauri::command]
fn cycle_priority(state: State<AppState>, project: usize, todo: usize) -> Store {
    with_store(&state, |s| {
        if let Some(t) = s.projects.get_mut(project).and_then(|p| p.todos.get_mut(todo)) {
            t.priority = t.priority.cycle();
        }
    })
}

#[tauri::command]
fn cycle_recurrence(state: State<AppState>, project: usize, todo: usize) -> Store {
    with_store(&state, |s| {
        if let Some(t) = s.projects.get_mut(project).and_then(|p| p.todos.get_mut(todo)) {
            t.recurrence = t.recurrence.cycle();
        }
    })
}

/// Asigna o quita la fecha de una tarea (`null` para quitarla).
/// Sin fecha, la hora tampoco tiene sentido: se quita con ella.
#[tauri::command]
fn set_todo_date(state: State<AppState>, project: usize, todo: usize, date: Option<NaiveDate>) -> Store {
    with_store(&state, |s| {
        if let Some(t) = s.projects.get_mut(project).and_then(|p| p.todos.get_mut(todo)) {
            t.date = date;
            if date.is_none() {
                t.time = None;
            }
        }
    })
}

/// Pone o quita la hora de una tarea. Ponerla en una tarea sin fecha le
/// asigna la de hoy (una hora suelta no cabe en el calendario).
#[tauri::command]
fn set_todo_time(state: State<AppState>, project: usize, todo: usize, time: Option<NaiveTime>) -> Store {
    with_store(&state, |s| {
        if let Some(t) = s.projects.get_mut(project).and_then(|p| p.todos.get_mut(todo)) {
            t.time = time;
            if time.is_some() && t.date.is_none() {
                t.date = Some(Local::now().date_naive());
            }
        }
    })
}

#[tauri::command]
fn move_todo(state: State<AppState>, project: usize, todo: usize, delta: isize) -> Store {
    with_store(&state, |s| {
        let Some(p) = s.projects.get_mut(project) else { return };
        let j = todo as isize + delta;
        if j >= 0 && (j as usize) < p.todos.len() {
            p.todos.swap(todo, j as usize);
        }
    })
}

/// Mueve una tarea a otro proyecto (al final de su lista).
#[tauri::command]
fn move_todo_to_project(state: State<AppState>, project: usize, todo: usize, dest: usize) -> Store {
    with_store(&state, |s| {
        if project == dest || project >= s.projects.len() || dest >= s.projects.len() {
            return;
        }
        let Some(p) = s.projects.get_mut(project) else { return };
        if todo < p.todos.len() {
            let t = p.todos.remove(todo);
            s.projects[dest].todos.push(t);
        }
    })
}

// --- Subtareas --------------------------------------------------------------

#[tauri::command]
fn add_subtask(state: State<AppState>, project: usize, todo: usize, title: String) -> Store {
    with_store(&state, |s| {
        if title.trim().is_empty() {
            return;
        }
        if let Some(t) = s.projects.get_mut(project).and_then(|p| p.todos.get_mut(todo)) {
            t.subtasks.push(Subtask::new(title.trim()));
        }
    })
}

#[tauri::command]
fn toggle_subtask(state: State<AppState>, project: usize, todo: usize, subtask: usize) -> Store {
    with_store(&state, |s| {
        if let Some(sub) = s
            .projects
            .get_mut(project)
            .and_then(|p| p.todos.get_mut(todo))
            .and_then(|t| t.subtasks.get_mut(subtask))
        {
            sub.done = !sub.done;
        }
    })
}

#[tauri::command]
fn delete_subtask(state: State<AppState>, project: usize, todo: usize, subtask: usize) -> Store {
    with_store(&state, |s| {
        if let Some(t) = s.projects.get_mut(project).and_then(|p| p.todos.get_mut(todo)) {
            if subtask < t.subtasks.len() {
                t.subtasks.remove(subtask);
            }
        }
    })
}

// --- Imagen adjunta del to-do -------------------------------------------------
//
// La imagen vive como fichero en `<config_dir>/xietiao/images/`; el modelo solo
// guarda el nombre. El frontend la manda ya reescalada y codificada en JPEG.

/// Directorio de imágenes adjuntas: `<config_dir>/xietiao/images/`.
fn images_dir() -> PathBuf {
    Store::config_dir().join("images")
}

/// Borra del disco la imagen adjunta de una tarea, si la hay.
fn remove_image_file(name: &Option<String>) {
    if let Some(n) = name {
        let _ = fs::remove_file(images_dir().join(n));
    }
}

/// Guarda la imagen (JPEG en base64) y la adjunta a la tarea, reemplazando
/// la anterior si la había.
#[tauri::command]
fn set_todo_image(
    state: State<AppState>,
    project: usize,
    todo: usize,
    data: String,
) -> Result<Store, String> {
    let bytes = BASE64.decode(data).map_err(|e| e.to_string())?;
    let dir = images_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!("img-{}.jpg", Local::now().format("%Y%m%d-%H%M%S%.3f"));
    fs::write(dir.join(&name), bytes).map_err(|e| e.to_string())?;
    Ok(with_store(&state, |s| {
        if let Some(t) = s.projects.get_mut(project).and_then(|p| p.todos.get_mut(todo)) {
            remove_image_file(&t.image); // la anterior ya no se referencia
            t.image = Some(name);
        } else {
            let _ = fs::remove_file(dir.join(&name)); // índice inválido: sin huérfanos
        }
    }))
}

/// Quita la imagen de la tarea y borra su fichero.
#[tauri::command]
fn clear_todo_image(state: State<AppState>, project: usize, todo: usize) -> Store {
    with_store(&state, |s| {
        if let Some(t) = s.projects.get_mut(project).and_then(|p| p.todos.get_mut(todo)) {
            remove_image_file(&t.image);
            t.image = None;
        }
    })
}

/// Devuelve una imagen adjunta como data URL, lista para un `<img>`.
#[tauri::command]
fn get_todo_image(name: String) -> Result<String, String> {
    if name.contains(['/', '\\']) || name.contains("..") {
        return Err("nombre de imagen no válido".into());
    }
    let bytes = fs::read(images_dir().join(&name)).map_err(|e| e.to_string())?;
    Ok(format!("data:image/jpeg;base64,{}", BASE64.encode(bytes)))
}

// --- Documentos (drawer) ------------------------------------------------------
//
// Los documentos viven como ficheros en `<config_dir>/xietiao/docs/`; no tocan
// el `Store`: la lista autoritativa es el propio directorio. El frontend los
// manda y los pide codificados en base64, como las imágenes adjuntas.

/// Directorio de documentos: `<config_dir>/xietiao/docs/`.
fn docs_dir() -> PathBuf {
    Store::config_dir().join("docs")
}

/// Extensiones de documento admitidas.
const DOC_EXTS: &[&str] = &["pdf", "txt", "md", "png", "jpg", "jpeg", "gif", "webp"];

/// Comprueba que el nombre es un fichero plano (sin rutas) con extensión admitida.
fn valid_doc_name(name: &str) -> bool {
    !name.contains(['/', '\\'])
        && !name.contains("..")
        && Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| DOC_EXTS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false)
}

/// Lista los documentos guardados, ordenados alfabéticamente.
#[tauri::command]
fn list_docs() -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(docs_dir())
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| valid_doc_name(n))
                .collect()
        })
        .unwrap_or_default();
    names.sort_by_key(|n| n.to_lowercase());
    names
}

/// Guarda un documento (bytes en base64). Si el nombre ya existe, añade un
/// sufijo numérico antes de la extensión. Devuelve la lista actualizada.
/// (Async: los PDF pueden ser grandes y así no bloquean el hilo principal.)
#[tauri::command]
async fn add_doc(name: String, data: String) -> Result<Vec<String>, String> {
    if !valid_doc_name(&name) {
        return Err("nombre de documento no válido (formatos: pdf, txt, md, imágenes)".into());
    }
    let bytes = BASE64.decode(data).map_err(|e| e.to_string())?;
    let dir = docs_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = Path::new(&name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("documento");
    let ext = Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let mut target = dir.join(&name);
    let mut n = 1;
    while target.exists() {
        n += 1;
        target = dir.join(format!("{stem} ({n}).{ext}"));
    }
    fs::write(&target, bytes).map_err(|e| e.to_string())?;
    Ok(list_docs())
}

/// Devuelve un documento como base64 (el MIME lo deduce el frontend).
#[tauri::command]
async fn get_doc(name: String) -> Result<String, String> {
    if !valid_doc_name(&name) {
        return Err("nombre de documento no válido".into());
    }
    let bytes = fs::read(docs_dir().join(&name)).map_err(|e| e.to_string())?;
    Ok(BASE64.encode(bytes))
}

/// Borra un documento del disco (definitivo: los documentos no pasan por la
/// papelera). Devuelve la lista actualizada.
#[tauri::command]
fn delete_doc(name: String) -> Result<Vec<String>, String> {
    if !valid_doc_name(&name) {
        return Err("nombre de documento no válido".into());
    }
    fs::remove_file(docs_dir().join(&name)).map_err(|e| e.to_string())?;
    Ok(list_docs())
}

// --- Boceto (pizarra Excalidraw) ---------------------------------------------
//
// Un único lienzo global; la escena se guarda tal cual (JSON de Excalidraw)
// en <config_dir>/xietiao/sketch.excalidraw.

fn sketch_path() -> PathBuf {
    Store::config_dir().join("sketch.excalidraw")
}

/// Devuelve la escena guardada, o cadena vacía si aún no hay boceto.
#[tauri::command]
async fn get_sketch() -> Result<String, String> {
    match fs::read_to_string(sketch_path()) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Guarda la escena del boceto (JSON serializado por Excalidraw).
#[tauri::command]
async fn set_sketch(data: String) -> Result<(), String> {
    let path = sketch_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, data).map_err(|e| e.to_string())
}

// --- Pet ----------------------------------------------------------------------
//
// Gif de la mascota personalizado: si el usuario deja un pet.gif en
// <config_dir>/xietiao/ (junto al store.json), sustituye al de assets.

/// Devuelve el gif personalizado en base64, o None si no hay.
#[tauri::command]
fn get_pet() -> Option<String> {
    fs::read(Store::config_dir().join("pet.gif"))
        .ok()
        .map(|b| BASE64.encode(b))
}

// --- Notas ------------------------------------------------------------------

/// Guarda notas: generales si `project` es `null`, del proyecto si no.
#[tauri::command]
fn set_notes(state: State<AppState>, project: Option<usize>, text: String) -> Store {
    with_store(&state, |s| match project {
        None => s.notes = text,
        Some(i) => {
            if let Some(p) = s.projects.get_mut(i) {
                p.notes = text;
            }
        }
    })
}

// --- Papelera ---------------------------------------------------------------

/// Reconcilia con Todoist la tarea que vuelve de la papelera: si su borrado
/// remoto aún estaba pendiente, se cancela (la tarea sigue allí); si ya se
/// ejecutó, se olvida la id para que la tarea se re-exporte como nueva.
fn unmark_deleted(deleted: &mut Vec<String>, todo: &mut Todo) {
    if todo.done {
        return;
    }
    if let Some(id) = &todo.todoist_id {
        if deleted.iter().any(|x| x == id) {
            deleted.retain(|x| x != id.as_str());
        } else {
            todo.todoist_id = None;
        }
    }
}

#[tauri::command]
fn restore_trash(state: State<AppState>, item: usize) -> Store {
    with_store(&state, |s| {
        if item >= s.trash.len() {
            return;
        }
        let entry = s.trash.remove(item);
        match entry.kind {
            TrashKind::Project(mut p) => {
                for t in &mut p.todos {
                    unmark_deleted(&mut s.todoist_deleted, t);
                }
                s.projects.push(p);
            }
            TrashKind::Todo { project, mut todo } => {
                unmark_deleted(&mut s.todoist_deleted, &mut todo);
                // Busca el proyecto por nombre; si ya no existe, lo recrea.
                match s.projects.iter().position(|p| p.name == project) {
                    Some(i) => s.projects[i].todos.push(todo),
                    None => {
                        let mut p = Project::new(project);
                        p.todos.push(todo);
                        s.projects.push(p);
                    }
                }
            }
        }
    })
}

#[tauri::command]
fn purge_trash(state: State<AppState>, item: usize) -> Store {
    with_store(&state, |s| {
        if item < s.trash.len() {
            // Al eliminar definitivamente, sus imágenes adjuntas también.
            let entry = s.trash.remove(item);
            match &entry.kind {
                TrashKind::Project(p) => p.todos.iter().for_each(|t| remove_image_file(&t.image)),
                TrashKind::Todo { todo, .. } => remove_image_file(&todo.image),
            }
        }
    })
}

// --- Pomodoro ---------------------------------------------------------------

/// Registra un foco completado (el temporizador corre en el frontend).
#[tauri::command]
fn record_pomodoro(state: State<AppState>, project: Option<String>, todo: Option<String>) -> Store {
    with_store(&state, |s| {
        s.pomodoros.push(PomodoroSession {
            date: Local::now().date_naive(),
            project,
            todo,
        });
    })
}

// --- Todoist ------------------------------------------------------------------

/// Resultado de la sincronización con Todoist, para el frontend.
#[derive(Clone, serde::Serialize)]
struct TodoistOutcome {
    store: Store,
    /// Tareas creadas en Todoist en esta pasada.
    exported: usize,
    /// Pendientes que ya estaban exportadas y se han saltado.
    skipped: usize,
    /// Tareas marcadas como hechas aquí por estar completadas en Todoist.
    completed: usize,
    /// Tareas nuevas traídas de Todoist (creadas desde otro dispositivo).
    imported: usize,
    /// Tareas borradas en Todoist por haberse borrado aquí.
    deleted: usize,
    /// Tareas cerradas en Todoist por haberse completado aquí.
    closed: usize,
    /// Si algo falló a medias, el mensaje (lo ya hecho cuenta igualmente).
    error: Option<String>,
}

/// Guarda el token de API de Todoist (o lo borra, si viene vacío).
#[tauri::command]
fn set_todoist_token(state: State<AppState>, token: String) -> Store {
    with_store(&state, |s| {
        let token = token.trim();
        s.todoist_token = (!token.is_empty()).then(|| token.to_string());
    })
}

/// Sincroniza con Todoist: envía las tareas pendientes que aún no se han
/// exportado (cada proyecto local se corresponde con uno remoto homónimo) y
/// marca como hechas aquí las ya exportadas que estén completadas allí.
#[tauri::command]
async fn todoist_export(state: State<'_, AppState>) -> Result<TodoistOutcome, String> {
    // Recoge lo pendiente sin retener el lock durante las peticiones de red.
    let (token, outgoing, known_ids, to_delete, recently_done) = {
        let s = state.0.lock().unwrap();
        let token = s
            .todoist_token
            .clone()
            .ok_or("no hay token de Todoist configurado")?;
        let to_delete = s.todoist_deleted.clone();
        let mut outgoing = Vec::new();
        let mut known_ids = Vec::new();
        // Completadas aquí hace poco: se cierran también allí. La ventana de
        // 7 días acota las peticiones (cerrar una ya cerrada es inocuo).
        let mut recently_done = Vec::new();
        let week_ago = Local::now().date_naive() - Duration::days(7);
        for (pi, p) in s.projects.iter().enumerate() {
            for (ti, t) in p.todos.iter().enumerate() {
                if t.done {
                    if let (Some(id), Some(d)) = (&t.todoist_id, t.completed_at) {
                        if d >= week_ago {
                            recently_done.push(id.clone());
                        }
                    }
                    continue;
                }
                if let Some(id) = &t.todoist_id {
                    known_ids.push(id.clone());
                    continue;
                }
                outgoing.push(todoist::Outgoing {
                    project: pi,
                    todo: ti,
                    project_name: p.name.clone(),
                    content: t.title.clone(),
                    due_date: t.date.map(|d| d.to_string()),
                    // Con hora, Todoist quiere un RFC3339 en UTC.
                    due_datetime: match (t.date, t.time) {
                        (Some(d), Some(tm)) => Local
                            .from_local_datetime(&d.and_time(tm))
                            .earliest()
                            .map(|l| l.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Secs, true)),
                        _ => None,
                    },
                    priority: todoist::priority(t.priority),
                    labels: t.tags.clone(),
                });
            }
        }
        (token, outgoing, known_ids, to_delete, recently_done)
    };
    let skipped = known_ids.len();

    // Propaga los borrados locales ANTES de importar: lo borrado aquí se
    // borra allí, y así la importación de después ya no lo trae de vuelta.
    let (deleted_ids, delete_error) = if to_delete.is_empty() {
        (Vec::new(), None)
    } else {
        todoist::delete_tasks(&token, &to_delete).await
    };

    // Propaga los completados locales recientes.
    let (closed, close_error) = if recently_done.is_empty() {
        (0, None)
    } else {
        todoist::close_tasks(&token, &recently_done).await
    };

    // Vuelta: qué tareas ya exportadas se han completado en Todoist.
    let (remote_done, pull_error) = if known_ids.is_empty() {
        (Vec::new(), None)
    } else {
        todoist::fetch_completed(&token, &known_ids).await
    };

    // Ida: crea en Todoist lo que aún no está.
    let (created, push_error) = if outgoing.is_empty() {
        (Vec::new(), None)
    } else {
        todoist::export(&token, &outgoing).await
    };

    // Vuelta: tareas activas en Todoist (incluye las creadas desde otros
    // dispositivos) para importar las que aún no existan aquí.
    let (incoming, import_error) = todoist::fetch_active(&token).await;

    // Registra las ids remotas de lo creado (aunque haya fallado a medias,
    // para no duplicarlo en el siguiente intento), marca lo completado en
    // Todoist (por id remota: las inserciones de recurrentes mueven índices)
    // y persiste.
    let mut s = state.0.lock().unwrap();
    // Las lápidas ya ejecutadas se olvidan; las fallidas se reintentarán.
    s.todoist_deleted.retain(|id| !deleted_ids.contains(id));
    let exported = created.len();
    for (pi, ti, id) in created {
        if let Some(t) = s.projects.get_mut(pi).and_then(|p| p.todos.get_mut(ti)) {
            t.todoist_id = Some(id);
        }
    }
    let today = Local::now().date_naive();
    let mut completed = 0;
    for id in &remote_done {
        for p in &mut s.projects {
            if let Some(ti) = p
                .todos
                .iter()
                .position(|t| !t.done && t.todoist_id.as_deref() == Some(id))
            {
                complete_todo(p, ti, today);
                completed += 1;
                break;
            }
        }
    }

    // Importa las tareas activas de Todoist que aún no conocemos por su id
    // remota (las recién exportadas ya la tienen y se saltan, sin duplicar).
    let known: HashSet<String> = s
        .projects
        .iter()
        .flat_map(|p| p.todos.iter())
        .filter_map(|t| t.todoist_id.clone())
        .collect();
    let mut imported = 0;
    for inc in incoming {
        // Se saltan las ya conocidas y las pendientes de borrado remoto
        // (si el borrado falló, re-importarlas las resucitaría).
        if known.contains(&inc.todoist_id) || s.todoist_deleted.contains(&inc.todoist_id) {
            continue;
        }
        // Proyecto local homónimo; si no existe, se crea.
        let pi = match s.projects.iter().position(|p| p.name == inc.project_name) {
            Some(i) => i,
            None => {
                s.projects.push(Project::new(inc.project_name.clone()));
                s.projects.len() - 1
            }
        };
        let mut todo = Todo::new(inc.content);
        todo.date = inc.due_date;
        todo.time = inc.due_time;
        todo.priority = inc.priority;
        todo.tags = inc.labels.into_iter().map(|l| l.to_lowercase()).collect();
        todo.todoist_id = Some(inc.todoist_id);
        s.projects[pi].todos.push(todo);
        imported += 1;
    }

    if exported > 0 || completed > 0 || imported > 0 || !deleted_ids.is_empty() {
        let _ = s.save();
    }
    let error = push_error
        .or(pull_error)
        .or(import_error)
        .or(delete_error)
        .or(close_error);
    Ok(TodoistOutcome {
        store: s.clone(),
        exported,
        skipped,
        completed,
        imported,
        deleted: deleted_ids.len(),
        closed,
        error,
    })
}

/// Abre un enlace (solo http/https) en el navegador del sistema; lo usan los
/// enlaces markdown de las notas, que no deben navegar dentro del webview.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("solo se abren enlaces http(s)".into());
    }
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(not(target_os = "macos"))]
    let cmd = "xdg-open";
    std::process::Command::new(cmd)
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Cierra la aplicación (atajo `q`, como en la TUI).
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .manage(AppState(Mutex::new(Store::load())))
        .invoke_handler(tauri::generate_handler![
            get_store,
            add_project,
            rename_project,
            delete_project,
            move_project,
            add_todo,
            edit_todo,
            toggle_todo,
            delete_todo,
            cycle_priority,
            cycle_recurrence,
            set_todo_date,
            set_todo_time,
            move_todo,
            move_todo_to_project,
            add_subtask,
            toggle_subtask,
            delete_subtask,
            set_todo_image,
            clear_todo_image,
            get_todo_image,
            list_docs,
            add_doc,
            get_doc,
            delete_doc,
            get_sketch,
            set_sketch,
            get_pet,
            set_notes,
            restore_trash,
            purge_trash,
            record_pomodoro,
            set_todoist_token,
            todoist_export,
            open_url,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error al arrancar Garita");
}
