// Xietiao de escritorio — frontend.
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
    if (t.date) bits.push(fmtShort(t.date));
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

  // La fecha del selector refleja la tarea seleccionada.
  const sel = selectedTodo();
  $("todo-date").value = sel?.date ?? "";
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
  store.projects.forEach((p, pi) => {
    p.todos.forEach((t, ti) => {
      if (t.date !== ui.selDate) return;
      const li = document.createElement("li");
      li.classList.toggle("done", t.done);
      li.textContent = `${PRIO_MARKER[t.priority]} ${t.title} — ${p.name}`.trim();
      li.addEventListener("click", () => {
        // Saltar a la tarea en su proyecto.
        closeDialogs();
        ui.project = pi;
        ui.todo = ti;
        ui.focus = "todos";
        renderAll();
      });
      list.appendChild(li);
    });
  });
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
  $("overlay").classList.remove("hidden");
  document.querySelectorAll(".dlg").forEach((d) => d.classList.add("hidden"));
  $(id).classList.remove("hidden");
}

function closeDialogs() {
  $("overlay").classList.add("hidden");
  document.querySelectorAll(".dlg").forEach((d) => d.classList.add("hidden"));
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
  input.focus();
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
  $("subtask-new").focus();
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

// --- Modo oscuro (tinta clara sobre papel oscuro; se recuerda entre sesiones) ---------

function applyDark(on) {
  document.body.classList.toggle("dark", on);
  $("menu-dark").textContent = on ? "modo-claro" : "modo-oscuro";
  localStorage.setItem("xietiao-dark", on ? "1" : "0");
}
$("menu-dark").addEventListener("click", () =>
  applyDark(!document.body.classList.contains("dark")));
applyDark(localStorage.getItem("xietiao-dark") === "1");

// --- Proyectos: acciones ------------------------------------------------------------

async function addProject() {
  const input = $("project-new");
  const v = input.value.trim();
  if (!v) return;
  input.value = "";
  await call("add_project", { name: v });
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
  askText("Renombrar proyecto", p.name, (v) =>
    call("rename_project", { project: ui.project, name: v }));
});

$("project-delete").addEventListener("click", () => {
  const p = currentProject();
  if (!p) return;
  askConfirm(`¿Enviar el proyecto «${p.name}» a la papelera?`, async () => {
    await call("delete_project", { project: ui.project });
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
    askText("Editar tarea", text, (v) =>
      call("edit_todo", { project: ui.project, todo: ui.todo, text: v }));
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
    const ctx = new AudioContext();
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
  beep();
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

  switch (k) {
    case "Tab": {
      stop();
      const i = FOCUS_ORDER.indexOf(ui.focus);
      const n = FOCUS_ORDER.length;
      ui.focus = FOCUS_ORDER[(i + (e.shiftKey ? n - 1 : 1)) % n];
      renderFocus();
      break;
    }
    case "ArrowUp": case "k": stop(); moveSelection(-1); break;
    case "ArrowDown": case "j": stop(); moveSelection(1); break;
    case "ArrowLeft": case "h":
      if (ui.focus === "calendar") { stop(); moveCalCursor(-1); }
      break;
    case "ArrowRight": case "l":
      if (ui.focus === "calendar") { stop(); moveCalCursor(1); }
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
    case "R": $("todo-recur").click(); break;
    case "s": $("todo-subtasks").click(); break;
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
