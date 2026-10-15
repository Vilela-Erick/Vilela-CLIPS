# Vilela CLIPS

Sistema local para analizar videos largos, detectar momentos destacables, generar clips verticales y preparar versiones de video optimizadas para publicación.

## Qué es

Vilela CLIPS es un pipeline local basado en Node.js, FFmpeg, Whisper mediante `whisper.cpp` y Codex CLI. Extrae audio, reutiliza una transcripción y ejecuta dos flujos sobre el video original. La dependencia de HyperFrames se usa actualmente para invocar la transcripción con Whisper; el render de los clips se hace con FFmpeg.

## Funciones actuales

### YouTube Cleaner

- Transcribe el audio y analiza posibles problemas de idoneidad.
- Genera `cuts.json` y un reporte en `work/`.
- Exporta una copia limpia en `output/` al ejecutar el comando de limpieza.

### Clip Generator

- Reutiliza la misma transcripción y analiza los momentos interesantes.
- Guarda candidatos y permite limitar la cantidad y la puntuación mínima.
- Crea videos verticales con una tarjeta de hook y branding.
- Mantiene caché de análisis, selección y render; puede continuar sin repetir MP4 válidos ya generados.

## Flujo general

```text
VIDEO
  ↓
AUDIO
  ↓
WHISPER
  ↓
TRANSCRIPCIÓN
  ├── YouTube Cleaner → copia limpia
  └── Clip Analyzer
          ↓
        FFmpeg
          ↓
        CLIPS
```

## Requisitos

- Windows es el entorno probado actualmente.
- Node.js 22 o posterior y npm (requisito de la versión fijada de HyperFrames).
- FFmpeg y `ffprobe` disponibles en `PATH`, con encoder `libx264`.
- Codex CLI instalado y autenticado.
- `whisper.cpp` / `whisper-cli` y acceso para descargar el modelo `small` la primera vez.
- Una fuente gruesa disponible: Arial Black o Segoe UI en Windows; DejaVu Sans Bold en Linux.

## Instalación

```powershell
git clone <REPOSITORY_URL>
cd Vilela-CLIPS
npm install
```

La URL se completará cuando exista el repositorio remoto. Comprueba que `node`, `ffmpeg`, `ffprobe` y `codex` funcionen desde la terminal. `npm install` instala HyperFrames y las dependencias Node; los binarios de FFmpeg y Whisper se instalan aparte.

## Configuración de Whisper

Instala `whisper.cpp` en la máquina nueva y deja `whisper-cli` en `PATH`, o descarga/compila una versión compatible y señala su ejecutable con `HYPERFRAMES_WHISPER_PATH`. En Windows, conserva las DLL requeridas junto al `.exe` o en `PATH`. El directorio `tools/whisper/` de una instalación local se ignora en Git: no forma parte del repositorio. HyperFrames descarga el modelo `small` al primer uso y lo guarda en la caché del usuario. El pipeline convierte antes el audio a WAV mono de 16 kHz.

PowerShell, para la sesión actual:

```powershell
$env:HYPERFRAMES_WHISPER_PATH = 'C:\ruta\a\whisper-cli.exe'
```

CMD, para la sesión actual:

```cmd
set "HYPERFRAMES_WHISPER_PATH=C:\ruta\a\whisper-cli.exe"
```

Si la conexión de Codex falla por un certificado raíz desconocido en un entorno que utiliza el almacén de certificados del sistema, puedes probar `NODE_OPTIONS=--use-system-ca` en esa sesión. No es un requisito general:

```powershell
$env:NODE_OPTIONS = '--use-system-ca'
```

```cmd
set "NODE_OPTIONS=--use-system-ca"
```

## Configuración de Codex

Instala Codex CLI, autentícalo con su flujo normal y verifica que puede ejecutarse. Si no se detecta automáticamente, define `CODEX_CLI_PATH` con la ruta completa al ejecutable. El pipeline usa un helper aislado de Codex en modo de solo lectura y no requiere MCP. No guardes credenciales en este proyecto.

## Estructura del proyecto

```text
scripts/       Pipeline, esquemas JSON y pruebas
assets/        JavaScript usado por la composición de index.html
index.html     Composición HyperFrames existente
cache/        Metadatos, transcripción, análisis y estado de render
input/        Videos de entrada del usuario
work/         Copias y reportes de YouTube Cleaner
output/       Videos limpios
clips/        Clips verticales finales
```

`cache/`, `input/`, `work/`, `output/` y `clips/` son datos locales y no se versionan. La composición HTML y sus archivos de `assets/` forman parte del proyecto, aunque los comandos del pipeline generan clips directamente con FFmpeg.

