//! Modelo de datos de Garita y persistencia en disco (JSON).

use std::fs;
use std::path::PathBuf;

use chrono::{Datelike, Duration, NaiveDate, NaiveTime};
use serde::{Deserialize, Serialize};

/// Prioridad de una tarea.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Priority {
    #[default]
    None,
    Low,
    Medium,
    High,
}

impl Priority {
    /// Avanza a la siguiente prioridad de forma cíclica.
    pub fn cycle(self) -> Self {
        match self {
            Priority::None => Priority::Low,
            Priority::Low => Priority::Medium,
            Priority::Medium => Priority::High,
            Priority::High => Priority::None,
        }
    }

    /// Marca textual que se muestra junto a la tarea.
    pub fn marker(self) -> &'static str {
        match self {
            Priority::None => "",
            Priority::Low => "!",
            Priority::Medium => "!!",
            Priority::High => "!!!",
        }
    }
}

/// Cada cuánto se repite una tarea recurrente.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Recurrence {
    #[default]
    None,
    Daily,
    Weekly,
    Monthly,
}

impl Recurrence {
    /// Avanza al siguiente modo de recurrencia de forma cíclica.
    pub fn cycle(self) -> Self {
        match self {
            Recurrence::None => Recurrence::Daily,
            Recurrence::Daily => Recurrence::Weekly,
            Recurrence::Weekly => Recurrence::Monthly,
            Recurrence::Monthly => Recurrence::None,
        }
    }

    /// Etiqueta corta para mostrar junto a la tarea.
    pub fn label(self) -> &'static str {
        match self {
            Recurrence::None => "",
            Recurrence::Daily => "↻d",
            Recurrence::Weekly => "↻s",
            Recurrence::Monthly => "↻m",
        }
    }

    /// Calcula la siguiente fecha a partir de `from` según la recurrencia.
    pub fn next_date(self, from: NaiveDate) -> Option<NaiveDate> {
        match self {
            Recurrence::None => None,
            Recurrence::Daily => from.checked_add_signed(Duration::days(1)),
            Recurrence::Weekly => from.checked_add_signed(Duration::days(7)),
            Recurrence::Monthly => add_one_month(from),
        }
    }
}

/// Suma un mes a `date`, ajustando el día si el mes destino es más corto.
fn add_one_month(date: NaiveDate) -> Option<NaiveDate> {
    let (mut y, mut m) = (date.year(), date.month());
    if m == 12 {
        y += 1;
        m = 1;
    } else {
        m += 1;
    }
    let last = days_in_month(y, m);
    NaiveDate::from_ymd_opt(y, m, date.day().min(last))
}

/// Número de días que tiene un mes.
pub fn days_in_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let first_next = NaiveDate::from_ymd_opt(ny, nm, 1).unwrap();
    let first_this = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
    (first_next - first_this).num_days() as u32
}

/// Un paso/checklist dentro de un to-do.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subtask {
    pub title: String,
    pub done: bool,
}

impl Subtask {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            done: false,
        }
    }
}

/// Una tarea dentro de un proyecto.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Todo {
    pub title: String,
    pub done: bool,
    /// Día al que está asignada la tarea, si tiene uno.
    #[serde(default)]
    pub date: Option<NaiveDate>,
    /// Hora del día asignado, si la tiene (sólo con fecha).
    #[serde(default)]
    pub time: Option<NaiveTime>,
    /// Prioridad de la tarea.
    #[serde(default)]
    pub priority: Priority,
    /// Pasos/checklist de la tarea.
    #[serde(default)]
    pub subtasks: Vec<Subtask>,
    /// Etiquetas (sin el `#`), en minúsculas.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Repetición de la tarea.
    #[serde(default)]
    pub recurrence: Recurrence,
    /// Fecha en la que se completó por última vez (para estadísticas/racha).
    #[serde(default)]
    pub completed_at: Option<NaiveDate>,
    /// Id de la tarea en Todoist, si ya se exportó (para no duplicarla).
    #[serde(default)]
    pub todoist_id: Option<String>,
    /// Nombre del fichero de la imagen adjunta, en `<config_dir>/xietiao/images/`.
    #[serde(default)]
    pub image: Option<String>,
}

impl Todo {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            done: false,
            date: None,
            time: None,
            priority: Priority::None,
            subtasks: Vec::new(),
            tags: Vec::new(),
            recurrence: Recurrence::None,
            completed_at: None,
            todoist_id: None,
            image: None,
        }
    }

    /// Progreso de subtareas: (hechas, total). (0, 0) si no tiene.
    pub fn subtask_progress(&self) -> (usize, usize) {
        (self.subtasks.iter().filter(|s| s.done).count(), self.subtasks.len())
    }
}

