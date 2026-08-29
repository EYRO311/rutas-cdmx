/**
 * Etiquetas multicriterio y poda por dominancia de Pareto.
 *
 * Vector de criterios (los 4 que pide .claude/agents/algoritmo-ruteo.md):
 * (arrivalSecs, transfers, walkSecs, costPesos). "Menor es mejor" en los
 * cuatro. Un label A domina a un label B si A es <= B en los cuatro
 * criterios y estrictamente menor en al menos uno (dominancia débil con
 * desempate: A también domina si es igual en todo — se descarta el
 * duplicado para no acumular basura).
 */
import type { Label } from "./types.ts";

/** true si `a` domina a `b` (a es al menos tan bueno en todo, mejor en algo, o idéntico). */
export function dominates(a: Label, b: Label): boolean {
  const leAll =
    a.arrivalSecs <= b.arrivalSecs &&
    a.transfers <= b.transfers &&
    a.walkSecs <= b.walkSecs &&
    a.costPesos <= b.costPesos;
  if (!leAll) return false;
  const ltAny =
    a.arrivalSecs < b.arrivalSecs ||
    a.transfers < b.transfers ||
    a.walkSecs < b.walkSecs ||
    a.costPesos < b.costPesos;
  return ltAny || isEqualVector(a, b);
}

function isEqualVector(a: Label, b: Label): boolean {
  return (
    a.arrivalSecs === b.arrivalSecs &&
    a.transfers === b.transfers &&
    a.walkSecs === b.walkSecs &&
    a.costPesos === b.costPesos
  );
}

/**
 * Bolsa de labels Pareto-óptimos para UN stop. Insertar un label nuevo:
 * - si algún label existente lo domina (o es idéntico), se descarta y no se
 *   agrega (devuelve false: no hubo mejora).
 * - si no, se agrega y se eliminan del bag todos los labels que el nuevo
 *   domina (devuelve true: hubo mejora, el stop debe re-expandirse/marcarse).
 */
export class ParetoBag {
  private labels: Label[] = [];

  get all(): readonly Label[] {
    return this.labels;
  }

  get size(): number {
    return this.labels.length;
  }

  tryInsert(candidate: Label): boolean {
    for (const existing of this.labels) {
      if (dominates(existing, candidate)) {
        return false;
      }
    }
    this.labels = this.labels.filter((existing) => !dominates(candidate, existing));
    this.labels.push(candidate);
    return true;
  }

  /**
   * Salvaguarda de latencia (WINDOW.MAX_LABELS_PER_STOP, ver config.ts):
   * si la bolsa Pareto-óptima real de una parada crece más allá de
   * `maxSize`, conserva solo los `maxSize` mejores según `scoreFn` (menor =
   * mejor) y descarta el resto. Esto SÍ puede tirar un label técnicamente
   * Pareto-óptimo (uno con muchos transbordos y apenas mejor tiempo, por
   * ejemplo) — es una decisión de ingeniería documentada, no un bug: sin
   * esto, redes densas (medido: ~3,000 paradas candidatas en zona céntrica
   * de CDMX) pueden violar el presupuesto de p95 < 3s.
   */
  trimToSize(maxSize: number, scoreFn: (label: Label) => number): void {
    if (this.labels.length <= maxSize) return;
    this.labels.sort((a, b) => scoreFn(a) - scoreFn(b));
    this.labels.length = maxSize;
  }
}

/**
 * Costo escalarizado de un label, usado SOLO para ordenar la cola de
 * prioridad y para rankear itinerarios finales entre sí — la poda interna
 * sigue siendo por dominancia de Pareto, no por este escalar. Ver cost.ts
 * para la definición completa (pesos configurables, nunca hardcodeados).
 */
export function primaryOrderKey(label: Label): number {
  return label.arrivalSecs;
}
