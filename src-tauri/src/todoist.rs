//! Integración con Todoist (API unificada v1): sincronización de tareas.
//!
//! Ida (Xietiao → Todoist): cada tarea pendiente se crea una única vez en
//! Todoist (su id remota se recuerda en `Todo::todoist_id`), dentro de un
//! proyecto remoto homónimo del local (se crea si no existe).
//!
//! Vuelta (Todoist → Xietiao): las tareas ya exportadas que aparezcan
//! completadas en Todoist se marcan como hechas también aquí.

use std::collections::HashMap;

use chrono::NaiveDate;
use serde::Deserialize;
use serde_json::json;

use crate::model::Priority;

const API: &str = "https://api.todoist.com/api/v1";

/// Proyecto tal como lo devuelve la API (sólo los campos que usamos).
#[derive(Deserialize)]
struct RemoteProject {
    id: String,
    name: String,
}

/// Tarea tal como la devuelve la API (sólo los campos que usamos).
#[derive(Deserialize)]
struct RemoteTask {
    id: String,
}

/// Fecha de vencimiento de una tarea remota. `date` puede ser «YYYY-MM-DD» o
/// una marca con hora «YYYY-MM-DDThh:mm:ss»; nos quedamos con el día.
#[derive(Deserialize)]
struct RemoteDue {
    date: String,
}

/// Tarea activa (pendiente) tal como la lista la API, con lo que importamos.
#[derive(Deserialize)]
struct ActiveTask {
    id: String,
    content: String,
    project_id: String,
    #[serde(default)]
    priority: u8,
    #[serde(default)]
    due: Option<RemoteDue>,
    #[serde(default)]
    labels: Vec<String>,
}

/// Estado de una tarea remota ya exportada. La API v1 sigue devolviendo por id
/// las tareas completadas (`checked`) e incluso las borradas (`is_deleted`).
#[derive(Deserialize)]
struct RemoteTaskState {
    checked: bool,
    is_deleted: bool,
}

/// Página de resultados: los listados de la API v1 vienen paginados.
#[derive(Deserialize)]
struct Page<T> {
    results: Vec<T>,
    next_cursor: Option<String>,
}

/// Tarea local lista para exportar, con su posición dentro del `Store`.
pub struct Outgoing {
    pub project: usize,
    pub todo: usize,
    pub project_name: String,
    pub content: String,
    pub due_date: Option<String>,
    pub priority: u8,
    pub labels: Vec<String>,
}

/// Tarea remota nueva lista para importar a un proyecto local (por nombre).
pub struct Incoming {
    pub todoist_id: String,
    pub project_name: String,
    pub content: String,
    pub due_date: Option<NaiveDate>,
    pub priority: Priority,
    pub labels: Vec<String>,
}

/// Prioridad local → prioridad Todoist (1 normal … 4 urgente).
pub fn priority(p: Priority) -> u8 {
    match p {
        Priority::None => 1,
        Priority::Low => 2,
        Priority::Medium => 3,
        Priority::High => 4,
    }
}

/// Prioridad Todoist (1 normal … 4 urgente) → prioridad local.
pub fn priority_from(p: u8) -> Priority {
    match p {
        4 => Priority::High,
        3 => Priority::Medium,
        2 => Priority::Low,
        _ => Priority::None,
    }
}

/// Mensaje legible para un error de red/API.
fn describe(e: reqwest::Error) -> String {
    match e.status() {
        Some(reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN) => {
            "el token no es válido".into()
        }
        _ => e.to_string(),
    }
}

/// Trae todos los proyectos remotos. `by_id` decide la clave del mapa:
/// `true` → id→nombre (para importar), `false` → nombre→id (para exportar).
async fn fetch_projects_map(
    client: &reqwest::Client,
    auth: &str,
    by_id: bool,
) -> Result<HashMap<String, String>, String> {
    let mut projects = HashMap::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut req = client
            .get(format!("{API}/projects"))
            .header("Authorization", auth);
        if let Some(c) = &cursor {
            req = req.query(&[("cursor", c)]);
        }
        let page: Page<RemoteProject> = req
            .send()
            .await
            .map_err(describe)?
            .error_for_status()
            .map_err(describe)?
            .json()
            .await
            .map_err(describe)?;
        projects.extend(page.results.into_iter().map(|p| {
            if by_id {
                (p.id, p.name)
            } else {
                (p.name, p.id)
            }
        }));
        match page.next_cursor {
            Some(c) => cursor = Some(c),
            None => return Ok(projects),
        }
    }
}

/// Proyectos remotos por nombre → id (para exportar).
async fn fetch_projects(
    client: &reqwest::Client,
    auth: &str,
) -> Result<HashMap<String, String>, String> {
    fetch_projects_map(client, auth, false).await
}