/// Un proyecto con su lista de to-dos y sus notas asociadas.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    #[serde(default)]
    pub todos: Vec<Todo>,
    #[serde(default)]
    pub notes: String,
    /// Si está archivado, no aparece en la lista principal.
    #[serde(default)]
    pub archived: bool,
}

impl Project {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            todos: Vec::new(),
            notes: String::new(),
            archived: false,
        }
    }

    pub fn done_count(&self) -> usize {
        self.todos.iter().filter(|t| t.done).count()
    }
}

/// Qué tipo de elemento se guardó en la papelera.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TrashKind {
    /// Un proyecto entero (con sus to-dos y notas).
    Project(Project),
    /// Un to-do, recordando de qué proyecto venía (por nombre).
    Todo { project: String, todo: Todo },
}

/// Un elemento borrado, recuperable desde la papelera.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrashItem {
    pub kind: TrashKind,
    /// Marca de tiempo legible de cuándo se borró.
    #[serde(default)]
    pub deleted_at: Option<NaiveDate>,
}

impl TrashItem {
    /// Texto descriptivo para listar en la papelera.
    pub fn label(&self) -> String {
        match &self.kind {
            TrashKind::Project(p) => format!("Proyecto: {} ({} tareas)", p.name, p.todos.len()),
            TrashKind::Todo { project, todo } => format!("Tarea: {} ({})", todo.title, project),
        }
    }
}

/// Un foco de pomodoro completado.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PomodoroSession {
    pub date: NaiveDate,
    /// Proyecto en el que se trabajaba, si había uno.
    #[serde(default)]
    pub project: Option<String>,
    /// Tarea concreta, si estaba vinculada.
    #[serde(default)]
    pub todo: Option<String>,
}

/// Estado completo persistido en disco.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Store {
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub notes: String,
    /// Elementos borrados, recuperables.
    #[serde(default)]
    pub trash: Vec<TrashItem>,
    /// Historial de pomodoros completados.
    #[serde(default)]
    pub pomodoros: Vec<PomodoroSession>,
    /// Token de API de Todoist, si el usuario ha conectado su cuenta.
    #[serde(default)]
    pub todoist_token: Option<String>,
    /// Ids de Todoist de tareas borradas aquí, pendientes de borrarse allí
    /// en la próxima sincronización (y de no re-importarse mientras tanto).
    #[serde(default)]
    pub todoist_deleted: Vec<String>,
}

impl Store {
    /// Directorio base de configuración/datos: `<config_dir>/xietiao`.
    ///
    /// Se mantiene el nombre antiguo `xietiao` a propósito: es el mismo
    /// almacén que usa la versión TUI y el que ya contiene los datos del
    /// usuario; renombrarlo rompería ambas cosas.
    pub fn config_dir() -> PathBuf {
        let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join("xietiao")
    }

    /// Ruta del fichero de datos: `<config_dir>/xietiao/store.json`.
    pub fn data_path() -> PathBuf {
        Self::config_dir().join("store.json")
    }

    /// Carga el estado desde disco. Si no existe o está corrupto, devuelve uno vacío.
    pub fn load() -> Self {
        let path = Self::data_path();
        match fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    /// Guarda el estado en disco, creando el directorio si hace falta.
    pub fn save(&self) -> std::io::Result<()> {
        let path = Self::data_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        fs::write(path, json)
    }

    /// Cuántos pomodoros se han completado en una fecha dada.
    pub fn pomodoros_on(&self, date: NaiveDate) -> usize {
        self.pomodoros.iter().filter(|p| p.date == date).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn recurrence_daily_and_weekly() {
        assert_eq!(Recurrence::Daily.next_date(d(2026, 1, 1)), Some(d(2026, 1, 2)));
        assert_eq!(Recurrence::Weekly.next_date(d(2026, 1, 1)), Some(d(2026, 1, 8)));
        assert_eq!(Recurrence::None.next_date(d(2026, 1, 1)), None);
    }

    #[test]
    fn recurrence_monthly_clamps_day() {
        // 31 de enero + 1 mes → 28 de febrero (2026 no es bisiesto).
        assert_eq!(Recurrence::Monthly.next_date(d(2026, 1, 31)), Some(d(2026, 2, 28)));
        // Diciembre cruza de año.
        assert_eq!(Recurrence::Monthly.next_date(d(2026, 12, 15)), Some(d(2027, 1, 15)));
    }

    #[test]
    fn days_in_month_works() {
        assert_eq!(days_in_month(2026, 2), 28);
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2026, 4), 30);
    }

    #[test]
    fn subtask_progress_counts() {
        let mut t = Todo::new("x");
        t.subtasks.push(Subtask::new("a"));
        t.subtasks.push(Subtask::new("b"));
        t.subtasks[0].done = true;
        assert_eq!(t.subtask_progress(), (1, 2));
    }
}
