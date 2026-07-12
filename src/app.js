// Garita de escritorio — frontend.
// El estado autoritativo vive en Rust: cada acción llama a un command de Tauri
// que devuelve el Store completo, y aquí sólo se re-pinta.

"use strict";

const invoke = window.__TAURI__.core.invoke;

// --- Estado de UI (no persistido) -------------------------------------------

let store = { projects: [], notes: "", trash: [], pomodoros: [] };

const ui = {
  project: 0,        // índice del proyecto seleccionado
  todo: null,        // índice real del to-do seleccionado dentro de project.todos
  search: "",
  notesScope: "general", // "general" | "project"
  calYear: 0,
  calMonth: 0,       // 1..12
  selDate: null,     // "YYYY-MM-DD"
  link: null,        // { project, todo } títulos vinculados al pomodoro
  focus: "projects", // panel con el foco del teclado
  clockSel: 0,       // reloj seleccionado en la tira (0 pomodoro, 1 reloj, 2 crono)
};

const PRIO_MARKER = { None: "", Low: "!", Medium: "!!", High: "!!!" };
const RECUR_LABEL = { None: "", Daily: "↻d", Weekly: "↻s", Monthly: "↻m" };
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const $ = (id) => document.getElementById(id);

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtShort(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}`;
}

function setStatus(msg) {
  $("statusbar").textContent = msg;
}

// --- Acceso al backend ---------------------------------------------------------

async function call(cmd, args = {}) {
  try {
    store = await invoke(cmd, args);
    clampSelection();
    renderAll();
  } catch (e) {
    setStatus(`Error: ${e}`);
  }
}

function clampSelection() {
  if (store.projects.length === 0) {
    ui.project = 0;
    ui.todo = null;
    return;
  }
  ui.project = Math.min(ui.project, store.projects.length - 1);
  const todos = store.projects[ui.project].todos;
  if (ui.todo !== null && ui.todo >= todos.length) {
    ui.todo = todos.length ? todos.length - 1 : null;
  }
}

function currentProject() {
  return store.projects[ui.project] ?? null;
}

function selectedTodo() {
  const p = currentProject();
  return p && ui.todo !== null ? p.todos[ui.todo] ?? null : null;
}

// --- Render ---------------------------------------------------------------------

function renderAll() {
  renderProjects();
  renderTodos();
  renderCalendar();
  renderNotes();
  renderClocks();
  renderProgress();
  renderPomodoroLink();
  renderFocus();
}

function renderProjects() {
  const list = $("project-list");
  list.innerHTML = "";
  store.projects.forEach((p, i) => {
    if (p.archived) return;
    const li = document.createElement("li");
    const done = p.todos.filter((t) => t.done).length;
    li.innerHTML = `<span class="todo-title"></span><span class="todo-meta">${done}/${p.todos.length}</span>`;
    li.querySelector(".todo-title").textContent = p.name;
    if (i === ui.project) li.classList.add("selected");
    li.addEventListener("click", () => {
      ui.project = i;
      ui.todo = null;
      renderAll();
    });
    list.appendChild(li);
  });
}

function todoMatchesSearch(t) {
  const q = ui.search.trim().toLowerCase();
  if (!q) return true;
  if (q.startsWith("#")) return t.tags.includes(q.slice(1));
  return t.title.toLowerCase().includes(q) || t.tags.some((tag) => tag.includes(q));
}

function renderTodos() {
  const p = currentProject();
  $("todos-title").textContent = p ? `to-dos · ${p.name}` : "to-dos";
  const list = $("todo-list");
  list.innerHTML = "";
  if (!p) return;

  p.todos.forEach((t, i) => {
    if (!todoMatchesSearch(t)) return;
    const li = document.createElement("li");
    li.classList.toggle("done", t.done);
    if (i === ui.todo) li.classList.add("selected");

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = t.done;
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      ui.todo = i;
      if (!t.done) playSound("complete"); // t.done aún es el estado previo
      call("toggle_todo", { project: ui.project, todo: i });
      setStatus(t.done ? "Tarea reabierta" : "Tarea completada");
    });

    const title = document.createElement("span");
    title.className = "todo-title";
    title.textContent = t.title + " ";
    for (const tag of t.tags) {
      const chip = document.createElement("span");
      chip.className = "tag";
      chip.textContent = `#${tag} `;
      title.appendChild(chip);
    }

    const meta = document.createElement("span");
    meta.className = "todo-meta";
    const bits = [];
    if (t.priority !== "None") bits.push(PRIO_MARKER[t.priority]);
    if (t.recurrence !== "None") bits.push(RECUR_LABEL[t.recurrence]);
    if (t.image) bits.push("▣");
    if (t.date) bits.push(fmtShort(t.date));
    if (t.time) bits.push(t.time.slice(0, 5));
    const [sd, st] = [t.subtasks.filter((s) => s.done).length, t.subtasks.length];
    if (st > 0) bits.push(`[${sd}/${st}]`);
    meta.textContent = bits.join(" ");

    li.append(check, title, meta);
    li.addEventListener("click", () => {
      ui.todo = i;
      renderAll();
    });
    li.addEventListener("dblclick", () => openEditTodo());
    list.appendChild(li);

    // Subtareas tabuladas bajo su tarea.
    t.subtasks.forEach((s, si) => {
      const sli = document.createElement("li");
      sli.className = "sub";
      sli.classList.toggle("done", s.done);
      const scheck = document.createElement("input");
      scheck.type = "checkbox";
      scheck.checked = s.done;
      scheck.addEventListener("click", (e) => {
        e.stopPropagation();
        ui.todo = i;
        if (!s.done) playSound("complete");
        call("toggle_subtask", { project: ui.project, todo: i, subtask: si });
      });
      const stitle = document.createElement("span");
      stitle.className = "todo-title";
      stitle.textContent = s.title;
      sli.append(scheck, stitle);
      // Clic en una subtarea selecciona la tarea madre.
      sli.addEventListener("click", () => {
        ui.todo = i;
        renderAll();
      });
      list.appendChild(sli);
    });
  });

  // Fecha y hora de los selectores reflejan la tarea seleccionada.
  const sel = selectedTodo();
  $("todo-date").value = sel?.date ?? "";
  $("todo-time").value = sel?.time?.slice(0, 5) ?? "";
}

function renderCalendar() {
  const y = ui.calYear, m = ui.calMonth;
  $("cal-title").textContent = `calendario · ${MONTHS[m - 1]} ${y}`;

  // Cuenta tareas por día del mes visible (todas: hechas tachadas en agenda).
  const pendingByDay = new Map();
  for (const p of store.projects) {
    for (const t of p.todos) {
      if (t.date && !t.done) {
        pendingByDay.set(t.date, (pendingByDay.get(t.date) ?? 0) + 1);
      }
    }
  }

  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const startCol = (first.getDay() + 6) % 7; // lunes = 0
  const today = todayStr();

  const table = $("cal-grid");
  table.innerHTML = "";
  const head = table.insertRow();
  for (const wd of ["L", "M", "X", "J", "V", "S", "D"]) {
    const th = document.createElement("th");
    th.textContent = wd;
    head.appendChild(th);
  }

  let row = table.insertRow();
  for (let i = 0; i < startCol; i++) row.insertCell().className = "empty";
  for (let day = 1; day <= daysInMonth; day++) {
    if (row.cells.length === 7) row = table.insertRow();
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const td = row.insertCell();
    td.innerHTML = `${day}<span class="count"></span>`;
    const n = pendingByDay.get(iso) ?? 0;
    td.querySelector(".count").textContent = n ? "•".repeat(Math.min(n, 4)) : " ";
    if (iso === today) td.classList.add("today");
    if (iso === ui.selDate) td.classList.add("selected");
    td.addEventListener("click", () => {
      ui.selDate = iso;
      renderCalendar();
      // La agenda es un popup, y sólo si el día tiene tareas.
      const any = store.projects.some((p) => p.todos.some((t) => t.date === iso));
      if (any) {
        renderAgenda();
        openDialog("dlg-agenda");
      }
    });
  }
  while (row.cells.length < 7) row.insertCell().className = "empty";
}

function renderAgenda() {
  const list = $("agenda-list");
  list.innerHTML = "";
  if (!ui.selDate) return;
  const [y, m, d] = ui.selDate.split("-");
  $("agenda-title").textContent = `agenda · ${d}/${m}/${y}`;
  const entries = [];
  store.projects.forEach((p, pi) => {
    p.todos.forEach((t, ti) => {
      if (t.date === ui.selDate) entries.push({ p, pi, t, ti });
    });
  });
  // Las tareas con hora primero, en orden; las sin hora, al final.
  entries.sort((a, b) => (a.t.time ?? "￿").localeCompare(b.t.time ?? "￿"));
  for (const { p, pi, t, ti } of entries) {
    const li = document.createElement("li");
    li.classList.toggle("done", t.done);
    const hh = t.time ? `${t.time.slice(0, 5)} · ` : "";
    li.textContent = `${hh}${PRIO_MARKER[t.priority]} ${t.title} — ${p.name}`.trim();
    li.addEventListener("click", () => {
      // Saltar a la tarea en su proyecto.
      closeDialogs();
      ui.project = pi;
      ui.todo = ti;
      ui.focus = "todos";
      renderAll();
    });
    list.appendChild(li);
  }
}

