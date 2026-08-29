import { describe, it, expect } from "vitest";
import { MinHeap } from "../heap.ts";

describe("MinHeap", () => {
  it("extrae elementos en orden ascendente de su llave", () => {
    const heap = new MinHeap<number>((n) => n);
    const input = [5, 3, 8, 1, 9, 2, 7, 4, 6, 0];
    for (const n of input) heap.push(n);

    const output: number[] = [];
    while (heap.size > 0) {
      output.push(heap.pop()!);
    }
    expect(output).toEqual([...input].sort((a, b) => a - b));
  });

  it("pop() en un heap vacío devuelve undefined", () => {
    const heap = new MinHeap<number>((n) => n);
    expect(heap.pop()).toBeUndefined();
  });

  it("size refleja push/pop correctamente", () => {
    const heap = new MinHeap<number>((n) => n);
    expect(heap.size).toBe(0);
    heap.push(1);
    heap.push(2);
    expect(heap.size).toBe(2);
    heap.pop();
    expect(heap.size).toBe(1);
  });

  it("funciona con objetos y una función de llave sobre un campo", () => {
    const heap = new MinHeap<{ id: string; t: number }>((o) => o.t);
    heap.push({ id: "b", t: 20 });
    heap.push({ id: "a", t: 10 });
    heap.push({ id: "c", t: 30 });
    expect(heap.pop()?.id).toBe("a");
    expect(heap.pop()?.id).toBe("b");
    expect(heap.pop()?.id).toBe("c");
  });
});
