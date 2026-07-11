# Weather Station — proyecto raíz (repo "main")

Eres un experto en arquitectura de software, hardware, electrónica y meteorología. Este es un proyecto personal (estación meteorológica IoT) que combina firmware embebido, diseño de PCB/electrónica, un backend y un frontend.

## Topología de repos

Este directorio (`weather-station/`) es el repo **main**: versiona contenido transversal al proyecto — documentación de fases, diseño de hardware/PCB, `docker-compose.yml` de despliegue conjunto, y este `CLAUDE.md`.

Conviven acá, como repos **secondary** independientes (cada uno con su propio historial, `.gitignore` y `CLAUDE.md`, ignorados por este repo main vía `.gitignore`):

- `weather-station-backend-service/` — servicio backend en Go.
- `weather-station-frontend-dashboard/` — dashboard frontend en React/Vite.
- `weather-station-station-iot/` — firmware ESP32/PlatformIO + assets de diseño del hardware (esquemáticos, PCB).

No son git submodules a propósito: cada uno se comitea y pushea de forma independiente, sin necesidad de sincronizar pins entre repos.

## Identidad de git

Todo repo bajo `D:/trabajo/my_projects/` (incluido este árbol completo) usa automáticamente la identidad personal (`Mauricio <maulp_gnt@hotmail.com>`) vía un `includeIf` en el `~/.gitconfig` global. No hace falta configurar nada por repo ni pisar la identidad manualmente.

## Política de commits y push (instrucción durable)

Este es un proyecto personal de bajo riesgo. **No pidas confirmación para commitear ni para pushear.** Al terminar una unidad de trabajo con sentido (una tarea, un fix, una sesión de cambios) en este repo o en cualquiera de los secondary:

1. Commitea automáticamente con un mensaje descriptivo y en el repo correspondiente (main o el secondary que corresponda — nunca mezclar cambios de un secondary dentro del commit de otro repo).
2. Si el repo tiene un remote configurado, pusheá automáticamente después de commitear.
3. Si el repo todavía no tiene remote (algunos no lo tienen aún), commiteá igual y seguí — no es un error, simplemente no hay push que hacer todavía.

## Continuidad entre sesiones

El estado vivo del proyecto (qué se hizo, qué está en curso, decisiones pendientes) vive en [`STATUS.md`](./STATUS.md). Actualizalo al final de cada sesión de trabajo relevante, para que la próxima conversación pueda arrancar con contexto completo sin tener que re-derivarlo. Al empezar una sesión nueva, leé `STATUS.md` primero.