function renderNotes() {
  const p = currentProject();
  $("notes-project-label").textContent = p ? `de «${p.name}»` : "del proyecto";
  $("notes-project").disabled = !p;
  const scope = ui.notesScope === "project" && p ? "project" : "general";
  const text = scope === "project" ? p.notes : store.notes;
  const area = $("notes-text");
  if (document.activeElement !== area) area.value = text;
}

// Tira de relojes: subtítulo del pomodoro ("foco · N hoy") y hora actual.
function renderClocks() {
  const today = todayStr();
  const n = store.pomodoros.filter((s) => s.date === today).length;
  const base = timer.onBreak ? "break" : "foco";
  $("pomo-sub").textContent = `${base} · ${n} hoy`;
  $("clock-display").textContent =
    new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Barra de progreso del proyecto actual.
function renderProgress() {
  const p = currentProject();
  const done = p ? p.todos.filter((t) => t.done).length : 0;
  const total = p ? p.todos.length : 0;
  $("progress-title").textContent = total > 0
    ? `barra de progreso · ${done}/${total} (${Math.round((done / total) * 100)}%)`
    : "barra de progreso";
  $("progress-fill").style.width = total > 0 ? `${(done / total) * 100}%` : "0";
}

function renderPomodoroLink() {
  const el = $("timer-link");
  if (ui.link) {
    el.textContent = `Vinculado: ${ui.link.todo ?? ui.link.project}`;
  } else {
    const p = currentProject();
    el.textContent = p ? `Se registrará en «${p.name}»` : "";
  }
}

// --- Diálogos ---------------------------------------------------------------------

function openDialog(id) {
  playSound("popup");
  $("overlay").classList.remove("hidden");
  // Cancela cualquier cierre en curso y oculta el resto de diálogos.
  document.querySelectorAll(".dlg").forEach((d) => {
    d.classList.add("hidden");
    d.classList.remove("closing");
  });
  const dlg = $(id);
  dlg.classList.remove("hidden"); // al mostrarse, el CSS lo desliza hacia arriba
  // Si un focus() durante la animación provocó scroll (el diálogo entra desde
  // fuera de la vista), se corrige aquí para que no "bote" el contenido.
  dlg.scrollTop = 0;
  $("overlay").scrollTop = 0;
  dlg.addEventListener(
    "animationend",
    () => {
      dlg.scrollTop = 0;
      $("overlay").scrollTop = 0;
    },
    { once: true }
  );
}

function closeDialogs() {
  stopScanCamera(); // por si el diálogo abierto era el escáner
  const open = document.querySelector(".dlg:not(.hidden):not(.closing)");
  if (!open) {
    $("overlay").classList.add("hidden");
    return;
  }
  playSound("popup-close");
  // Desliza el diálogo hacia abajo y oculta al terminar la animación.
  open.classList.add("closing");
  // Sin animación (p. ej. prefers-reduced-motion): ocultar directamente.
  if (getComputedStyle(open).animationName === "none") {
    open.classList.remove("closing");
    open.classList.add("hidden");
    $("overlay").classList.add("hidden");
    return;
  }
  open.addEventListener(
    "animationend",
    () => {
      // Si mientras tanto se abrió otro diálogo, openDialog ya limpió esto.
      if (!open.classList.contains("closing")) return;
      open.classList.remove("closing");
      open.classList.add("hidden");
      if (!document.querySelector(".dlg:not(.hidden)")) {
        $("overlay").classList.add("hidden");
      }
    },
    { once: true }
  );
}

document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", closeDialogs));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDialogs();
});

/** Diálogo de texto genérico; llama a onOk(valor) al aceptar. */
function askText(title, initial, onOk) {
  $("input-title").textContent = title;
  const input = $("input-text");
  input.value = initial;
  openDialog("dlg-input");
  // preventScroll: enfocar durante la animación de entrada haría scroll
  // hacia el input (aún fuera de la vista) y el diálogo "botaría".
  input.focus({ preventScroll: true });
  input.select();
  const ok = () => {
    const v = input.value.trim();
    closeDialogs();
    if (v) onOk(v);
  };
  $("input-ok").onclick = ok;
  input.onkeydown = (e) => { if (e.key === "Enter") ok(); };
}

function askConfirm(message, onOk) {
  $("confirm-text").textContent = message;
  openDialog("dlg-confirm");
  $("confirm-ok").onclick = () => {
    closeDialogs();
    onOk();
  };
}

function showAlert(message) {
  $("alert-text").textContent = message;
  openDialog("dlg-alert");
}

// --- Subtareas -----------------------------------------------------------------------

function renderSubtasksDialog() {
  const t = selectedTodo();
  if (!t) return closeDialogs();
  $("subtasks-title").textContent = `Subtareas de «${t.title}»`;
  const list = $("subtask-list");
  list.innerHTML = "";
  t.subtasks.forEach((s, i) => {
    const li = document.createElement("li");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = s.done;
    check.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!s.done) playSound("complete");
      await call("toggle_subtask", { project: ui.project, todo: ui.todo, subtask: i });
      renderSubtasksDialog();
    });
    const title = document.createElement("span");
    title.className = "todo-title";
    title.textContent = s.title;
    if (s.done) li.classList.add("done");
    const del = document.createElement("button");
    del.className = "btn";
    del.textContent = "✕";
    del.addEventListener("click", async () => {
      await call("delete_subtask", { project: ui.project, todo: ui.todo, subtask: i });
      renderSubtasksDialog();
    });
    li.append(check, title, del);
    list.appendChild(li);
  });
}

$("todo-subtasks").addEventListener("click", () => {
  if (!selectedTodo()) return setStatus("No hay tarea seleccionada");
  renderSubtasksDialog();
  openDialog("dlg-subtasks");
  $("subtask-new").focus({ preventScroll: true });
});

async function addSubtask() {
  const input = $("subtask-new");
  const v = input.value.trim();
  if (!v || ui.todo === null) return;
  input.value = "";
  await call("add_subtask", { project: ui.project, todo: ui.todo, title: v });
  renderSubtasksDialog();
}
$("subtask-add").addEventListener("click", addSubtask);
$("subtask-new").addEventListener("keydown", (e) => { if (e.key === "Enter") addSubtask(); });

// --- Imagen adjunta del to-do ----------------------------------------------------------
//
// El fichero vive en <config_dir>/xietiao/images/ y el modelo guarda su nombre.
// Antes de enviarla al backend, la imagen se reescala (máx. 1600 px) y se
// codifica en JPEG, para que el store no engorde con fotos de cámara.

const IMAGE_MAX_SIDE = 1600;

function openImageDialog() {
  const t = selectedTodo();
  if (!t?.image) return;
  $("image-title").textContent = `imagen · ${t.title}`;
  const img = $("image-view");
  img.removeAttribute("src");
  invoke("get_todo_image", { name: t.image })
    .then((dataUrl) => { img.src = dataUrl; })
    .catch((e) => setStatus(`Error: ${e}`));
  openDialog("dlg-image");
}

/** Reescala y codifica en JPEG; devuelve el base64 (sin el prefijo data:). */
async function encodeImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // fondo para imágenes con transparencia
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
}

$("todo-image-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // permite volver a elegir el mismo fichero
  if (!file || ui.todo === null) return;
  setStatus("Guardando imagen…");
  try {
    const data = await encodeImage(file);
    await call("set_todo_image", { project: ui.project, todo: ui.todo, data });
    setStatus("Imagen guardada");
    openImageDialog();
  } catch (err) {
    setStatus(`Error: ${err.message ?? err}`);
  }
});

$("todo-image").addEventListener("click", () =>
  withSelectedTodo(() => {
    if (selectedTodo().image) openImageDialog();
    else $("todo-image-file").click();
  }));

$("image-change").addEventListener("click", () => $("todo-image-file").click());

$("image-remove").addEventListener("click", () =>
  withSelectedTodo(async () => {
    await call("clear_todo_image", { project: ui.project, todo: ui.todo });
    closeDialogs();
    setStatus("Imagen quitada");
  }));

// --- Papelera ------------------------------------------------------------------------

