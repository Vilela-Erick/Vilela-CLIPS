# Contexto del proyecto: Vilela CLIPS

## Propósito y tecnologías

Pipeline local para analizar videos largos, detectar momentos destacables, exportar clips verticales y generar una versión limpia para publicación. El código es JavaScript ESM sobre Node.js; usa FFmpeg/ffprobe para medios, `sharp` para gráficos, Codex CLI para análisis estructurado y HyperFrames para llamar a Whisper/whisper.cpp durante la transcripción. Windows es el entorno probado. `index.html` es una composición HyperFrames existente; los comandos del pipeline renderizan sus videos con FFmpeg.

## Entradas y arquitectura

- `package.json` define los comandos. `scripts/limpiar-youtube.mjs` inicia el análisis de idoneidad o la exportación limpia; `scripts/sacar-clips.mjs` inicia el análisis o render de clips.
- Ambos flujos comparten `scripts/pipeline-cache.mjs`: identifica el video, obtiene metadatos con ffprobe, extrae audio, transcribe mediante HyperFrames/Whisper y reutiliza la transcripción. `scripts/transcript-quality.mjs` detecta repeticiones problemáticas para el reintento por tramos.
- `scripts/pipeline-analysis.mjs` llama a `scripts/pipeline-codex.mjs` para la revisión de idoneidad y el descubrimiento de candidatos. Valida respuestas con los esquemas JSON y usa `scripts/youtube-core.mjs`, `scripts/clips-core.mjs` y `scripts/clips-cut-validation.mjs` para cortes y selección.
- `scripts/framing/` muestrea cinco frames por clip, detecta rostros con YuNet y personas con MediaPipe Pose/ONNX Runtime CPU, delimita contenido horizontal incrustado, clasifica contenido, genera y puntúa estrategias, guarda decisiones por versión y construye el filtro FFmpeg o un PNG de preview. Reutiliza `scripts/layout-detection.mjs` para paneles laterales. `scripts/pipeline-render.mjs` usa la decisión para el render y su clave; `scripts/clips-graphics.mjs` aporta hook y branding. `scripts/pipeline-runtime.mjs` concentra procesos externos, hash y lectura/escritura JSON.
- Las pruebas están junto a los módulos en `scripts/*.test.mjs`. `index.html`, `assets/`, `hyperframes.json` y `meta.json` pertenecen a la composición HyperFrames.

## Flujo y convenciones

`video → hash/metadatos → audio → transcripción compartida → revisión y cuts.json → descubrimiento/selección de clips → encuadre/gráficos → FFmpeg → MP4`. YouTube Cleaner usa la revisión para exportar el video limpio. Los tiempos de análisis y cortes corresponden al video original.

Los artefactos por video viven en `cache/<sha256>/`; `cache/video-index.json` evita repetir hash y ffprobe cuando la firma del archivo coincide. Las claves de caché permiten reutilizar transcripción, revisión, descubrimiento, selección y renders válidos. `SMART_FRAMING_VERSION` invalida solo análisis visual, decisión, preview y render dependiente del encuadre. `work/` recibe copias del análisis de YouTube; `output/` contiene videos limpios y `clips/` los MP4 verticales. `cache/`, `input/`, `work/`, `work-clips/`, `output/` y `clips/` son locales y no se versionan. Los modelos YuNet y MediaPipe Pose y sus licencias están en `models/`; los binarios de Whisper no se versionan.

## Comandos y documentación

- `npm.cmd run analizar-youtube -- ".\input\video.mp4"` y `npm.cmd run limpiar-youtube -- ".\input\video.mp4"`.
- `npm.cmd run analizar-clips -- ".\input\video.mp4"` y `npm.cmd run sacar-clips -- ".\input\video.mp4"`.
- `node --test scripts/*.test.mjs scripts/framing/*.test.mjs` ejecuta las pruebas del pipeline; `npm run check` valida la composición HyperFrames.
- [README.md](README.md): instalación, requisitos y uso. [CLIPS.md](CLIPS.md): caché y comportamiento técnico del pipeline. [docs/HYPERFRAMES.md](docs/HYPERFRAMES.md): reglas para tareas de HyperFrames. [AGENTS.md](AGENTS.md): guía de trabajo y cuándo consultar estos documentos.

Este mapa orienta la navegación. Si discrepa del código, verifica el código y actualiza solo la parte afectada del mapa cuando cambie la arquitectura.
