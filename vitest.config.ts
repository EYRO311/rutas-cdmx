import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Investigado 2026-08-28: la mayoría de los archivos de test (18 de 21)
     * abren una conexión real a Postgres (`openTestPool()` en
     * src/routing/__tests__/db-pool.ts, o `scripts/db.ts` en tests/api y
     * tests/auto) contra el ÚNICO contenedor local (`rutas-db`, puerto
     * 5433). Vitest corre archivos de test en paralelo por default —con 21
     * archivos y cada uno abriendo su propio Pool (max 5), eso es
     * contención real de conexiones/CPU sobre una sola instancia de
     * Postgres.
     *
     * Esa contención no es solo lentitud: el motor de ruteo
     * (src/routing/dijkstra.ts) usa un deadline de reloj de pared real
     * (`performance.now() + SEARCH_TIME_BUDGET_MS`, 2200ms) para cortar la
     * búsqueda, y cuántos nodos alcanza a expandir antes de esa marca
     * depende de la latencia real de cada query. Con contención entre
     * archivos, esa latencia varía lo suficiente para que la MISMA consulta
     * (mismo origen/destino/fecha) a veces encuentre ruta y a veces corte
     * en `no_coverage` — confirmado corriendo el mismo test aislado 7/7
     * veces sin fallar, y la suite completa fallando un test distinto cada
     * vez. No es un bug de la integración de bici en sí (esa lógica está
     * correcta), es que agregó queries por expansión y se comió el margen
     * que ya era angosto (p95 medido = 2201.8ms contra un presupuesto de
     * 2200ms).
     *
     * Serializar archivos elimina la contención de raíz. La suite corre más
     * lento, pero dejan de aparecer positivos/negativos falsos que dependen
     * de qué tan cargada esté la máquina en el momento exacto de la
     * corrida.
     */
    fileParallelism: false,
  },
});