function renderTrashDialog() {
  const list = $("trash-list");
  list.innerHTML = "";
  if (store.trash.length === 0) {
    const li = document.createElement("li");
    li.className = "dimmed";
    li.textContent = "La papelera está vacía.";
    list.appendChild(li);
    return;
  }
  store.trash.forEach((item, i) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "todo-title";
    label.textContent = item.kind.Project
      ? `Proyecto: ${item.kind.Project.name} (${item.kind.Project.todos.length} tareas)`
      : `Tarea: ${item.kind.Todo.todo.title} (${item.kind.Todo.project})`;
    const btns = document.createElement("span");
    btns.className = "trash-item-buttons";
    const restore = document.createElement("button");
    restore.className = "btn";
    restore.textContent = "Restaurar";
    restore.addEventListener("click", async () => {
      await call("restore_trash", { item: i });
      renderTrashDialog();
      setStatus("Elemento restaurado");
    });
    const purge = document.createElement("button");
    purge.className = "btn";
    purge.textContent = "Eliminar";
    purge.addEventListener("click", async () => {
      await call("purge_trash", { item: i });
      playSound("delete");
      renderTrashDialog();
      setStatus("Elemento eliminado definitivamente");
    });
    btns.append(restore, purge);
    li.append(label, btns);
    list.appendChild(li);
  });
}

$("menu-trash").addEventListener("click", () => {
  renderTrashDialog();
  openDialog("dlg-trash");
});

// --- Estadísticas (calculadas del store: completed_at de tareas y pomodoros) ----------

/** Suma `delta` días a una fecha "YYYY-MM-DD". */
function isoAddDays(iso, delta) {
  const d = new Date(iso + "T00:00");
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

function renderStatsDialog() {
  const today = todayStr();

  // Tareas completadas por día. Limitación conocida: completed_at guarda solo
  // la última vez que se completó; reabrir una tarea borra su fecha.
  const doneByDay = new Map();
  let pending = 0;
  let doneTotal = 0;
  for (const p of store.projects) {
    for (const t of p.todos) {
      if (t.done) {
        doneTotal++;
        if (t.completed_at) doneByDay.set(t.completed_at, (doneByDay.get(t.completed_at) ?? 0) + 1);
      } else {
        pending++;
      }
    }
  }
  const pomosByDay = new Map();
  for (const s of store.pomodoros) {
    pomosByDay.set(s.date, (pomosByDay.get(s.date) ?? 0) + 1);
  }

  // Últimos 7 días, del más antiguo a hoy.
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const iso = isoAddDays(today, -i);
    week.push({ iso, done: doneByDay.get(iso) ?? 0, pomos: pomosByDay.get(iso) ?? 0 });
  }
  const weekDone = week.reduce((n, d) => n + d.done, 0);
  const weekPomos = week.reduce((n, d) => n + d.pomos, 0);

  // Racha: días seguidos con alguna tarea completada. Si hoy aún no hay
  // ninguna, la racha que terminó ayer sigue viva (queda día para sumarse).
  let streak = 0;
  let cursor = doneByDay.has(today) ? today : isoAddDays(today, -1);
  while (doneByDay.has(cursor)) {
    streak++;
    cursor = isoAddDays(cursor, -1);
  }

  const focusMin = weekPomos * 25;
  const focusTxt = focusMin >= 60 ? `${Math.floor(focusMin / 60)} h ${focusMin % 60} min` : `${focusMin} min`;

  const sum = $("stats-summary");
  sum.innerHTML = "";
  const addLine = (label, value) => {
    const b = document.createElement("b");
    b.textContent = label;
    const s = document.createElement("span");
    s.textContent = value;
    sum.append(b, s);
  };
  addLine("hoy", `${doneByDay.get(today) ?? 0} tareas · ${pomosByDay.get(today) ?? 0} pomodoros`);
  addLine("últimos 7 días", `${weekDone} tareas · ${weekPomos} pomodoros (${focusTxt} de foco)`);
  addLine("racha", streak > 0
    ? `${streak} ${streak === 1 ? "día" : "días"} seguidos completando tareas`
    : "sin racha — completa una tarea hoy");
  addLine("pendientes", `${pending} tareas (${doneTotal} completadas en total)`);

  // Barras de la semana, a escala del mejor día.
  const chart = $("stats-week");
  chart.innerHTML = "";
  const max = Math.max(1, ...week.map((d) => d.done));
  for (const d of week) {
    const row = document.createElement("div");
    row.className = "stat-row";
    if (d.iso === today) row.classList.add("today");
    const wd = WEEKDAYS[new Date(d.iso + "T00:00").getDay()];
    row.innerHTML = `<span class="stat-label">${wd} ${fmtShort(d.iso)}</span><div class="stat-track"><div class="stat-fill"></div></div><span class="stat-count">${d.done}</span>`;
    row.querySelector(".stat-fill").style.width = `${(d.done / max) * 100}%`;
    chart.appendChild(row);
  }

  // Progreso por proyecto (los archivados no se listan).
  const list = $("stats-projects");
  list.innerHTML = "";
  for (const p of store.projects) {
    if (p.archived) continue;
    const done = p.todos.filter((t) => t.done).length;
    const total = p.todos.length;
    const li = document.createElement("li");
    li.innerHTML = `<span class="todo-title"></span><div class="stat-track"><div class="stat-fill"></div></div><span class="stat-count"></span>`;
    li.querySelector(".todo-title").textContent = p.name;
    li.querySelector(".stat-fill").style.width = total ? `${(done / total) * 100}%` : "0";
    li.querySelector(".stat-count").textContent = `${done}/${total}`;
    list.appendChild(li);
  }
}

$("menu-stats").addEventListener("click", () => {
  renderStatsDialog();
  openDialog("dlg-stats");
});

// --- Todoist (envía pendientes y trae las completadas allí) ---------------------------

$("menu-todoist").addEventListener("click", () => {
  $("todoist-token").value = store.todoist_token ?? "";
  openDialog("dlg-todoist");
});

$("todoist-save").addEventListener("click", async () => {
  await call("set_todoist_token", { token: $("todoist-token").value });
  setStatus(store.todoist_token ? "Token de Todoist guardado" : "Token de Todoist borrado");
});

async function todoistSync() {
  const btn = $("todoist-export");
  btn.disabled = true;
  setStatus("Sincronizando con Todoist…");
  try {
    const res = await invoke("todoist_export");
    store = res.store;
    clampSelection();
    renderAll();
    const parts = [];
    if (res.exported > 0) parts.push(`${res.exported} enviadas a Todoist`);
    if (res.imported > 0) parts.push(`${res.imported} traídas de Todoist`);
    if (res.completed > 0) parts.push(`${res.completed} completadas desde Todoist`);
    if (res.deleted > 0) parts.push(`${res.deleted} borradas en Todoist`);
    if (res.closed > 0) parts.push(`${res.closed} cerradas en Todoist`);
    const summary = parts.length
      ? parts.join(", ")
      : `Nada nuevo (${res.skipped} ya estaban en Todoist)`;
    if (res.error) {
      setStatus(`Todoist: ${res.error} (${summary})`);
    } else {
      closeDialogs();
      playSound("sync-end");
      setStatus(summary);
    }
  } catch (e) {
    setStatus(`Error: ${e}`);
  } finally {
    btn.disabled = false;
  }
}

$("todoist-export").addEventListener("click", todoistSync);

// Sincronización directa desde la línea de estado; si aún no hay token,
// abre el diálogo de configuración.
$("menu-sync").addEventListener("click", () => {
  if (!store.todoist_token) {
    $("todoist-token").value = "";
    openDialog("dlg-todoist");
    setStatus("Configura primero tu token de Todoist");
  } else {
    todoistSync();
  }
});

// --- Escáner de papel (OCR local con tesseract.js) -------------------------------------
//
// Flujo: cámara → captura → OCR → líneas con casilla vacía «- [ ]» →
// lista de confirmación editable → add_todo al proyecto seleccionado.

const scan = { stream: null, worker: null };

// Rutas absolutas: el worker de tesseract resuelve las relativas contra sí mismo.
const TESS_BASE = new URL("assets/tesseract", location.href).href;

/** Motor de OCR: recibe un canvas y devuelve las líneas de texto detectadas.
 *  Desacoplado a propósito: para cambiar de motor (p. ej. una API de visión)
 *  basta con sustituir esta función. */