## Uso

Los ejemplos siguientes son para Windows. Coloca un video con audio en `input/` o indica otra ruta.

### Analizar idoneidad

```powershell
npm.cmd run analizar-youtube -- ".\input\video.mp4"
```

### Generar video limpio

```powershell
npm.cmd run limpiar-youtube -- ".\input\video.mp4"
```

### Analizar clips

```powershell
npm.cmd run analizar-clips -- ".\input\video.mp4"
```

### Generar clips

```powershell
npm.cmd run sacar-clips -- ".\input\video.mp4"
```

### Limitar cantidad

```powershell
npm.cmd run sacar-clips -- ".\input\video.mp4" --cantidad 10
```

### Calidad mínima

```powershell
npm.cmd run sacar-clips -- ".\input\video.mp4" --cantidad 10 --min-score 7
```

### Encoder

`--encoder auto` prueba los encoders disponibles con un fragmento real de cinco segundos y selecciona uno según velocidad y tamaño; si falla un encoder de hardware, reintenta con `libx264`.

```powershell
npm.cmd run sacar-clips -- ".\input\video.mp4" --encoder auto
```

## Qué genera

- `cache/`: índice de videos, metadatos, WAV y transcripción, revisión de idoneidad, candidatos, selección, reportes y estado de render. También guarda pruebas de encoder y registros de error.
- `work/`: copias del análisis y `cuts.json` del flujo YouTube Cleaner.
- `output/`: copias limpias exportadas.
- `clips/`: MP4 verticales finales.

## Caché

El sistema identifica el video por su contenido y reutiliza metadatos, transcripción, análisis, selección y estado de render cuando siguen siendo válidos. Cambiar `--cantidad` o `--min-score` recalcula la selección local. Eliminar `cache/` obliga a recalcular esos datos y puede repetir la transcripción y las llamadas a Codex. Los MP4 en `clips/` se conservan por separado.

## Diseño de clips

Los clips salen a 1080 × 1920, sobre fondo negro, con el video principal priorizado. El análisis de encuadre puede recortar zonas laterales decorativas cuando detecta que es seguro; si no, conserva el frame completo. Una tarjeta blanca con el hook aparece durante los primeros siete segundos y el branding permanece visible.

## Opciones CLI

| Opción | Comandos | Descripción |
| --- | --- | --- |
| `--cantidad N` | Analizar/generar clips | Máximo de clips seleccionados; entero positivo. Sin opción, no hay límite de cantidad. |
| `--min-score N` | Analizar/generar clips | Puntuación mínima de 0 a 10; valor por defecto: 7,5. |
| `--encoder auto\|libx264\|h264_amf\|h264_nvenc` | Analizar/generar clips | Encoder para el render; por defecto `auto`. |
| `--debug` | Analizar/generar clips | Muestra progreso adicional. |
| `--detect-sidebars` | Analizar/generar clips | Activa explícitamente la detección de bandas laterales, que ya está activada por defecto. |
| `--desde-transcript` | Analizar idoneidad | Reutiliza una transcripción y metadatos válidos ya presentes en `work/` y `cache/`. |

Las opciones de clips se aceptan también durante el análisis, aunque allí no se exportan videos. El comando de limpieza recibe la ruta del video y no procesa estas opciones de clips.

## Pruebas

```powershell
node --test scripts/*.test.mjs
```

La prueba opcional que llama a Codex real está desactivada salvo que se establezca `CODEX_LIVE_SMOKE=1`. Para validar la composición HyperFrames existente también se puede ejecutar `npm run check`.

## Solución de problemas

- **Whisper no encontrado:** comprueba `HYPERFRAMES_WHISPER_PATH`, `PATH`, las DLL junto al ejecutable y la descarga del modelo.
- **FFmpeg o ffprobe no encontrados:** instala ambos y abre una terminal nueva para actualizar `PATH`.
- **Codex no encontrado o no autenticado:** verifica su instalación y sesión; si hace falta, configura `CODEX_CLI_PATH`.
- **Caché obsoleta:** elimina solo la entrada del video afectado en `cache/` y vuelve a ejecutar el análisis; eso recalculará los datos.
- **Pocos candidatos:** revisa `cache/<sha256>/reporte-clips.txt`, la puntuación mínima y los cortes de idoneidad. Bajar `--min-score` puede seleccionar más candidatos existentes, pero no garantiza un número concreto.

Los detalles internos de la caché y el render están en [CLIPS.md](CLIPS.md).

## Estado del proyecto

En desarrollo activo. La experiencia documentada y probada actualmente es Windows.

## Licencia

La licencia todavía no ha sido definida.
