# Xietiao Desktop

Versión de escritorio de [Xietiao](https://github.com/Shikillo/Xietiao) (el dashboard TUI de productividad), construida con **Tauri 2** y una interfaz "papel y tinta" basada en [terminal.css](https://terminalcss.xyz/), que replica **la misma disposición de bloques que la versión de terminal**: proyectos y to-dos a la izquierda, calendario con la tira de relojes (pomodoro/reloj/cronómetro), notas y barra de progreso a la derecha, y línea de estado abajo.

<img width="1392" height="952" alt="xie" src="https://github.com/user-attachments/assets/8c66b441-102c-4de4-be80-ff3af04eb8bc" />

## Qué incluye

- **Proyectos** — crear, renombrar, reordenar y borrar (a la papelera).
- **To-dos** — con `#tags`, prioridad cíclica (`!`, `!!`, `!!!`), recurrencia (diaria/semanal/mensual con regeneración automática al completar), fechas, subtareas tabuladas bajo su tarea y búsqueda.
- **Calendario** — vista mensual con carga por día; la agenda de un día se abre como popup al clicarlo (si tiene tareas).
- **Notas** — generales o por proyecto, con autoguardado.
- **Pomodoro** — temporizador 25/5 con vinculación a tareas y registro de focos; reloj y cronómetro.
- **Papelera** — restaurar o purgar proyectos y tareas borradas.
- **Escanear papel** — el enlace «escanear» de la línea de estado captura con la
  cámara una lista escrita con casillas `- [ ]` y añade las líneas con casilla
  vacía como to-dos del proyecto seleccionado (las `- [x]` se ignoran), previa
  lista de confirmación editable. El OCR
  ([tesseract.js](https://tesseract.projectnaptha.com/), español) corre en local
  y sin conexión; funciona mejor con texto impreso que manuscrito.
- **Modo oscuro** — tinta clara sobre papel oscuro, se recuerda entre sesiones.
- **Todoist** — sincronización: las tareas pendientes se envían a Todoist
  (proyecto homónimo, fecha, prioridad y `#tags`), cada una una sola vez, y las
  que completes en Todoist se marcan como hechas también aquí (recurrencia
  incluida; borrarlas allí no las completa). Se lanza desde el enlace
  «sincronizar» de la línea de estado o desde el diálogo de Todoist; basta con
  pegar tu token de API (Todoist → Configuración → Integraciones → Desarrollador).
- **Atajos de teclado** — los mismos que la TUI (pulsa `?` dentro de la app para verlos): `Tab` cambia de panel, `j/k` navega, `a` añade, `d` borra, `Espacio` marca, `/` busca…

## Datos compartidos con la TUI

El backend reutiliza el `model.rs` de la versión TUI, así que ambas apps
leen y escriben el mismo fichero: `<config_dir>/xietiao/store.json`
(`~/Library/Application Support/xietiao/` en macOS, `~/.config/xietiao/` en Linux).
Puedes alternar entre la TUI y la app de escritorio con los mismos datos.

> Nota: si tienes ambas abiertas a la vez, la última en guardar gana.

> Nota: la integración con Todoist añade dos campos al modelo (`todoist_token` y
> el `todoist_id` de cada tarea). La TUI los incluye desde su versión 0.2.0; si
> usas una TUI anterior junto a esta app, al guardar los descartaría (perderías
> el token y se duplicarían tareas al re-exportar), así que actualízala.

## Arquitectura

- `src-tauri/` — backend Rust. El estado autoritativo (`Store`) vive aquí; cada
  acción del frontend invoca un *command* que muta, persiste y devuelve el estado.
- `src/` — frontend estático (HTML/CSS/JS vanilla, **sin Node ni bundler**).
  `terminal.css` y el motor de OCR (tesseract.js + core WASM + modelo español,
  en `src/assets/tesseract/`, ~9 MB) van vendorizados en `src/assets/` para que
  la app funcione sin red; el tema papel/tinta, el modo
  oscuro y los bloques estilo ratatui (título sobre el borde) están en `src/xietiao.css`.
- `src-tauri/icons/` — icono de la app; `icon.svg` es la fuente y de él salen
  `icon.icns` (macOS), `icon.ico` (Windows) y los PNG (Linux).

## Ejecutar en desarrollo

```sh
cd src-tauri
cargo run
```

No hace falta `npm` ni la CLI de Tauri: el frontend es estático y se sirve
directamente desde `src/`.

## Empaquetar

```sh
cargo install tauri-cli --locked   # sólo la primera vez
cd src-tauri
cargo tauri build
```

Los instaladores quedan en `src-tauri/target/release/bundle/`
(`.app`/`.dmg` en macOS, `.msi`/`.exe` en Windows, `.deb`/`.rpm`/`.AppImage` en Linux).
Cada sistema genera sólo los suyos: Tauri no cross-compila.

> Si el paso del `.dmg` falla en local (usa AppleScript para decorar la ventana),
> el `.app` ya está bien; el DMG puede montarse a mano con
> `hdiutil create -volname Xietiao -srcfolder <carpeta con la .app> -format UDZO salida.dmg`.

## Releases automáticas

El workflow [`release.yml`](.github/workflows/release.yml) compila los
instaladores de **macOS (Apple Silicon e Intel), Windows y Linux** y los adjunta
a la release al empujar un tag:

```sh
git tag v0.2.0
git push origin v0.2.0
```

También puede lanzarse a mano desde la pestaña Actions (deja los bundles como artefactos).

## Licencia

MIT.

## Créditos

- Desarrollado por [Shikillo](https://github.com/Shikillo) con la ayuda de Claude (Anthropic).
- Estilo base de la interfaz: [terminal.css](https://terminalcss.xyz/) de Jonas Duri.
- Icono: [Streamline Pixel](https://streamlinehq.com).