async function ocrLines(canvas) {
  if (!scan.worker) {
    scan.worker = await Tesseract.createWorker("spa", 1, {
      workerPath: `${TESS_BASE}/worker.min.js`,
      corePath: TESS_BASE, // elige solo el core (SIMD o no)
      langPath: TESS_BASE, // + /spa.traineddata.gz
    });
    await scan.worker.setParameters({
      tessedit_pageseg_mode: "4", // una columna de líneas: como una lista en papel
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
  }
  const { data } = await scan.worker.recognize(canvas);
  return data.lines?.map((l) => l.text) ?? data.text.split("\n");
}

/** Prepara la captura para el OCR: reescala hasta ~2400 px de ancho, pasa a
 *  escala de grises y estira el contraste entre los percentiles 5 y 95
 *  (el binarizado fino ya lo hace tesseract por dentro). */
function preprocessForOcr(source) {
  const scale = Math.min(2, Math.max(1, 2400 / source.width));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    const y = ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000) | 0;
    d[i] = y; // luma provisional en el canal R
    hist[y]++;
  }
  const total = d.length / 4;
  let lo = 0;
  let hi = 255;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total * 0.05) { lo = v; break; }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= total * 0.05) { hi = v; break; }
  }
  const range = Math.max(hi - lo, 1);
  for (let i = 0; i < d.length; i += 4) {
    const y = Math.min(255, Math.max(0, ((d[i] - lo) * 255) / range)) | 0;
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Casilla vacía al inicio de línea: «- [ ]», «[ ]», «( )» o un cuadrado
// que el OCR haya reconocido como tal. Las marcadas ([x], [✓]…) se ignoran.
// Tolerante con las confusiones típicas del OCR: «[ ]» puede llegar como
// «[]», «[_]», «( )», «{ }», «L]»… y el guión como distintos trazos.
const SCAN_EMPTY_BOX = /^\s*[-–—•*·]?\s*(?:[\[({L]\s*[_.\-]?\s*[\])}]|[□❑◻☐])\s*(.{2,})$/u;
const SCAN_DONE_BOX = /^\s*[-–—•*·]?\s*[\[\(]\s*[xX×✓✔]\s*[\]\)]/u;

function parseTodoLines(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || SCAN_DONE_BOX.test(line)) continue;
    const m = line.match(SCAN_EMPTY_BOX);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function setScanStatus(msg) {
  $("scan-status").textContent = msg;
}

function stopScanCamera() {
  scan.stream?.getTracks().forEach((t) => t.stop());
  scan.stream = null;
  $("scan-video").srcObject = null;
}

/** Deja el diálogo en su estado inicial (cámara visible, sin resultados). */
function resetScanDialog() {
  $("scan-video").classList.remove("hidden");
  $("scan-results").classList.add("hidden");
  $("scan-results").innerHTML = "";
  $("scan-capture").classList.remove("hidden");
  $("scan-add").classList.add("hidden");
  $("scan-retry").classList.add("hidden");
  setScanStatus("Arrancando la cámara…");
}

async function startScanCamera() {
  try {
    scan.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 } },
      audio: false,
    });
    $("scan-video").srcObject = scan.stream;
    setScanStatus("Encuadra la lista y pulsa «capturar».");
  } catch (e) {
    setScanStatus(`No se pudo abrir la cámara: ${e.message ?? e}`);
  }
}

$("menu-scan").addEventListener("click", () => {
  if (!currentProject()) {
    return setStatus("Crea o selecciona un proyecto antes de escanear");
  }
  resetScanDialog();
  openDialog("dlg-scan");
  startScanCamera();
});

$("scan-retry").addEventListener("click", () => {
  resetScanDialog();
  startScanCamera();
});

$("scan-capture").addEventListener("click", async () => {
  const video = $("scan-video");
  if (!video.videoWidth) return setScanStatus("La cámara aún no está lista.");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  stopScanCamera();
  video.classList.add("hidden");
  $("scan-capture").disabled = true;
  setScanStatus("Reconociendo texto… (la primera vez tarda unos segundos)");
  try {
    const lines = await ocrLines(preprocessForOcr(canvas));
    renderScanResults(parseTodoLines(lines), lines);
  } catch (e) {
    setScanStatus(`Error de OCR: ${e.message ?? e}`);
    $("scan-retry").classList.remove("hidden");
  } finally {
    $("scan-capture").disabled = false;
    $("scan-capture").classList.add("hidden");
  }
});

function renderScanResults(todos, rawLines = []) {
  const list = $("scan-results");
  list.innerHTML = "";
  list.classList.remove("hidden");
  $("scan-retry").classList.remove("hidden");
  if (todos.length === 0) {
    // Enseña lo que el OCR leyó de verdad: distingue «foto mala» (basura o
    // nada) de «filtro que no casa» (texto correcto sin casillas detectadas).
    const raw = rawLines.map((l) => l.trim()).filter(Boolean);
    setScanStatus(raw.length
      ? `Sin líneas «- [ ]». Leí: «${raw.join(" ⏎ ").slice(0, 220)}»`
      : "No se reconoció ningún texto. Más luz, más cerca y el papel sin inclinar.");
    return;
  }
  for (const t of todos) {
    const li = document.createElement("li");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = true;
    const input = document.createElement("input");
    input.type = "text";
    input.value = t;
    input.className = "scan-edit";
    li.append(check, input);
    list.appendChild(li);
  }
  $("scan-add").classList.remove("hidden");
  setScanStatus(`${todos.length} posibles to-dos. Desmarca o corrige antes de añadir.`);
}

$("scan-add").addEventListener("click", async () => {
  const p = currentProject();
  if (!p) return setStatus("No hay proyecto seleccionado");
  const titles = [...$("scan-results").querySelectorAll("li")]
    .filter((li) => li.querySelector("input[type=checkbox]").checked)
    .map((li) => li.querySelector("input[type=text]").value.trim())
    .filter(Boolean);
  for (const text of titles) {
    await call("add_todo", { project: ui.project, text });
  }
  closeDialogs();
  setStatus(titles.length
    ? `${titles.length} tareas añadidas desde papel a «${p.name}»`
    : "Nada que añadir");
});

// --- Bandeja de ajustes (los iconos de la esquina inferior) ---------------------------
//
// No es un diálogo: sin overlay ni oscurecido. Se abre con el botón de settings
// o con Alt; abierta con Alt, las flechas recorren los iconos (traySel marca
// cuál, en vídeo inverso), Enter lo activa y Alt/Escape la cierran.

let traySel = -1; // índice del icono seleccionado con teclado; -1 = sin selección

function trayBtns() {
  return Array.from(document.querySelectorAll("#settings-tray .tray-btn"));
}

function trayOpen() {
  return !$("settings-tray").classList.contains("hidden");
}

function renderTraySel() {
  trayBtns().forEach((b, i) => b.classList.toggle("selected", i === traySel));
}

function setTray(open, { keyboard = false } = {}) {
  if (open === trayOpen()) return;
  $("settings-tray").classList.toggle("hidden", !open);
  $("settings-btn").classList.toggle("active", open);
  playSound(open ? "settings-open" : "settings-close");
  traySel = open && keyboard ? 0 : -1;
  renderTraySel();
}

$("settings-btn").addEventListener("click", () => setTray(!trayOpen()));

// --- Drawer de documentos ---------------------------------------------------------------
//
// El botón de libros de la bandeja despliega un cajón que se superpone a la
// columna de relojes (pomodoro/reloj/cronómetro). Los ficheros (pdf, txt, md,
// imágenes) viven en <config_dir>/xietiao/docs/ y aquí solo se listan; al
// pulsar uno, un visor se desliza desde abajo cubriendo el bloque de notas.

