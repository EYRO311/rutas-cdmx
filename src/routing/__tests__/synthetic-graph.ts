/**
 * Helper de test: construye un `NeighborFetcher` sintético (sin Postgres)
 * a partir de una lista plana de aristas. Usado por dijkstra.test.ts y
 * raptor.test.ts para probar la lógica de búsqueda de forma determinista,
 * sin depender de qué datos reales haya en la base en el momento de correr
 * los tests. Las pruebas contra Postgres real (que sí importan para
 * cumplir "tests reales contra la Postgres real") viven en los mismos
 * archivos, como casos adicionales.
 */
import type { EdgeType, NodeType, NeighborFetcher, StopNeighborRow } from "../types.ts";

export interface SyntheticEdge {
  from: string;
  edge_type: EdgeType;
  to_node_type?: NodeType;
  to_node_id: string;
  trip_id?: string | null;
  route_id?: string | null;
  depart_secs?: number | null;
  arrive_secs?: number | null;
  distance_meters?: number | null;
  /** Agregado 2026-08-22, solo relevante para edge_type "bike" — ver types.ts#StopNeighborRow. */
  duration_secs?: number | null;
}

/**
 * `nodeType` (agregado 2026-08-22, ver types.ts#NeighborFetcher) se ignora
 * a propósito aquí: los grafos sintéticos de dijkstra.test.ts/raptor.test.ts
 * buscan aristas por `from` (el stopId), no por tipo de nodo — el propio
 * `SyntheticEdge.to_node_type` es suficiente para simular tanto paradas
 * GTFS como estaciones Ecobici sin que este fetcher necesite dos contratos
 * de datos distintos como sí los tiene graph-client.ts.
 */
export function makeSyntheticFetcher(edges: SyntheticEdge[]): NeighborFetcher {
  return async (stopId, _nodeType, fromSecs, windowSecs) => {
    const rows: StopNeighborRow[] = [];
    for (const e of edges) {
      if (e.from !== stopId) continue;
      if (e.edge_type === "ride") {
        const depart = e.depart_secs ?? null;
        if (depart === null) continue;
        if (depart < fromSecs || depart > fromSecs + windowSecs) continue;
      }
      rows.push({
        edge_type: e.edge_type,
        to_node_type: e.to_node_type ?? "gtfs_stop",
        to_node_id: e.to_node_id,
        trip_id: e.trip_id ?? null,
        route_id: e.route_id ?? null,
        depart_secs: e.depart_secs ?? null,
        arrive_secs: e.arrive_secs ?? null,
        distance_meters: e.distance_meters ?? null,
        duration_secs: e.duration_secs ?? null,
      });
    }
    return rows;
  };
}
