# Garita

*(antes «Xietiao Desktop»)*

Versión de escritorio de [Xietiao](https://github.com/Shikillo/Xietiao) (el dashboard TUI de productividad), construida con **Tauri 2** y una interfaz "papel y tinta" basada en [terminal.css](https://terminalcss.xyz/), que replica **la misma disposición de bloques que la versión de terminal**: proyectos y to-dos a la izquierda, calendario con la tira de relojes (pomodoro/reloj/cronómetro), notas y barra de progreso a la derecha, y línea de estado abajo.

<img width="1392" height="952" alt="Captura de pantalla 2026-07-12 a las 1 25 21" src="https://github.com/user-attachments/assets/a16fd53b-cd6d-45fe-bcbc-5e24e5e0b90f" />


## Qué incluye

- **Proyectos** — crear, renombrar, reordenar y borrar (a la papelera).
- **To-dos** — con `#tags`, prioridad cíclica (`!`, `!!`, `!!!`), recurrencia (diaria/semanal/mensual con regeneración automática al completar), fechas y horas (la agenda del día se ordena por hora), subtareas tabuladas bajo su tarea y búsqueda.
- **Calendario** — vista mensual con carga por día; la agenda de un día se abre como popup al clicarlo (si tiene tareas).
- **Notas** — generales o por proyecto, con autoguardado.
- **Pomodoro** — temporizador 25/5 con vinculación a tareas y registro de focos; reloj y cronómetro.
- **Imágenes** — cada to-do puede llevar una imagen adjunta (botón «imagen» o
  tecla `i`): se ve en un popup y en la lista aparece el indicador `▣`. Los
  ficheros se guardan reescalados como JPEG en `<config_dir>/xietiao/images/`
  (sólo local: la sincronización con Todoist no los envía).
- **Papelera** — restaurar o purgar proyectos y tareas borradas.
- **Menú de ajustes** — el cuadradito junto a la barra de progreso despliega en
  la esquina una bandeja de iconos (tema, estadísticas, todoist, sincronizar,
  escanear y papelera) que se queda abierta hasta volver a pulsarlo, sin
  oscurecer la pantalla. Los iconos viven en `src/assets/icons/` (SVG monocromo,
  estilo Streamline Pixel) y se tintan solos con el color de la tinta del tema.
- **Escanear papel** — el icono «escanear» del menú de ajustes captura con la
  cámara una lista escrita con casillas `- [ ]` y añade las líneas con casilla
  vacía como to-dos del proyecto seleccionado (las `- [x]` se ignoran), previa
  lista de confirmación editable. El OCR
  ([tesseract.js](https://tesseract.projectnaptha.com/), español) corre en local
  y sin conexión; funciona mejor con texto impreso que manuscrito.
- **Tema** — el icono «tema» del menú de ajustes abre un popup para elegir
  los dos colores de la interfaz (papel y tinta), con presets claro/oscuro y
  botón para intercambiarlos; los tonos intermedios se derivan solos y la
  elección se recuerda entre sesiones. Incluye dos efectos opcionales:
  **dither** (trama de puntos sobre toda la interfaz) e **impresión**
  (temblor de bordes y sangrado de tinta, como una fotocopia).
- **Estadísticas** — el icono «estadísticas» del menú de ajustes abre un
  resumen con las tareas y pomodoros de hoy y de los últimos 7 días (con
  gráfico de barras), la racha de días completando tareas y el progreso por
  proyecto.
- **Sonidos de interfaz** — un clic al navegar con `Tab`/flechas y otro al
  abrirse un diálogo. Se personalizan soltando `move.*` y `popup.*`
  (wav/mp3/ogg) en `src/assets/sounds/`; sin ficheros suena un clic
  sintetizado con WebAudio.
- **Todoist** — sincronización: las tareas pendientes se envían a Todoist
  (proyecto homónimo, fecha —con hora si la tiene—, prioridad y `#tags`), cada una una sola vez, y las
  que completes en Todoist se marcan como hechas también aquí (recurrencia
  incluida; borrarlas allí no las completa). Los cambios locales también se
  propagan: lo que borres aquí se borra allí al sincronizar (y no vuelve a
  importarse) y lo que completes aquí se cierra allí. Se lanza desde el icono
  «sincronizar» del menú de ajustes o desde el diálogo de Todoist; basta con
  pegar tu token de API (Todoist → Configuración → Integraciones → Desarrollador).
- **Atajos de teclado** — los mismos que la TUI (pulsa `?` dentro de la app para verlos): `Tab` cambia de panel, `j/k` navega, `a` añade, `d` borra, `Espacio` marca, `/` busca…

## Datos compartidos con la TUI

El backend reutiliza el `model.rs` de la versión TUI, así que ambas apps
leen y escriben el mismo fichero: `<config_dir>/xietiao/store.json`
(`~/Library/Application Support/xietiao/` en macOS, `~/.config/xietiao/` en Linux).
Puedes alternar entre la TUI y la app de escritorio con los mismos datos.

> Nota: si tienes ambas abiertas a la vez, la última en guardar gana.

> Nota: la integración con Todoist añade tres campos al modelo (`todoist_token`,
> `todoist_deleted` y el `todoist_id` de cada tarea), las imágenes adjuntas
> añaden otro (`image`) y las horas otro (`time`).
> La TUI incluye los de Todoist desde su versión 0.2.0; si usas una TUI que no
> conozca alguno de estos campos junto a esta app, al guardar los descartaría
> (perderías el token, se duplicarían tareas al re-exportar y las tareas
> olvidarían su imagen), así que actualízala.

## Arquitectura

- `src-tauri/` — backend Rust. El estado autoritativo (`Store`) vive aquí; cada
  acción del frontend invoca un *command* que muta, persiste y devuelve el estado.
- `src/` — frontend estático (HTML/CSS/JS vanilla, **sin Node ni bundler**).
  `terminal.css` y el motor de OCR (tesseract.js + core WASM + modelo español,
  en `src/assets/tesseract/`, ~9 MB) van vendorizados en `src/assets/` para que
  la app funcione sin red; el tema papel/tinta, el modo
  oscuro y los bloques estilo ratatui (título sobre el borde) están en `src/garita.css`.
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
> `hdiutil create -volname Garita -srcfolder <carpeta con la .app> -format UDZO salida.dmg`.

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