const DOC_MIME = {
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

let docs = [];           // nombres de fichero, como los devuelve el backend
let docSel = -1;         // documento seleccionado con teclado; -1 = sin selección
let docViewerUrl = null; // blob URL del documento abierto (se revoca al cerrar)

function drawerOpen() {
  return !$("docs-drawer").classList.contains("hidden");
}

function setDrawer(open, { keyboard = false } = {}) {
  if (open === drawerOpen()) return;
  if (!open) closeDocViewer(); // el visor no sobrevive al cajón
  $("docs-drawer").classList.toggle("hidden", !open);
  playSound(open ? "settings-open" : "settings-close");
  docSel = open && keyboard ? 0 : -1;
  if (open) refreshDocs();
}

async function refreshDocs() {
  try {
    docs = await invoke("list_docs");
  } catch (e) {
    setStatus(`Error: ${e}`);
    docs = [];
  }
  renderDocs();
}

function renderDocs() {
  docSel = Math.min(docSel, docs.length - 1);
  const list = $("doc-list");
  list.innerHTML = "";
  if (docs.length === 0) {
    const li = document.createElement("li");
    li.className = "dimmed";
    li.textContent = "sin documentos";
    list.appendChild(li);
    return;
  }
  docs.forEach((name, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="todo-title"></span><button class="btn doc-del" title="borrar">✕</button>`;
    li.querySelector(".todo-title").textContent = name;
    li.title = name;
    if (i === docSel) li.classList.add("selected");
    li.addEventListener("click", () => {
      docSel = i;
      renderDocs();
      openDocViewer(name);
    });
    li.querySelector(".doc-del").addEventListener("click", (e) => {
      e.stopPropagation(); // que no abra el visor de paso
      askConfirm(`¿Borrar «${name}»? (definitivo, sin papelera)`, () => deleteDoc(name));
    });
    list.appendChild(li);
  });
}

async function deleteDoc(name) {
  try {
    docs = await invoke("delete_doc", { name });
    playSound("delete");
    setStatus(`«${name}» borrado`);
  } catch (e) {
    setStatus(`Error: ${e}`);
  }
  renderDocs();
}

$("menu-docs").addEventListener("click", () =>
  // Activado con Enter desde la bandeja (traySel >= 0), la selección de teclado
  // arranca en el primer documento, como al abrir la bandeja con Alt.
  setDrawer(!drawerOpen(), { keyboard: traySel >= 0 }));

$("doc-add").addEventListener("click", () => $("doc-file").click());

/** Base64 de un ArrayBuffer, por trozos (btoa no traga binarios grandes de golpe). */
function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

$("doc-file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = ""; // permite volver a elegir el mismo fichero
  if (!files.length) return;
  setStatus(files.length === 1 ? "Guardando documento…" : "Guardando documentos…");
  try {
    for (const f of files) {
      docs = await invoke("add_doc", { name: f.name, data: b64encode(await f.arrayBuffer()) });
    }
    playSound("add-edit");
    setStatus(files.length === 1
      ? `«${files[0].name}» guardado`
      : `${files.length} documentos guardados`);
  } catch (err) {
    setStatus(`Error: ${err}`);
  }
  renderDocs();
});

// El visor: iframe para pdf (el visor nativo del webview), <pre> para texto
// e <img> para imágenes. Solo uno de los tres es visible a la vez.

function viewerOpen() {
  return $("doc-viewer").classList.contains("open");
}

async function openDocViewer(name) {
  let b64;
  try {
    b64 = await invoke("get_doc", { name });
  } catch (e) {
    return setStatus(`Error: ${e}`);
  }
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (docViewerUrl) {
    URL.revokeObjectURL(docViewerUrl);
    docViewerUrl = null;
  }
  const frame = $("doc-view-frame"), text = $("doc-view-text"), img = $("doc-view-img");
  [frame, text, img].forEach((el) => el.classList.add("hidden"));
  frame.removeAttribute("src");
  img.removeAttribute("src");
  text.textContent = "";
  const ext = name.split(".").pop().toLowerCase();
  if (ext === "txt" || ext === "md") {
    text.textContent = new TextDecoder().decode(bytes);
    text.classList.remove("hidden");
  } else {
    docViewerUrl = URL.createObjectURL(new Blob([bytes], { type: DOC_MIME[ext] ?? "application/octet-stream" }));
    if (ext === "pdf") {
      frame.src = docViewerUrl;
      frame.classList.remove("hidden");
    } else {
      img.src = docViewerUrl;
      img.classList.remove("hidden");
    }
  }
  $("doc-view-title").textContent = name;
  if (!viewerOpen()) {
    $("doc-viewer").classList.add("open");
    playSound("popup");
  }
}

function closeDocViewer() {
  if (!viewerOpen()) return;
  $("doc-viewer").classList.remove("open");
  playSound("popup-close");
  // El contenido se limpia cuando el panel ya se ha deslizado fuera.
  setTimeout(() => {
    if (viewerOpen()) return; // se reabrió mientras tanto
    $("doc-view-frame").removeAttribute("src");
    $("doc-view-img").removeAttribute("src");
    $("doc-view-text").textContent = "";
    if (docViewerUrl) {
      URL.revokeObjectURL(docViewerUrl);
      docViewerUrl = null;
    }
  }, 300);
}

$("doc-view-close").addEventListener("click", closeDocViewer);

// --- Sonidos de interfaz ---------------------------------------------------------------
//
// Cada sonido lógico apunta a un fichero de assets/sounds/ (se prueban varios
// formatos, .flac incluido). Si el fichero no existe, los que tienen `synth`
// caen a un clic generado con WebAudio; el resto simplemente no suenan.

const SOUND_DEFS = {
  move:             { file: "move", volume: 0.35, synth: "move" },   // Tab/flechas/jk
  popup:            { file: "openpopup", volume: 0.5, synth: "popup" }, // abrir diálogo
  "popup-close":    { file: "closepopup", volume: 0.5 },             // cerrar diálogo
  "settings-open":  { file: "open_settings", volume: 0.5 },          // bandeja de ajustes
  "settings-close": { file: "close_settings", volume: 0.5 },
  "add-edit":       { file: "add-edit-todo-proyect", volume: 0.5 },  // crear/editar tarea o proyecto
  complete:         { file: "completetodo", volume: 0.5 },           // completar tarea o subtarea
  delete:           { file: "delete", volume: 0.5 },                 // enviar a papelera / purgar
  splash:           { file: "initialaniation", volume: 0.5 },        // animación de arranque
  "pomo-end":       { file: "endpomo", volume: 0.6, synth: "beep" }, // fin de pomodoro
  "sync-end":       { file: "syncend", volume: 0.5 },                // sincronización terminada
};

// Web Audio: cada fichero se descarga y decodifica UNA vez al arrancar y se
// reproduce desde memoria (AudioBufferSourceNode). Reproducir con <audio> +
// cloneNode creaba un reproductor nativo nuevo en cada pulsación y daba
// tirones y retardo, sobre todo con «move».

const sounds = {}; // por nombre: promesa que resuelve a AudioBuffer o "synth"

let audioCtx = null;

function getCtx() {
  audioCtx ??= new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

async function loadSound(name) {
  for (const ext of ["flac", "wav", "mp3", "ogg"]) {
    try {
      const res = await fetch(`assets/sounds/${SOUND_DEFS[name].file}.${ext}`);
      if (!res.ok) continue;
      return await getCtx().decodeAudioData(await res.arrayBuffer());
    } catch { /* formato ausente o no decodificable: prueba el siguiente */ }
  }
  return "synth";
}
Object.keys(SOUND_DEFS).forEach((n) => { sounds[n] = loadSound(n); });

/** Clic de repuesto generado con WebAudio (hasta que haya fichero de sonido). */
function synthSound(name) {
  try {
    const ctx = getCtx();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain).connect(ctx.destination);
    if (name === "move") {
      // Tic corto y seco, como una tecla.
      osc.type = "square";
      osc.frequency.value = 2200;
      gain.gain.setValueAtTime(0.03, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
      osc.start(t);
      osc.stop(t + 0.03);
    } else {
      // Pop suave de dos tonos al abrir un diálogo.
      osc.type = "sine";
      osc.frequency.setValueAtTime(520, t);
      osc.frequency.setValueAtTime(720, t + 0.07);
      gain.gain.setValueAtTime(0.05, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      osc.start(t);
      osc.stop(t + 0.16);
    }
  } catch { /* sin audio, no pasa nada */ }
}

function playSound(name) {
  // La promesa ya está resuelta salvo justo al arrancar; las reproducciones
  // rápidas se solapan solas (cada una es un BufferSource independiente).
  sounds[name].then((s) => {
    if (s === "synth") {
      const fallback = SOUND_DEFS[name].synth;
      if (fallback === "beep") beep();
      else if (fallback) synthSound(fallback);
      return;
    }
    const ctx = getCtx();
    const src = ctx.createBufferSource();
    src.buffer = s;
    const gain = ctx.createGain();
    gain.gain.value = SOUND_DEFS[name].volume;
    src.connect(gain).connect(ctx.destination);
    src.start();
  }).catch(() => {});
}

// --- Tema (colores de papel y tinta; se recuerda entre sesiones) ----------------------
//
// Todo el estilo cuelga de dos colores: --paper (fondo) y --ink (texto). Los
// tonos intermedios (--ink-dim, --ink-faint) se derivan mezclándolos, y la
// clase .dark del body (grano del fondo, sombras) se decide por la luminosidad
// del papel. Se aplican como estilo inline en <html> para pisar los del CSS.

const THEME_PRESETS = {
  claro: { paper: "#f6f1e5", ink: "#23211b" },
  oscuro: { paper: "#201e19", ink: "#e6e0d0" },
};

/** Mezcla dos colores "#rrggbb": t=1 devuelve `a`, t=0 devuelve `b`. */
function mixHex(a, b, t) {
  const pa = a.match(/\w\w/g).map((x) => parseInt(x, 16));
  const pb = b.match(/\w\w/g).map((x) => parseInt(x, 16));
  return "#" + pa.map((v, i) =>
    Math.round(v * t + pb[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
}

function isDarkColor(hex) {
  const [r, g, b] = hex.match(/\w\w/g).map((x) => parseInt(x, 16));
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

function applyTheme(theme) {
  const { paper, ink } = theme;
  const root = document.documentElement.style;
  root.setProperty("--paper", paper);
  root.setProperty("--ink", ink);
  root.setProperty("--ink-dim", mixHex(ink, paper, 0.5));
  root.setProperty("--ink-faint", mixHex(ink, paper, 0.2));
  document.body.classList.toggle("dark", isDarkColor(paper));
  localStorage.setItem("garita-theme", JSON.stringify(theme));
  $("theme-paper").value = paper;
  $("theme-ink").value = ink;
}

function loadTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem("garita-theme"));
    if (saved?.paper && saved?.ink) return saved;
  } catch { /* sin tema guardado */ }
  // Migración del antiguo interruptor de modo oscuro.
  return localStorage.getItem("garita-dark") === "1"
    ? THEME_PRESETS.oscuro
    : THEME_PRESETS.claro;
}

function themeFromInputs() {
  return { paper: $("theme-paper").value, ink: $("theme-ink").value };
}

$("menu-theme").addEventListener("click", () => openDialog("dlg-theme"));
$("theme-paper").addEventListener("input", () => applyTheme(themeFromInputs()));
$("theme-ink").addEventListener("input", () => applyTheme(themeFromInputs()));
$("theme-swap").addEventListener("click", () => {
  const t = themeFromInputs();
  applyTheme({ paper: t.ink, ink: t.paper });
});
$("theme-light").addEventListener("click", () => applyTheme(THEME_PRESETS.claro));
$("theme-dark").addEventListener("click", () => applyTheme(THEME_PRESETS.oscuro));
applyTheme(loadTheme());

// --- Efectos visuales (dither e impresión; se recuerdan entre sesiones) ----------------
//
// Cada efecto es una clase en <body>: .fx-dither superpone una trama de
// puntos (garita.css) y .fx-print aplica el filtro SVG #fx-print definido
// en index.html (temblor de bordes y sangrado de tinta).

function applyFx(fx) {
  document.body.classList.toggle("fx-dither", !!fx.dither);
  document.body.classList.toggle("fx-print", !!fx.print);
  localStorage.setItem("garita-fx", JSON.stringify(fx));
  $("fx-dither").checked = !!fx.dither;
  $("fx-print").checked = !!fx.print;
}

function loadFx() {
  try { return JSON.parse(localStorage.getItem("garita-fx")) ?? {}; }
  catch { return {}; }
}

function fxFromInputs() {
  return { dither: $("fx-dither").checked, print: $("fx-print").checked };
}

$("fx-dither").addEventListener("change", () => applyFx(fxFromInputs()));
$("fx-print").addEventListener("change", () => applyFx(fxFromInputs()));
applyFx(loadFx());

// --- Proyectos: acciones ------------------------------------------------------------

async function addProject() {
  const input = $("project-new");
  const v = input.value.trim();
  if (!v) return;
  input.value = "";
  await call("add_project", { name: v });
  playSound("add-edit");
  ui.project = store.projects.length - 1;
  ui.todo = null;
  renderAll();
  setStatus(`Proyecto «${v}» creado`);
}
$("project-add").addEventListener("click", addProject);
$("project-new").addEventListener("keydown", (e) => { if (e.key === "Enter") addProject(); });

$("project-rename").addEventListener("click", () => {
  const p = currentProject();
  if (!p) return;
  askText("Renombrar proyecto", p.name, async (v) => {
    await call("rename_project", { project: ui.project, name: v });
    playSound("add-edit");
  });
});

$("project-delete").addEventListener("click", () => {
  const p = currentProject();
  if (!p) return;
  askConfirm(`¿Enviar el proyecto «${p.name}» a la papelera?`, async () => {
    await call("delete_project", { project: ui.project });
    playSound("delete");
    setStatus("Proyecto enviado a la papelera");
  });
});

$("project-up").addEventListener("click", async () => {
  if (ui.project > 0) {
    const target = ui.project - 1;
    await call("move_project", { project: ui.project, delta: -1 });
    ui.project = target;
    renderAll();
  }
});
$("project-down").addEventListener("click", async () => {
  if (ui.project < store.projects.length - 1) {
    const target = ui.project + 1;
    await call("move_project", { project: ui.project, delta: 1 });
    ui.project = target;
    renderAll();
  }
});

// --- To-dos: acciones -----------------------------------------------------------------

async function addTodo() {
  const input = $("todo-new");
  const v = input.value.trim();
  if (!v || !currentProject()) return;
  input.value = "";
  await call("add_todo", { project: ui.project, text: v });
  playSound("add-edit");
  ui.todo = currentProject().todos.length - 1;
  renderAll();
  setStatus("Tarea añadida");
}
$("todo-new").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });

$("todo-search").addEventListener("input", (e) => {
  ui.search = e.target.value;
  renderTodos();
});

function withSelectedTodo(fn) {
  if (ui.todo === null || !selectedTodo()) {
    setStatus("No hay tarea seleccionada");
    return;
  }
  fn();
}

function openEditTodo() {
  withSelectedTodo(() => {
    const t = selectedTodo();
    const text = [t.title, ...t.tags.map((x) => `#${x}`)].join(" ");
    askText("Editar tarea", text, async (v) => {
      await call("edit_todo", { project: ui.project, todo: ui.todo, text: v });
      playSound("add-edit");
    });
  });
}
$("todo-edit").addEventListener("click", openEditTodo);

$("todo-priority").addEventListener("click", () =>
  withSelectedTodo(() => call("cycle_priority", { project: ui.project, todo: ui.todo })));

$("todo-recur").addEventListener("click", () =>
  withSelectedTodo(() => call("cycle_recurrence", { project: ui.project, todo: ui.todo })));

$("todo-date").addEventListener("change", (e) =>
  withSelectedTodo(() => {
    const v = e.target.value || null;
    call("set_todo_date", { project: ui.project, todo: ui.todo, date: v });
    setStatus(v ? `Tarea asignada a ${fmtShort(v)}` : "Fecha quitada de la tarea");
  }));

$("todo-time").addEventListener("change", (e) =>
  withSelectedTodo(() => {
    // NaiveTime espera segundos; el input da "HH:MM".
    const v = e.target.value ? `${e.target.value}:00` : null;
    call("set_todo_time", { project: ui.project, todo: ui.todo, time: v });
    setStatus(v ? `Hora puesta a las ${e.target.value}` : "Hora quitada de la tarea");
  }));

$("todo-nodate").addEventListener("click", () =>
  withSelectedTodo(() => {
    call("set_todo_date", { project: ui.project, todo: ui.todo, date: null });
    setStatus("Fecha quitada de la tarea");
  }));

$("todo-delete").addEventListener("click", () =>
  withSelectedTodo(() => {
    const t = selectedTodo();
    askConfirm(`¿Enviar la tarea «${t.title}» a la papelera?`, async () => {
      await call("delete_todo", { project: ui.project, todo: ui.todo });
      playSound("delete");
      setStatus("Tarea enviada a la papelera");
    });
  }));

$("todo-up").addEventListener("click", () =>
  withSelectedTodo(async () => {
    if (ui.todo > 0) {
      const target = ui.todo - 1;
      await call("move_todo", { project: ui.project, todo: ui.todo, delta: -1 });
      ui.todo = target;
      renderAll();
    }
  }));
$("todo-down").addEventListener("click", () =>
  withSelectedTodo(async () => {
    const len = currentProject().todos.length;
    if (ui.todo < len - 1) {
      const target = ui.todo + 1;
      await call("move_todo", { project: ui.project, todo: ui.todo, delta: 1 });
      ui.todo = target;
      renderAll();
    }
  }));

$("todo-move").addEventListener("click", () =>
  withSelectedTodo(() => {
    const list = $("move-list");
    list.innerHTML = "";
    store.projects.forEach((p, i) => {
      if (i === ui.project) return;
      const li = document.createElement("li");
      li.textContent = p.name;
      li.addEventListener("click", async () => {
        closeDialogs();
        await call("move_todo_to_project", { project: ui.project, todo: ui.todo, dest: i });
        ui.todo = null;
        renderAll();
        setStatus(`Tarea movida a «${p.name}»`);
      });
      list.appendChild(li);
    });
    openDialog("dlg-move");
  }));

// --- Calendario: acciones ----------------------------------------------------------

function shiftMonth(delta) {
  ui.calMonth += delta;
  if (ui.calMonth < 1) { ui.calMonth = 12; ui.calYear--; }
  if (ui.calMonth > 12) { ui.calMonth = 1; ui.calYear++; }
  renderCalendar();
}
$("cal-prev").addEventListener("click", () => shiftMonth(-1));
$("cal-next").addEventListener("click", () => shiftMonth(1));
$("cal-today").addEventListener("click", () => {
  const now = new Date();
  ui.calYear = now.getFullYear();
  ui.calMonth = now.getMonth() + 1;
  ui.selDate = todayStr();
  renderCalendar();
});

$("cal-assign").addEventListener("click", () =>
  withSelectedTodo(() => {
    if (!ui.selDate) return setStatus("Selecciona un día en el calendario");
    const t = selectedTodo();
    // Igual que en la TUI: asignar el mismo día dos veces quita la fecha.
    const next = t.date === ui.selDate ? null : ui.selDate;
    call("set_todo_date", { project: ui.project, todo: ui.todo, date: next });
    setStatus(next ? `Tarea asignada a ${fmtShort(next)}` : "Fecha quitada de la tarea");
  }));

// --- Notas ------------------------------------------------------------------------

let notesTimer = null;
$("notes-text").addEventListener("input", () => {
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => {
    const scope = ui.notesScope === "project" && currentProject() ? ui.project : null;
    call("set_notes", { project: scope, text: $("notes-text").value });
    setStatus("Notas guardadas");
  }, 600);
});
$("notes-general").addEventListener("change", () => { ui.notesScope = "general"; renderNotes(); });
$("notes-project").addEventListener("change", () => { ui.notesScope = "project"; renderNotes(); });

