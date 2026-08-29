import { describe, it, expect } from "vitest";
import { dominates, ParetoBag } from "../labels.ts";
import type { Label } from "../types.ts";

function makeLabel(overrides: Partial<Label> = {}): Label {
  return {
    stopId: "S1",
    nodeType: "gtfs_stop",
    arrivalSecs: 1000,
    transfers: 0,
    walkSecs: 0,
    costPesos: 0,
    lastTripId: null,
    parent: null,
    viaEdge: null,
    ...overrides,
  };
}

describe("dominates", () => {
  it("un label estrictamente mejor en todo domina", () => {
    const a = makeLabel({ arrivalSecs: 100, transfers: 0, walkSecs: 10, costPesos: 5 });
    const b = makeLabel({ arrivalSecs: 200, transfers: 1, walkSecs: 20, costPesos: 10 });
    expect(dominates(a, b)).toBe(true);
    expect(dominates(b, a)).toBe(false);
  });

  it("dos labels incomparables (mejor en un criterio, peor en otro) no se dominan entre sí", () => {
    const faster = makeLabel({ arrivalSecs: 100, transfers: 2, walkSecs: 10, costPesos: 5 });
    const fewerTransfers = makeLabel({ arrivalSecs: 200, transfers: 0, walkSecs: 10, costPesos: 5 });
    expect(dominates(faster, fewerTransfers)).toBe(false);
    expect(dominates(fewerTransfers, faster)).toBe(false);
  });

  it("un label idéntico se considera dominado (para no acumular duplicados)", () => {
    const a = makeLabel({ arrivalSecs: 100, transfers: 1, walkSecs: 10, costPesos: 5 });
    const b = makeLabel({ arrivalSecs: 100, transfers: 1, walkSecs: 10, costPesos: 5 });
    expect(dominates(a, b)).toBe(true);
  });
});

describe("ParetoBag", () => {
  it("acepta el primer label insertado", () => {
    const bag = new ParetoBag();
    const inserted = bag.tryInsert(makeLabel());
    expect(inserted).toBe(true);
    expect(bag.size).toBe(1);
  });

  it("rechaza un label dominado por uno existente", () => {
    const bag = new ParetoBag();
    bag.tryInsert(makeLabel({ arrivalSecs: 100, transfers: 0, walkSecs: 0, costPesos: 0 }));
    const worse = bag.tryInsert(makeLabel({ arrivalSecs: 200, transfers: 1, walkSecs: 10, costPesos: 5 }));
    expect(worse).toBe(false);
    expect(bag.size).toBe(1);
  });

  it("conserva ambos labels cuando son Pareto-incomparables", () => {
    const bag = new ParetoBag();
    bag.tryInsert(makeLabel({ arrivalSecs: 100, transfers: 2, walkSecs: 0, costPesos: 0 }));
    bag.tryInsert(makeLabel({ arrivalSecs: 300, transfers: 0, walkSecs: 0, costPesos: 0 }));
    expect(bag.size).toBe(2);
  });

  it("al insertar un label que domina a varios existentes, los elimina a todos", () => {
    const bag = new ParetoBag();
    bag.tryInsert(makeLabel({ arrivalSecs: 500, transfers: 3, walkSecs: 50, costPesos: 20 }));
    bag.tryInsert(makeLabel({ arrivalSecs: 600, transfers: 0, walkSecs: 100, costPesos: 30 }));
    expect(bag.size).toBe(2);

    const dominator = makeLabel({ arrivalSecs: 100, transfers: 0, walkSecs: 10, costPesos: 5 });
    const inserted = bag.tryInsert(dominator);
    expect(inserted).toBe(true);
    expect(bag.size).toBe(1);
    expect(bag.all[0]).toBe(dominator);
  });
});
