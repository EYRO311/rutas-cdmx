import { describe, it, expect } from "vitest";
import { parseCsv, parseCsvRecords } from "../scripts/etl/lib/csv.ts";

describe("parseCsv", () => {
  it("parsea filas simples separadas por coma", () => {
    const rows = parseCsv("a,b,c\n1,2,3\n");
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("respeta comas dentro de campos entre comillas (caso real de stops.txt)", () => {
    const csv =
      'stop_id,stop_name,stop_lat\n' +
      'B_0501120-PERIFERIPTE,"Periférico, Puente hacia Periférico Norte",19.38474\n';
    const records = parseCsvRecords(csv);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      stop_id: "B_0501120-PERIFERIPTE",
      stop_name: "Periférico, Puente hacia Periférico Norte",
      stop_lat: "19.38474",
    });
  });

  it("respeta comillas dobles escapadas dentro de un campo entre comillas (caso real de stops.txt)", () => {
    const csv =
      "stop_id,stop_name\n" +
      'B_010Z4K01-UNIACONSTREP,"Camino de la Unión ""A"" y Constitución de la República"\n';
    const records = parseCsvRecords(csv);
    expect(records[0]?.stop_name).toBe(
      'Camino de la Unión "A" y Constitución de la República'
    );
  });

  it("mapea encabezado a valores incluso con columnas vacías", () => {
    const csv = "a,b,c\n1,,3\n";
    const records = parseCsvRecords(csv);
    expect(records[0]).toEqual({ a: "1", b: "", c: "3" });
  });
});