// --- Pomodoro ------------------------------------------------------------------------

const WORK = 25 * 60, BREAK = 5 * 60;
const timer = { running: false, remaining: WORK, preset: WORK, onBreak: false };
const stopwatch = { running: false, elapsed: 0 };

function fmtClock(secs) {
  if (secs >= 3600) {
    return `${String(Math.floor(secs / 3600)).padStart(2, "0")}:${String(Math.floor((secs % 3600) / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  }
  return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
}

function renderTimer() {
  const td = $("timer-display");
  td.textContent = fmtClock(timer.remaining);
  td.classList.toggle("running", timer.running);
  $("timer-toggle").textContent = timer.running ? "‖" : "▶";
  const sd = $("stopwatch-display");
  sd.textContent = fmtClock(stopwatch.elapsed);
  sd.classList.toggle("running", stopwatch.running);
  $("stopwatch-toggle").textContent = stopwatch.running ? "‖" : "▶";
  renderClocks();
}

function beep() {
  try {
    const ctx = getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.18);
    osc.stop(ctx.currentTime + 0.36);
  } catch { /* sin audio, no pasa nada */ }
}

async function timerFinished() {
  playSound("pomo-end"); // endpomo.flac; si faltara, cae al beep sintetizado
  if (!timer.onBreak) {
    const p = currentProject();
    const project = ui.link?.project ?? p?.name ?? null;
    const todo = ui.link?.todo ?? null;
    await call("record_pomodoro", { project, todo });
    showAlert("¡Foco completado! Tómate un descanso.");
  } else {
    showAlert("El descanso ha terminado. ¡A por otro foco!");
  }
}

setInterval(() => {
  if (timer.running) {
    timer.remaining--;
    if (timer.remaining <= 0) {
      timer.remaining = 0;
      timer.running = false;
      timerFinished();
    }
  }
  if (stopwatch.running) stopwatch.elapsed++;
  renderTimer();
}, 1000);

$("timer-toggle").addEventListener("click", () => {
  timer.running = !timer.running;
  renderTimer();
});
$("timer-reset").addEventListener("click", () => {
  timer.remaining = timer.preset;
  timer.running = false;
  renderTimer();
});
$("timer-mode-btn").addEventListener("click", () => {
  timer.onBreak = !timer.onBreak;
  timer.preset = timer.onBreak ? BREAK : WORK;
  timer.remaining = timer.preset;
  timer.running = false;
  renderTimer();
});
$("timer-link-btn").addEventListener("click", () => {
  const t = selectedTodo();
  const p = currentProject();
  if (t && p) {
    ui.link = { project: p.name, todo: t.title };
    setStatus(`Pomodoro vinculado a «${t.title}»`);
  } else {
    ui.link = null;
    setStatus("Pomodoro sin vincular");
  }
  renderPomodoroLink();
});

$("stopwatch-toggle").addEventListener("click", () => {
  stopwatch.running = !stopwatch.running;
  renderTimer();
});
$("stopwatch-reset").addEventListener("click", () => {
  stopwatch.elapsed = 0;
  stopwatch.running = false;
  renderTimer();
});

// --- Atajos de teclado (portados de la TUI) ------------------------------------------------

const FOCUS_ORDER = ["projects", "todos", "calendar", "clocks", "notes"];
const FOCUS_BLOCK = {
  projects: "blk-projects",
  todos: "blk-todos",
  calendar: "blk-calendar",
  notes: "blk-notes",
};

function renderFocus() {
  for (const [f, id] of Object.entries(FOCUS_BLOCK)) {
    $(id).classList.toggle("focused", ui.focus === f);
  }
  document.querySelectorAll("#clock-strip .clock").forEach((el, i) =>
    el.classList.toggle("focused", ui.focus === "clocks" && i === ui.clockSel));
}

// Clic en un panel también le da el foco.
for (const [f, id] of Object.entries(FOCUS_BLOCK)) {
  $(id).addEventListener("mousedown", () => { ui.focus = f; renderFocus(); });
}
document.querySelectorAll("#clock-strip .clock").forEach((el, i) =>
  el.addEventListener("mousedown", () => {
    ui.focus = "clocks";
    ui.clockSel = i;
    renderFocus();
  }));

/** Índices reales de los to-dos visibles con el filtro actual. */
function visibleTodoIndices() {
  const p = currentProject();
  if (!p) return [];
  return p.todos.reduce((out, t, i) => (todoMatchesSearch(t) && out.push(i), out), []);
}

/** Mueve el día seleccionado del calendario, siguiendo el mes visible. */
function moveCalCursor(days) {
  const base = ui.selDate ? new Date(ui.selDate + "T00:00") : new Date();
  base.setDate(base.getDate() + days);
  ui.selDate = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(base.getDate()).padStart(2, "0")}`;
  ui.calYear = base.getFullYear();
  ui.calMonth = base.getMonth() + 1;
  renderCalendar();
}

/** Navegación ↑↓/jk según el panel con foco. */
function moveSelection(delta) {
  if (ui.focus === "projects") {
    const len = store.projects.length;
    if (len === 0) return;
    ui.project = Math.min(Math.max(ui.project + delta, 0), len - 1);
    ui.todo = null;
    renderAll();
  } else if (ui.focus === "todos") {
    const vis = visibleTodoIndices();
    if (vis.length === 0) return;
    const pos = ui.todo === null ? -1 : vis.indexOf(ui.todo);
    const next = pos === -1 ? (delta > 0 ? 0 : vis.length - 1)
      : Math.min(Math.max(pos + delta, 0), vis.length - 1);
    ui.todo = vis[next];
    renderAll();
  } else if (ui.focus === "calendar") {
    moveCalCursor(delta * 7); // ± una semana, como en la TUI
  } else if (ui.focus === "clocks") {
    ui.clockSel = Math.min(Math.max(ui.clockSel + delta, 0), 2);
    renderFocus();
  }
}

document.addEventListener("keydown", (e) => {
  // Con un diálogo abierto: Enter acepta, y/n para la confirmación.
  if (!$("overlay").classList.contains("hidden")) {
    if (!$("dlg-confirm").classList.contains("hidden")) {
      if (e.key === "y" || e.key === "Enter") { e.preventDefault(); $("confirm-ok").click(); }
      else if (e.key === "n") closeDialogs();
    }
    return; // (Escape ya cierra desde el otro listener)
  }

  const el = document.activeElement;
  if (el && el.tagName === "BUTTON") el.blur();
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    if (e.key === "Escape") el.blur();
    return; // escribiendo: no interceptamos nada más
  }

  const k = e.key;
  const stop = () => e.preventDefault();

  // Alt abre/cierra la bandeja de ajustes; abierta con teclado, las flechas
  // (o j/k) recorren sus iconos, Enter/Espacio activa y Escape cierra.
  if (k === "Alt" && !e.repeat) {
    stop();
    setTray(!trayOpen(), { keyboard: true });
    return;
  }

  // Con el drawer de documentos abierto: flechas (o j/k) recorren la lista,
  // Enter abre el visor, d borra y Escape cierra (primero el visor, luego el
  // cajón). Va antes que la bandeja para quedarse con las flechas y el Enter.
  if (drawerOpen()) {
    switch (k) {
      case "ArrowUp": case "k": case "ArrowDown": case "j": {
        stop();
        if (!docs.length) return;
        const delta = k === "ArrowUp" || k === "k" ? -1 : 1;
        docSel = docSel < 0 ? 0 : (docSel + delta + docs.length) % docs.length;
        renderDocs();
        playSound("move");
        return;
      }
      case " ": case "Enter":
        stop();
        if (docSel >= 0 && docs[docSel]) openDocViewer(docs[docSel]);
        return;
      case "d":
        stop();
        if (docSel >= 0 && docs[docSel]) {
          const name = docs[docSel];
          askConfirm(`¿Borrar «${name}»? (definitivo, sin papelera)`, () => deleteDoc(name));
        }
        return;
      case "Escape":
        stop();
        if (viewerOpen()) closeDocViewer();
        else setDrawer(false);
        return;
      // Cualquier otra tecla sigue su curso normal con el cajón abierto.
    }
  }

  if (traySel >= 0 && trayOpen()) {
    const btns = trayBtns();
    switch (k) {
      case "ArrowUp": case "k":
        stop();
        traySel = (traySel + btns.length - 1) % btns.length;
        renderTraySel();
        playSound("move");
        return;
      case "ArrowDown": case "j":
        stop();
        traySel = (traySel + 1) % btns.length;
        renderTraySel();
        playSound("move");
        return;
      case " ": case "Enter":
        stop();
        btns[traySel].click();
        return;
      case "Escape":
        stop();
        setTray(false);
        return;
      // Cualquier otra tecla sigue su curso normal con la bandeja abierta.
    }
  }

  switch (k) {
    case "Tab": {
      stop();
      const i = FOCUS_ORDER.indexOf(ui.focus);
      const n = FOCUS_ORDER.length;
      ui.focus = FOCUS_ORDER[(i + (e.shiftKey ? n - 1 : 1)) % n];
      renderFocus();
      playSound("move");
      break;
    }
    case "ArrowUp": case "k": stop(); moveSelection(-1); playSound("move"); break;
    case "ArrowDown": case "j": stop(); moveSelection(1); playSound("move"); break;
    case "ArrowLeft": case "h":
      if (ui.focus === "calendar") { stop(); moveCalCursor(-1); playSound("move"); }
      break;
    case "ArrowRight": case "l":
      if (ui.focus === "calendar") { stop(); moveCalCursor(1); playSound("move"); }
      break;
    case "a": case "n":
      stop();
      if (ui.focus === "todos") $("todo-new").focus();
      else $("project-new").focus();
      break;
    case "e":
      stop();
      if (ui.focus === "projects") $("project-rename").click();
      else if (ui.focus === "todos") openEditTodo();
      else if (ui.focus === "notes") $("notes-text").focus();
      break;
    case "d":
      if (ui.focus === "projects") $("project-delete").click();
      else if (ui.focus === "todos") $("todo-delete").click();
      break;
    case " ": case "Enter":
      stop();
      if (ui.focus === "todos" && ui.todo !== null) {
        if (!selectedTodo()?.done) playSound("complete");
        call("toggle_todo", { project: ui.project, todo: ui.todo });
      } else if (ui.focus === "clocks") {
        if (ui.clockSel === 0) $("timer-toggle").click();
        else if (ui.clockSel === 2) $("stopwatch-toggle").click();
      } else if (ui.focus === "notes") {
        $("notes-text").focus();
      }
      break;
    case "f": $("cal-assign").click(); break;
    case "p": $("todo-priority").click(); break;
    case "c": $("todo-recur").click(); break;
    case "s": $("todo-subtasks").click(); break;
    case "i": $("todo-image").click(); break;
    case "m": $("todo-move").click(); break;
    case "v": $("timer-link-btn").click(); break;
    case "J":
      if (ui.focus === "projects") $("project-down").click();
      else if (ui.focus === "todos") $("todo-down").click();
      break;
    case "K":
      if (ui.focus === "projects") $("project-up").click();
      else if (ui.focus === "todos") $("todo-up").click();
      break;
    case "/": stop(); $("todo-search").focus(); break;
    case "g":
      ui.notesScope = ui.notesScope === "general" ? "project" : "general";
      $(ui.notesScope === "general" ? "notes-general" : "notes-project").checked = true;
      renderNotes();
      break;
    case "t": $("cal-today").click(); break;
    case "x": $("menu-trash").click(); break;
    case "r":
      if (ui.focus === "clocks") {
        if (ui.clockSel === 0) $("timer-reset").click();
        else if (ui.clockSel === 2) $("stopwatch-reset").click();
      }
      break;
    case "b":
      if (ui.focus === "clocks") $("timer-mode-btn").click();
      break;
    case "u": setStatus("Deshacer no está disponible en la versión de escritorio"); break;
    case "?": openDialog("dlg-help"); break;
    case "q": invoke("quit_app"); break;
    case "Escape":
      if (ui.search) {
        ui.search = "";
        $("todo-search").value = "";
        renderTodos();
        setStatus("Filtro quitado");
      }
      break;
  }
});

