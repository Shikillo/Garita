//! Xietiao de escritorio — backend Tauri.
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
use std::sync::Mutex;

use chrono::{Local, NaiveDate};
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
#[tauri::command]
fn set_todo_date(state: State<AppState>, project: usize, todo: usize, date: Option<NaiveDate>) -> Store {
    with_store(&state, |s| {
        if let Some(t) = s.projects.get_mut(project).and_then(|p| p.todos.get_mut(todo)) {
            t.date = date;
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

#[tauri::command]
fn restore_trash(state: State<AppState>, item: usize) -> Store {
    with_store(&state, |s| {
        if item >= s.trash.len() {
            return;
        }
        let entry = s.trash.remove(item);
        match entry.kind {
            TrashKind::Project(p) => s.projects.push(p),
            TrashKind::Todo { project, todo } => {
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
            s.trash.remove(item);
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
    let (token, outgoing, known_ids) = {
        let s = state.0.lock().unwrap();
        let token = s
            .todoist_token
            .clone()
            .ok_or("no hay token de Todoist configurado")?;
        let mut outgoing = Vec::new();
        let mut known_ids = Vec::new();
        for (pi, p) in s.projects.iter().enumerate() {
            for (ti, t) in p.todos.iter().enumerate() {
                if t.done {
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
                    priority: todoist::priority(t.priority),
                    labels: t.tags.clone(),
                });
            }
        }
        (token, outgoing, known_ids)
    };
    let skipped = known_ids.len();

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
        if known.contains(&inc.todoist_id) {
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
        todo.priority = inc.priority;
        todo.tags = inc.labels.into_iter().map(|l| l.to_lowercase()).collect();
        todo.todoist_id = Some(inc.todoist_id);
        s.projects[pi].todos.push(todo);
        imported += 1;
    }

    if exported > 0 || completed > 0 || imported > 0 {
        let _ = s.save();
    }
    let error = push_error.or(pull_error).or(import_error);
    Ok(TodoistOutcome { store: s.clone(), exported, skipped, completed, imported, error })
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
            move_todo,
            move_todo_to_project,
            add_subtask,
            toggle_subtask,
            delete_subtask,
            set_notes,
            restore_trash,
            purge_trash,
            record_pomodoro,
            set_todoist_token,
            todoist_export,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error al arrancar Xietiao");
}
