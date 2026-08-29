import { describe, it, expect } from "vitest";
import { evaluarHoyNoCircula } from "../../src/modes/auto/hoy-no-circula.ts";

// Fechas de referencia verificadas con Date.getDay() antes de escribir las
// pruebas (no asumidas): 2026-08-17 es lunes, ..., 2026-08-22 es sábado
// (4ta ocurrencia del mes), 2026-08-29 es el 5to sábado de agosto 2026.
const LUNES = new Date("2026-08-17T08:00:00-06:00");
const MARTES = new Date("2026-08-18T08:00:00-06:00");
const MIERCOLES = new Date("2026-08-19T08:00:00-06:00");
const JUEVES = new Date("2026-08-20T08:00:00-06:00");
const VIERNES = new Date("2026-08-21T08:00:00-06:00");
const DOMINGO = new Date("2026-08-16T08:00:00-06:00");
const SABADO_1RO = new Date("2026-08-01T08:00:00-06:00"); // 1er sábado
const SABADO_2DO = new Date("2026-08-08T08:00:00-06:00"); // 2do sábado
const SABADO_3RO = new Date("2026-08-15T08:00:00-06:00"); // 3er sábado
const SABADO_4TO = new Date("2026-08-22T08:00:00-06:00"); // 4to sábado
const SABADO_5TO = new Date("2026-08-29T08:00:00-06:00"); // 5to sábado

describe("evaluarHoyNoCircula — programa regular entre semana", () => {
  it("restringe la terminación que descansa cada día (holograma 1)", () => {
    expect(evaluarHoyNoCircula({ terminacionPlaca: 5, holograma: "1", fecha: LUNES }).restringido).toBe(true);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 6, holograma: "1", fecha: LUNES }).restringido).toBe(true);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 7, holograma: "1", fecha: LUNES }).restringido).toBe(false);

    expect(evaluarHoyNoCircula({ terminacionPlaca: 7, holograma: "2", fecha: MARTES }).restringido).toBe(true);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 8, holograma: "2", fecha: MARTES }).restringido).toBe(true);

    expect(evaluarHoyNoCircula({ terminacionPlaca: 3, holograma: "1", fecha: MIERCOLES }).restringido).toBe(true);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 4, holograma: "1", fecha: MIERCOLES }).restringido).toBe(true);

    expect(evaluarHoyNoCircula({ terminacionPlaca: 1, holograma: "1", fecha: JUEVES }).restringido).toBe(true);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 2, holograma: "1", fecha: JUEVES }).restringido).toBe(true);

    expect(evaluarHoyNoCircula({ terminacionPlaca: 9, holograma: "1", fecha: VIERNES }).restringido).toBe(true);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 0, holograma: "1", fecha: VIERNES }).restringido).toBe(true);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 1, holograma: "1", fecha: VIERNES }).restringido).toBe(false);
  });

  it("holograma 0 y 00 circulan todos los días entre semana", () => {
    for (const holograma of ["0", "00"] as const) {
      expect(evaluarHoyNoCircula({ terminacionPlaca: 5, holograma, fecha: LUNES }).restringido).toBe(false);
      expect(evaluarHoyNoCircula({ terminacionPlaca: 7, holograma, fecha: MARTES }).restringido).toBe(false);
    }
  });

  it("holograma exento nunca se restringe, sin importar terminación o día", () => {
    expect(evaluarHoyNoCircula({ terminacionPlaca: 5, holograma: "exento", fecha: LUNES }).restringido).toBe(false);
  });

  it("domingo circulan todos, incluso holograma 1/2 con la terminación 'del día'", () => {
    // Domingo no tiene entrada en DIAS_ENTRE_SEMANA, así que nunca restringe.
    expect(evaluarHoyNoCircula({ terminacionPlaca: 5, holograma: "1", fecha: DOMINGO }).restringido).toBe(false);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 0, holograma: "2", fecha: DOMINGO }).restringido).toBe(false);
  });

  it("terminación inválida lanza error explícito", () => {
    expect(() =>
      evaluarHoyNoCircula({ terminacionPlaca: 10, holograma: "1", fecha: LUNES })
    ).toThrow(/terminacionPlaca inválida/);
    expect(() =>
      evaluarHoyNoCircula({ terminacionPlaca: -1, holograma: "1", fecha: LUNES })
    ).toThrow(/terminacionPlaca inválida/);
  });
});

describe("evaluarHoyNoCircula — sábados", () => {
  it("holograma 2 y foráneo descansan todos los sábados", () => {
    for (const fecha of [SABADO_1RO, SABADO_2DO, SABADO_3RO, SABADO_4TO]) {
      expect(evaluarHoyNoCircula({ terminacionPlaca: 3, holograma: "2", fecha }).restringido).toBe(true);
      expect(evaluarHoyNoCircula({ terminacionPlaca: 3, holograma: "foraneo", fecha }).restringido).toBe(true);
    }
  });

  it("holograma 1 con terminación non descansa 1er y 3er sábado, no 2do/4to", () => {
    expect(evaluarHoyNoCircula({ terminacionPlaca: 3, holograma: "1", fecha: SABADO_1RO }).restringido).toBe(true);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 3, holograma: "1", fecha: SABADO_3RO }).restringido).toBe(true);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 3, holograma: "1", fecha: SABADO_2DO }).restringido).toBe(false);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 3, holograma: "1", fecha: SABADO_4TO }).restringido).toBe(false);
  });

  it("holograma 1 con terminación par descansa 2do y 4to sábado, no 1ro/3ro", () => {
    expect(evaluarHoyNoCircula({ terminacionPlaca: 4, holograma: "1", fecha: SABADO_2DO }).restringido).toBe(true);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 4, holograma: "1", fecha: SABADO_4TO }).restringido).toBe(true);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 4, holograma: "1", fecha: SABADO_1RO }).restringido).toBe(false);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 4, holograma: "1", fecha: SABADO_3RO }).restringido).toBe(false);
  });

  it("quinto sábado del mes: circulan todos los holograma 1", () => {
    expect(evaluarHoyNoCircula({ terminacionPlaca: 3, holograma: "1", fecha: SABADO_5TO }).restringido).toBe(false);
    expect(evaluarHoyNoCircula({ terminacionPlaca: 4, holograma: "1", fecha: SABADO_5TO }).restringido).toBe(false);
  });

  it("holograma 0/00/exento circulan todos los sábados", () => {
    for (const holograma of ["0", "00", "exento"] as const) {
      expect(evaluarHoyNoCircula({ terminacionPlaca: 3, holograma, fecha: SABADO_1RO }).restringido).toBe(false);
    }
  });
});