// --- Splash de arranque (logo ASCII revelado de abajo arriba) ---------------------------

const SPLASH_ART = ` ░███████ ░██   ░██          ░██    ░██ ░███████ ░███████
░██       ░██  ░██            ░██  ░██     ░██      ░██
 ░██████  ░█████     ░██████   ░█████      ░██      ░██
      ░██ ░██  ░██            ░██  ░██     ░██      ░██
░███████  ░██   ░██          ░██    ░██ ░███████ ░███████`;

let splashActive = true;         // true mientras el splash sigue en pantalla
let splashDismissTimers = [];    // temporizadores de auto-cierre (cancelables)

function dismissSplash() {
  const splash = $("splash");
  if (!splash || !splashActive) return;
  splashActive = false;
  splashDismissTimers.forEach(clearTimeout);
  splashDismissTimers = [];
  splash.classList.add("done"); // fundido de salida (transition en CSS)
  splash.addEventListener("transitionend", () => splash.remove(), { once: true });
  setTimeout(() => splash.remove(), 700); // red de seguridad si no hay transición
}

function runSplash() {
  playSound("splash");
  const pre = $("splash-art");
  const lines = SPLASH_ART.split("\n");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const step = 90; // ms entre filas

  lines.forEach((text, i) => {
    const row = document.createElement("div");
    row.textContent = text || " ";
    if (!reduce) {
      row.classList.add("splash-line");
      // La fila de abajo se enciende primero; la de arriba, la última.
      row.style.animationDelay = `${(lines.length - 1 - i) * step}ms`;
    }
    pre.appendChild(row);
  });

  const total = reduce ? 400 : (lines.length - 1) * step + 250 + 400; // revelado + pausa
  splashDismissTimers.push(setTimeout(dismissSplash, total));

  initRefreshGesture();
}

