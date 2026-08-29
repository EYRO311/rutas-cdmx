/**
 * Parser CSV mínimo pero correcto para RFC4180: soporta campos entre comillas
 * dobles con comas y saltos de línea dentro, y comillas escapadas como "".
 *
 * Se escribió a mano en vez de meter una dependencia nueva porque el GTFS de
 * cdmx-gtfs.zip SÍ tiene filas así (verificado en stops.txt, 3 filas, p.ej.
 * `"Periférico, Puente hacia Periférico Norte"` y nombres con comillas
 * escapadas `"Camino de la Unión ""A"" y..."`). Un split(',') ingenuo
 * desalinea columnas en esas filas sin lanzar ningún error — es el tipo de
 * bug silencioso que corrompe datos en vez de fallar ruidosamente.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      // Ignora líneas completamente vacías (finales de archivo comunes).
      if (field.length > 0 || row.length > 0) {
        pushRow();
      } else {
        i++;
        continue;
      }
      i++;
      continue;
    }
    field += c;
    i++;
  }

  // Última fila si el archivo no termina en salto de línea.
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  return rows;
}

/**
 * Parsea un CSV con encabezado y devuelve un array de objetos
 * {columna: valor}. Los valores vacíos quedan como "" (el caller decide si
 * eso es NULL o cadena vacía según la columna).
 */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim());
  const records: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    // Filas con una sola celda vacía son basura de fin de archivo.
    if (row.length === 1 && row[0] === "") continue;
    const record: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      record[header[c]!] = row[c] ?? "";
    }
    records.push(record);
  }
  return records;
}