describe("evaluarHoyNoCircula — contingencia ambiental con boletín conocido", () => {
  it("Fase 1: boletín restringe holograma 0 explícitamente aunque el programa regular lo exente", () => {
    const resultado = evaluarHoyNoCircula({
      terminacionPlaca: 5,
      holograma: "0",
      fecha: LUNES,
      contingencia: {
        activa: true,
        fase: 1,
        boletin: { hologramasRestringidos: ["0", "00"] },
      },
    });
    expect(resultado.restringido).toBe(true);
    expect(resultado.confianza).toBe("alta");
  });

  it("Fase 1: 'doble hoy no circula' restringe una terminación adicional para holograma 1/2", () => {
    // Lunes normal restringe 5,6. El boletín agrega 1 como terminación extra.
    const resultado = evaluarHoyNoCircula({
      terminacionPlaca: 1,
      holograma: "2",
      fecha: LUNES,
      contingencia: {
        activa: true,
        fase: 1,
        boletin: { hologramasRestringidos: [], terminacionesAdicionales: [1] },
      },
    });
    expect(resultado.restringido).toBe(true);
  });

  it("Fase 1: holograma exento sigue exento incluso con boletín activo", () => {
    const resultado = evaluarHoyNoCircula({
      terminacionPlaca: 5,
      holograma: "exento",
      fecha: LUNES,
      contingencia: {
        activa: true,
        fase: 1,
        boletin: { hologramasRestringidos: ["0", "00", "1", "2"] },
      },
    });
    expect(resultado.restringido).toBe(false);
  });

  it("con boletín conocido, si nada del boletín aplica, cae al programa regular", () => {
    // Terminación 7 no descansa el lunes (5,6) ni está en el boletín.
    const resultado = evaluarHoyNoCircula({
      terminacionPlaca: 7,
      holograma: "1",
      fecha: LUNES,
      contingencia: {
        activa: true,
        fase: 1,
        boletin: { hologramasRestringidos: [], terminacionesAdicionales: [5, 6] },
      },
    });
    expect(resultado.restringido).toBe(false);
  });
});

describe("evaluarHoyNoCircula — contingencia sin boletín conocido (fallback conservador)", () => {
  it("Fase 2 sin boletín: restringe todo lo que no sea exento", () => {
    const resultado = evaluarHoyNoCircula({
      terminacionPlaca: 7,
      holograma: "0",
      fecha: LUNES,
      contingencia: { activa: true, fase: 2 },
    });
    expect(resultado.restringido).toBe(true);
    expect(resultado.confianza).toBe("baja");
  });

  it("Fase 2 sin boletín: exento sigue circulando", () => {
    const resultado = evaluarHoyNoCircula({
      terminacionPlaca: 7,
      holograma: "exento",
      fecha: LUNES,
      contingencia: { activa: true, fase: 2 },
    });
    expect(resultado.restringido).toBe(false);
    expect(resultado.confianza).toBe("baja");
  });

  it("Fase 1 sin boletín: holograma 1 y 2 quedan restringidos sin importar terminación", () => {
    const r1 = evaluarHoyNoCircula({
      terminacionPlaca: 7, // no es terminación del lunes (5,6)
      holograma: "1",
      fecha: LUNES,
      contingencia: { activa: true, fase: 1 },
    });
    expect(r1.restringido).toBe(true);
    expect(r1.confianza).toBe("baja");

    const r2 = evaluarHoyNoCircula({
      terminacionPlaca: 7,
      holograma: "2",
      fecha: LUNES,
      contingencia: { activa: true, fase: 1 },
    });
    expect(r2.restringido).toBe(true);
  });

  it("Fase 1 sin boletín: holograma 0/00 se restringe solo si su terminación coincide con la del día", () => {
    const coincide = evaluarHoyNoCircula({
      terminacionPlaca: 5, // sí descansa el lunes en el programa regular
      holograma: "0",
      fecha: LUNES,
      contingencia: { activa: true, fase: 1 },
    });
    expect(coincide.restringido).toBe(true);

    const noCoincide = evaluarHoyNoCircula({
      terminacionPlaca: 7, // no descansa el lunes
      holograma: "0",
      fecha: LUNES,
      contingencia: { activa: true, fase: 1 },
    });
    expect(noCoincide.restringido).toBe(false);
  });

  it("contingencia marcada como no activa se comporta igual que sin contingencia", () => {
    const conContingenciaInactiva = evaluarHoyNoCircula({
      terminacionPlaca: 5,
      holograma: "1",
      fecha: LUNES,
      contingencia: { activa: false, fase: null },
    });
    const sinContingencia = evaluarHoyNoCircula({ terminacionPlaca: 5, holograma: "1", fecha: LUNES });
    expect(conContingenciaInactiva).toEqual(sinContingencia);
  });
});