async fn post_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    auth: &str,
    path: &str,
    body: &serde_json::Value,
) -> Result<T, String> {
    client
        .post(format!("{API}/{path}"))
        .header("Authorization", auth)
        .json(body)
        .send()
        .await
        .map_err(describe)?
        .error_for_status()
        .map_err(describe)?
        .json()
        .await
        .map_err(describe)
}

/// Consulta en Todoist las tareas de `ids` y devuelve las que están
/// completadas (no borradas). Si algo falló a medias, el mensaje de error;
/// las ids ya comprobadas cuentan igualmente.
pub async fn fetch_completed(token: &str, ids: &[String]) -> (Vec<String>, Option<String>) {
    let client = reqwest::Client::new();
    let auth = format!("Bearer {token}");
    let mut completed = Vec::new();
    for id in ids {
        let response = match client
            .get(format!("{API}/tasks/{id}"))
            .header("Authorization", &auth)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => return (completed, Some(describe(e))),
        };
        // Una id que ya no existe (purgada) no es un error: se ignora.
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            continue;
        }
        let response = match response.error_for_status() {
            Ok(r) => r,
            Err(e) => return (completed, Some(describe(e))),
        };
        match response.json::<RemoteTaskState>().await {
            Ok(s) if s.checked && !s.is_deleted => completed.push(id.clone()),
            Ok(_) => {}
            Err(e) => return (completed, Some(describe(e))),
        }
    }
    (completed, None)
}

/// Exporta `outgoing` a Todoist en orden. Devuelve las tareas creadas como
/// `(project, todo, id_remota)` y, si algo falló a medias, el mensaje de
/// error; así el llamador registra lo ya creado y no lo duplica al reintentar.
pub async fn export(
    token: &str,
    outgoing: &[Outgoing],
) -> (Vec<(usize, usize, String)>, Option<String>) {
    let client = reqwest::Client::new();
    let auth = format!("Bearer {token}");

    // Proyectos remotos existentes, por nombre.
    let mut project_ids = match fetch_projects(&client, &auth).await {
        Ok(map) => map,
        Err(e) => return (Vec::new(), Some(e)),
    };

    let mut created = Vec::new();
    for task in outgoing {
        // Asegura el proyecto remoto homónimo.
        if !project_ids.contains_key(&task.project_name) {
            let body = json!({ "name": task.project_name });
            match post_json::<RemoteProject>(&client, &auth, "projects", &body).await {
                Ok(p) => {
                    project_ids.insert(p.name, p.id);
                }
                Err(e) => return (created, Some(e)),
            }
        }
        let mut body = json!({
            "content": task.content,
            "project_id": project_ids[&task.project_name],
            "priority": task.priority,
        });
        if let Some(d) = &task.due_date {
            body["due_date"] = json!(d);
        }
        if !task.labels.is_empty() {
            body["labels"] = json!(task.labels);
        }
        match post_json::<RemoteTask>(&client, &auth, "tasks", &body).await {
            Ok(t) => created.push((task.project, task.todo, t.id)),
            Err(e) => return (created, Some(e)),
        }
    }
    (created, None)
}

/// Trae todas las tareas activas (pendientes) de Todoist para importar las que
/// aún no existan aquí. Devuelve cada tarea con el nombre de su proyecto remoto
/// resuelto (o «Todoist» si no se encontró) y, si algo falló, el mensaje de
/// error; lo ya recogido cuenta igualmente (el llamador salta las conocidas).
pub async fn fetch_active(token: &str) -> (Vec<Incoming>, Option<String>) {
    let client = reqwest::Client::new();
    let auth = format!("Bearer {token}");

    let names = match fetch_projects_map(&client, &auth, true).await {
        Ok(m) => m,
        Err(e) => return (Vec::new(), Some(e)),
    };

    let mut incoming = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut req = client
            .get(format!("{API}/tasks"))
            .header("Authorization", &auth);
        if let Some(c) = &cursor {
            req = req.query(&[("cursor", c)]);
        }
        let page: Page<ActiveTask> = match req
            .send()
            .await
            .and_then(|r| r.error_for_status())
        {
            Ok(r) => match r.json().await {
                Ok(p) => p,
                Err(e) => return (incoming, Some(describe(e))),
            },
            Err(e) => return (incoming, Some(describe(e))),
        };
        for t in page.results {
            let project_name = names
                .get(&t.project_id)
                .cloned()
                .unwrap_or_else(|| "Todoist".to_string());
            let due_date = t.due.and_then(|d| {
                let day = d.date.get(..10).unwrap_or(d.date.as_str());
                NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()
            });
            incoming.push(Incoming {
                todoist_id: t.id,
                project_name,
                content: t.content,
                due_date,
                priority: priority_from(t.priority),
                labels: t.labels,
            });
        }
        match page.next_cursor {
            Some(c) => cursor = Some(c),
            None => return (incoming, None),
        }
    }
}
