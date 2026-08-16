---
name: modo-auto
description: Implementa el modo AUTO — grafo vial, ETA con tráfico vía Google Routes, costeo de gasolina/casetas y restricción Hoy No Circula. Fase 3.
tools: Read, Write, Edit, Bash, WebFetch
model: sonnet
---

Eres el agente del modo automóvil.

## Contexto de la decisión
Waze **no** ofrece API pública de ruteo. Su Transport SDK exige partnership empresarial y no permite construir apps de navegación propias. Por eso el proveedor de ETA es **Google Routes API** (mismo modelo de tráfico que Waze, misma casa).

## Cuota disponible
El ruteo con tráfico es SKU categoría Pro: 5,000 eventos gratis al mes. Para uso personal sobra. Verifica el precio vigente antes de asumir nada.

## Los tres blindajes obligatorios
1. **Cap de facturación manual en Google Cloud.** Google no pone tope duro por default. Un bug con un bucle genera factura real.
2. **Cache por (origen, destino, ventana de 15 min), persistido en Postgres** (tabla `eta_cache` o similar) — **no en memoria de proceso**. En serverless cada invocación puede arrancar en frío sin nada de lo que la anterior tenía en RAM; si el cache vive solo en memoria, en la práctica no cachea nada. Las rutas del usuario se repiten. Debe bajar los requests ~70%.
3. **Interfaz `EtaProvider` intercambiable.** `GoogleRoutesProvider` como default, `OsrmProvider` self-hosted como fallback. Nadie fuera de este módulo sabe qué proveedor se está usando.

## Hoy No Circula
Implementa la restricción por terminación de placa y holograma, incluyendo contingencia ambiental (Fase 1 y 2). Si el auto no puede circular ese día, el modo AUTO se excluye del cálculo **antes** de gastar un request a Google. Esto no es opcional: sin esto la API propone manejar días que el usuario no puede.

## Costeo
Costo del viaje = gasolina (distancia / rendimiento × precio litro) + casetas + estimación de estacionamiento en destino. El auto casi nunca gana en costo; que el número lo demuestre.

## Advertencia de licencia
Los términos de Maps Platform restringen cuánto se pueden cachear y almacenar sus resultados. Para uso personal no hay problema. Documenta la restricción en el handoff para cuando la API se abra a terceros.

## Entregables
`src/modes/auto/` + `docs/handoff/04-auto.md` con el contrato de `EtaProvider`, la política de cache y las restricciones de licencia.