// --- Gesto de reinicio: mantén Shift+R durante 3 s para sincronizar y reiniciar --------
//
// Funciona en cualquier momento. Si es durante el splash, lo "congela" mientras
// carga; con la app abierta muestra una barra flotante abajo. Al completar los 3 s,
// sincroniza con Todoist (trae lo metido desde otros dispositivos) y reinicia la app
// (recarga y repinta la animación de arranque). Si se suelta antes, se cancela. Se
// ignora mientras escribes en un campo; y tras reiniciar no se re-arma la barra hasta
// soltar la tecla (así no aparece una segunda barra con la tecla aún pulsada).

const REFRESH_HOLD_MS = 3000;

function initRefreshGesture() {
  let charging = false;
  let armed = true;   // false tras completar: no re-arma hasta soltar la tecla
  let startTs = 0;
  let rafId = 0;
  let fill = null;
  let label = null;

  // Si acabamos de reiniciar por el gesto, arranca desarmado: no debe empezar
  // otra barra hasta que se suelte la tecla (y luego se vuelva a pulsar).
  try {
    if (sessionStorage.getItem("gestureReload")) {
      armed = false;
      sessionStorage.removeItem("gestureReload");
    }
  } catch (_) {}

  function buildUI() {
    // Durante el splash la barra va dentro de él; si no, flota sobre la app.
    const host = (splashActive && $("splash")) ? $("splash") : document.body;
    const box = document.createElement("div");
    box.id = "splash-refresh";
    if (host === document.body) box.classList.add("floating");
    label = document.createElement("div");
    label.id = "splash-refresh-label";
    label.textContent = "recargando…";
    const track = document.createElement("div");
    track.id = "splash-refresh-track";
    fill = document.createElement("div");
    fill.id = "splash-refresh-fill";
    track.appendChild(fill);
    box.appendChild(label);
    box.appendChild(track);
    host.appendChild(box);
  }

  function stopCharge() {
    charging = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    const box = $("splash-refresh");
    if (box) box.remove();
    fill = label = null;
  }

  function tick() {
    const pct = Math.min(100, ((Date.now() - startTs) / REFRESH_HOLD_MS) * 100);
    if (fill) fill.style.width = `${pct}%`;
    if (pct >= 100) { doRefresh(); return; }
    rafId = requestAnimationFrame(tick);
  }

  async function doRefresh() {
    charging = false;
    armed = false; // no volver a cargar hasta que se suelte la tecla
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (fill) fill.style.width = "100%";
    if (label) label.textContent = store.todoist_token ? "sincronizando…" : "reiniciando…";
    try {
      // Sincroniza con Todoist antes de reiniciar (persiste en el backend);
      // al recargar, el arranque relee el estado ya actualizado.
      if (store.todoist_token) await invoke("todoist_export");
    } catch (_) {
      // Reiniciamos igualmente aunque la sincronización falle.
    }
    // Marca que la recarga viene del gesto: al volver a arrancar no se re-arma
    // la barra mientras la tecla siga pulsada (evita una segunda barra).
    try { sessionStorage.setItem("gestureReload", "1"); } catch (_) {}
    location.reload(); // reinicia la app y repinta la animación de arranque
  }

  function onKeyDown(e) {
    if (e.code !== "KeyR" || !e.shiftKey) return;
    if (charging || !armed || e.repeat) return;
    // No secuestres la tecla si se está escribiendo en un campo de texto.
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
    e.preventDefault();
    e.stopPropagation(); // evita otros atajos con la misma tecla
    charging = true;
    startTs = Date.now();
    if (splashActive) {
      // Congela el splash: cancela su cierre automático mientras se carga.
      splashDismissTimers.forEach(clearTimeout);
      splashDismissTimers = [];
    }
    buildUI();
    rafId = requestAnimationFrame(tick);
  }

  function onKeyUp(e) {
    if (e.code !== "KeyR" && e.key !== "Shift") return;
    armed = true; // soltó la tecla: ya se puede volver a cargar
    if (charging) {
      stopCharge();
      if (splashActive) dismissSplash(); // el splash ya cumplió su tiempo: ciérralo
    }
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
}

runSplash();

// --- Arranque ----------------------------------------------------------------------------

(async function init() {
  const now = new Date();
  ui.calYear = now.getFullYear();
  ui.calMonth = now.getMonth() + 1;
  ui.selDate = todayStr();
  await call("get_store");
  renderTimer();
  setStatus("Listo.");
})();
