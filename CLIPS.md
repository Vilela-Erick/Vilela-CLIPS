# Pipelines de video

```powershell
npm.cmd run analizar-youtube -- ".\input\video.mp4"
npm.cmd run limpiar-youtube -- ".\input\video.mp4"
npm.cmd run analizar-clips -- ".\input\video.mp4"
npm.cmd run sacar-clips -- ".\input\video.mp4" --cantidad 10 --min-score 7 --encoder auto
```

Ambos comandos usan `cache/<sha256>/`: `metadata.json`, `transcript.json`, `transcript-segments.json`, `youtube-review.json`, `cuts.json`, `discovery.json`, `candidates.json`, `framing.json` y `render-state.json`. `cache/video-index.json` evita repetir el hash y ffprobe cuando ruta, tamaño, mtime y ctime coinciden. La primera ejecución puede importar una transcripción válida de las cachés anteriores. `work/` sigue recibiendo copias del análisis de YouTube para compatibilidad.

Whisper recibe PCM WAV mono a 16 kHz. La transcripción completa se intenta una vez. Si detecta una frase repetida durante minutos, reintenta solo entonces en bloques de cinco minutos con diez segundos de solapamiento; reduce a bloques de un minuto únicamente los bloques que sigan fallando. Cada bloque queda en caché. `HYPERFRAMES_WHISPER_PATH` y `NODE_OPTIONS` se heredan sin cambios.

Codex recibe segmentos compactos con tiempos originales. La búsqueda de momentos se guarda en `discovery.json`; cambiar `--cantidad` o `--min-score` recalcula la selección local sin repetir la llamada. `--cantidad N` es un máximo. `cuts.json` se valida con margen de seguridad y los clips salen siempre del video original.

El render es secuencial, con `-ss` antes del input. Smart Framing ajusta o recompone el video sobre negro, con tarjeta blanca durante siete segundos y branding rojo/verde permanente. La inspección de bandas laterales sigue activa. `--encoder auto` prueba encoders disponibles y reintenta con libx264 si falla el hardware. Cada MP4 válido tiene render-key para reanudar el trabajo.

`--debug` muestra progreso adicional. Los errores completos de FFmpeg, Whisper y Codex se guardan dentro de la caché del video. Para verificar: `node --test scripts/*.test.mjs scripts/framing/*.test.mjs`.

## Smart Framing v2

El encuadre se decide **después** de la selección editorial. Toma cinco muestras por clip (10, 30, 50, 70 y 90 %) a resolución reducida de hasta 640 px, detecta rostros con YuNet y personas con MediaPipe Pose mediante ONNX Runtime CPU y agrupa las detecciones persistentes. Cuando solo hay rostro, estima geométricamente el torso; esa caja no es una detección real. En videos verticales con contenido horizontal incrustado, delimita la zona del video y excluye las barras negras y la interfaz cuando las muestras lo permiten. La clasificación actual distingue con evidencia `single-person`, `conversation`, `video-call`, `multi-person`, `gameplay-facecam`, `screen-content-with-subject`, `native-vertical` y `unknown`; las demás categorías del contrato quedan reservadas para un clasificador futuro. Si no hay evidencia suficiente, conserva el frame completo.

El motor compara `full-frame`, recorte de personas 9:16 o 4:5, `safe-portrait`, `enhanced-landscape`, `recomposed-split` y `content-with-subject`. Las caras persistentes permanecen independientes aunque compartan una detección de cuerpo; los clusters espaciales permiten apilar dos regiones con dos o más personas sin depender del tipo clasificado. `content-with-subject` coloca contenido principal y webcam/reacción en paneles de distinto tamaño, conservando la proporción de cada uno. Evalúa preservación de rostros y cuerpo estimado, `subjectCoverage` (área aproximada ocupada por la unión de sujetos visibles), proporción efectiva, espacio desperdiciado y riesgo de recorte. Para contenido centrado en personas favorece una región de aspecto 4:5 o más vertical cuando los sujetos caben con margen configurable (8 % por defecto); no impone esa regla a gameplay o contenido de pantalla. La unión temporal de las muestras produce un recorte estable por clip, sin tracking ni zoom animado. Una cara en un lateral impide descartarlo como decoración. FFmpeg vuelve a calcular la escala después de cada recorte, mantiene el canvas 1080×1920, fondo negro, hook y branding.

El análisis visual y la decisión tienen claves distintas: la revisión del detector/agrupamiento invalida `visual-analysis.json`; la revisión de puntuación o configuración invalida solo `decision-<clave>.json`, el preview y el render dependiente. No cambian hash, metadatos, audio, transcripción, revisión de YouTube, descubrimiento ni selección. `framing.json` resume las decisiones de los clips seleccionados. El preview registra `previewSample` y usa una de las cinco muestras analizadas según presencia de rostros, geometría y confianza. Los tiempos de extracción y análisis se guardan en la decisión; un resultado en caché evita repetir la detección. Un fallo temporal del detector usa full-frame y se vuelve a intentar en la siguiente ejecución.

Para generar **un PNG de un solo candidato** sin renderizar el MP4 completo:

```powershell
npm.cmd run sacar-clips -- ".\input\video.mp4" --cantidad 1 --preview-framing --debug-framing
```

`--debug-framing` imprime tipo de contenido, sujetos, métricas por estrategia, elección y tiempos sin volcar el JSON. El PNG se guarda en `cache/<sha256>/preview-smart-framing-v2-<clave>.png`. Los modelos [YuNet 2023mar](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) (233 KB, MIT) y [MediaPipe Pose 2023mar](https://github.com/opencv/opencv_zoo/tree/main/models/person_detection_mediapipe) (12 MB, Apache 2.0) se incluyen en `models/` con sus licencias. `onnxruntime-node` 1.30.0 ejecuta inferencia local en CPU con binarios Windows x64; la instalación npm ocupa aproximadamente 301 MB. No se usan APIs externas para analizar videos.
