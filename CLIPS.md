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

El render es secuencial, con `-ss` antes del input. Usa un solo video ajustado sobre negro, tarjeta blanca durante siete segundos y branding rojo/verde permanente. La inspección de bandas laterales está activa por defecto; solo recorta cuando detecta que es seguro y, en los demás casos, conserva el frame completo. `--detect-sidebars` también la activa explícitamente. `--encoder auto` prueba encoders disponibles con cinco segundos de video real y prefiere libx264 salvo mejora clara sin aumento excesivo de tamaño. Si un encoder de hardware falla, reintenta el clip con libx264. Cada MP4 válido tiene render-key; una segunda ejecución lo omite y continúa desde el primer clip pendiente.

`--debug` muestra progreso adicional. Los errores completos de FFmpeg, Whisper y Codex se guardan dentro de la caché del video. Para verificar: `node --test scripts/*.test.mjs`.
