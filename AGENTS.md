# Vilela CLIPS: guía de trabajo

- El código fuente es la fuente de verdad. Antes de cambiar algo, revisa solo los archivos y dependencias relacionados con la tarea; evita por defecto `node_modules/`, `.git/`, `dist/`, `build/`, cachés, logs, medios y resultados generados.
- Consulta [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) cuando una tarea afecte arquitectura, módulos o dependencias y el mapa ayude a orientarte. No hace falta leerlo para cada ajuste pequeño.
- Para instalación y uso, consulta [README.md](README.md); para detalles del pipeline y la caché, [CLIPS.md](CLIPS.md). Verifica los detalles contra el código cuando difieran.
- Tras cada modificación, evalúa si cambió la arquitectura documentada. Si cambió, actualiza solo las secciones afectadas de `PROJECT_CONTEXT.md` en la misma tarea. Si no cambió, déjalo intacto. Mantén las instrucciones concisas y evita repetir análisis ya hechos.
- Ajusta las verificaciones al cambio. Para el pipeline, ejecuta las pruebas relacionadas en `scripts/*.test.mjs`; antes de una entrega amplia, ejecuta `node --test scripts/*.test.mjs`.

## HyperFrames

- Si la tarea crea o modifica una composición HTML, consulta [docs/HYPERFRAMES.md](docs/HYPERFRAMES.md) y las habilidades relevantes **antes** de editarla. Después ejecuta obligatoriamente `npm run check`, corrige los errores y revisa las advertencias antes de renderizar.
- Para inspección, diagnóstico, preview, render, publicación u otros trabajos propios de HyperFrames, consulta ese documento y la habilidad que corresponda. Sus reglas técnicas se aplican a esas tareas; una edición pequeña del pipeline o de documentación ajena a HyperFrames no requiere cargarlo.
