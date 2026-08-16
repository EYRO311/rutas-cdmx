# Estado del proyecto

Actualiza este archivo después de cada handoff aprobado.

| Fase | Agente | Handoff | Estado | Fecha |
|---|---|---|---|---|
| 1 | datos-gtfs | 01-datos.md | ⬜ pendiente | — |
| 2 | modelo-grafo | 02-grafo.md | ⬜ pendiente | — |
| 3 | algoritmo-ruteo | 03-algoritmo.md | ⬜ pendiente | — |
| 3 | modo-auto | 04-auto.md | ⬜ pendiente | — |
| 3 | api-http | 05-api.md | ⬜ pendiente | — |
| 4 | qa-rutas | 08-qa.md | ⬜ pendiente | — |
| 4 | mcp-asistente | 06-mcp.md | ⬜ pendiente | — |
| 5 | aprendizaje-beta | 07-aprendizaje.md | ⬜ pendiente | — |

## Bloqueos abiertos
- Registro pendiente en `metrobus-gtfs.sinopticoplus.com` para acceso al GTFS-RT.
- Cap de facturación en Google Cloud **sin configurar**. Hacerlo antes del primer request real.
- Banco de casos de `qa-rutas` necesita tiempos reales medidos por el usuario.

## Deuda conocida
- GTFS del Metro es de 2022 y no hay tiempo real. Es el hueco más grande del proyecto.
