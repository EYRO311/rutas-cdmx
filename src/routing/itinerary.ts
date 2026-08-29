/**
 * Reconstrucción de un `Label` final (con su cadena de `.parent`) a un
 * `Itinerary` serializable. Función pura, sin dependencia de Postgres —
 * por eso tiene su propio test unitario sobre una cadena de labels
 * sintética, sin necesidad de correr una búsqueda real.
 */
import { COST_DEFAULTS } from "./config.ts";
import { scalarCost, walkSecondsFromMeters } from "./cost.ts";
import type { CandidateStop, CostWeights, Itinerary, ItineraryLeg, Label } from "./types.ts";

/** Recorre `.parent` desde `label` hasta el origen (parent === null) y arma los tramos en orden cronológico. */
export function reconstructLegs(label: Label): ItineraryLeg[] {
  const legs: ItineraryLeg[] = [];
  let current: Label | null = label;
  while (current && current.parent) {
    const via = current.viaEdge;
    if (!via) {
      throw new Error("Label con parent pero sin viaEdge — invariante rota del motor de ruteo.");
    }
    legs.push({
      mode: via.edgeType,
      fromStopId: via.fromStopId,
      toStopId: current.stopId,
      fromNodeType: current.parent.nodeType,
      toNodeType: current.nodeType,
      tripId: via.tripId,
      routeId: via.routeId,
      departSecs: via.departSecs,
      arriveSecs: current.arrivalSecs,
      distanceMeters: via.distanceMeters,
    });
    current = current.parent;
  }
  legs.reverse();
  return legs;
}

/** Recorre `.parent` hasta el label raíz (el label de origen, sin parent). */
export function findRootLabel(label: Label): Label {
  let current = label;
  while (current.parent) current = current.parent;
  return current;
}

/**
 * Arma el itinerario completo puerta a puerta: caminata de acceso inicial
 * (punto de origen -> primera parada), los tramos internos del grafo, y la
 * caminata final (última parada -> punto de destino exacto). El label raíz
 * de la cadena (`.parent === null`) SIEMPRE es un label de origen construido
 * por `window.ts#buildOriginLabels`, cuyo `walkSecs`/`arrivalSecs` ya
 * codifican la caminata de acceso — no hace falta que el llamador la pase
 * de nuevo.
 */
export function buildItinerary(params: {
  finalLabel: Label;
  destinationStop: CandidateStop;
  weights: CostWeights;
}): Itinerary {
  const { finalLabel, destinationStop, weights } = params;

  const root = findRootLabel(finalLabel);
  const originDepartSecs = root.arrivalSecs - root.walkSecs;
  const originAccessWalkSecs = root.walkSecs;

  const internalLegs = reconstructLegs(finalLabel);

  const accessLeg: ItineraryLeg = {
    mode: "walk_access",
    fromStopId: null,
    toStopId: internalLegs[0]?.fromStopId ?? finalLabel.stopId,
    fromNodeType: null,
    // El origen SIEMPRE se siembra en una parada GTFS (root.nodeType es
    // siempre "gtfs_stop" — ver window.ts#buildOriginLabels, no se
    // implementó sembrar directamente en una estación Ecobici en este
    // entregable, ver limitación en docs/handoff/03-algoritmo.md).
    toNodeType: internalLegs[0]?.fromNodeType ?? root.nodeType,
    tripId: null,
    routeId: null,
    departSecs: originDepartSecs,
    arriveSecs: originDepartSecs + originAccessWalkSecs,
    distanceMeters: null,
  };

  const finalWalkMeters = destinationStop.distanceMeters * COST_DEFAULTS.walkCircuityFactor;
  const finalWalkSecs = Math.round(walkSecondsFromMeters(finalWalkMeters, weights.walkingSpeedMps));
  const finalLeg: ItineraryLeg = {
    mode: "walk_access",
    fromStopId: finalLabel.stopId,
    toStopId: null,
    fromNodeType: finalLabel.nodeType,
    toNodeType: null,
    tripId: null,
    routeId: null,
    departSecs: finalLabel.arrivalSecs,
    arriveSecs: finalLabel.arrivalSecs + finalWalkSecs,
    distanceMeters: destinationStop.distanceMeters,
  };

  const legs = [accessLeg, ...internalLegs, finalLeg];
  const totalWalkSecs = finalLabel.walkSecs + originAccessWalkSecs + finalWalkSecs;
  const arriveSecs = finalLeg.arriveSecs!;

  // scalarCost se calcula sobre un label "virtual" que incluye las
  // caminatas de acceso/salida, para que el ranking entre itinerarios
  // considere el viaje puerta a puerta completo, no solo el tramo interno
  // del grafo.
  const doorToDoorLabel: Label = {
    ...finalLabel,
    arrivalSecs: arriveSecs,
    walkSecs: totalWalkSecs,
  };

  return {
    legs,
    departSecs: originDepartSecs,
    arriveSecs,
    durationSecs: arriveSecs - originDepartSecs,
    transfers: finalLabel.transfers,
    walkSecs: totalWalkSecs,
    costPesos: finalLabel.costPesos,
    scalarCost: scalarCost(doorToDoorLabel, weights, originDepartSecs),
  };
}
