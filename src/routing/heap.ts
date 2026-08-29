/**
 * Min-heap binario genérico, sin dependencias externas. Usado como cola de
 * prioridad de Dijkstra/RAPTOR sobre `Label`, ordenado por
 * `primaryOrderKey` (arrivalSecs). Implementación estándar de libro de
 * texto (array 1-indexado implícito, sift-up/sift-down) — no hay nada
 * específico del dominio aquí, por eso vive separado y tiene su propio test
 * puro sin tocar la base de datos.
 */
export class MinHeap<T> {
  private items: T[] = [];
  private readonly keyOf: (item: T) => number;

  constructor(keyOf: (item: T) => number) {
    this.keyOf = keyOf;
  }

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    this.siftUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keyOf(this.items[i]!) >= this.keyOf(this.items[parent]!)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(index: number): void {
    let i = index;
    const n = this.items.length;
    for (;;) {
      const left = i * 2 + 1;
      const right = i * 2 + 2;
      let smallest = i;
      if (left < n && this.keyOf(this.items[left]!) < this.keyOf(this.items[smallest]!)) smallest = left;
      if (right < n && this.keyOf(this.items[right]!) < this.keyOf(this.items[smallest]!)) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(i: number, j: number): void {
    const tmp = this.items[i]!;
    this.items[i] = this.items[j]!;
    this.items[j] = tmp;
  }
}
