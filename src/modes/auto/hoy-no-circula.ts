/**
 * Hoy No Circula (CDMX) + Contingencia Ambiental. Se evalúa ANTES de pedir
 * un ETA (blindaje explícito de .claude/agents/modo-auto.md: "si el auto
 * no puede circular ese día, el modo AUTO se excluye del cálculo antes de
 * gastar un request a Google"). Ver index.ts (`resolveAutoRoute`) para
 * dónde se conecta ese orden.
 *
 * Reglas verificadas vía WebSearch/WebFetch el 2026-08-16 contra fuentes
 * públicas (sedema.cdmx.gob.mx, y agregadores que citan el calendario
 * oficial vigente) porque el conocimiento de entrenamiento de este agente
 * puede estar desactualizado y las reglas de HNC han cambiado varias veces
 * en la historia del programa. Fuentes consultadas:
 *   - https://sedema.cdmx.gob.mx/programas/programa/hoy-no-circula
 *   - https://verificentroscdmx.com/hoy-no-circula-cdmx/
 *   - https://hoynocircula.info/contingencia-ambiental/
 *
 * === Programa regular (sin contingencia) ===
 * Lunes a sábado, 5:00-22:00. Solo aplica a holograma 1, 2 y placas
 * foráneas -- holograma 00, 0 y "exento" circulan todos los días bajo el
 * programa regular. Domingo: circula todo el mundo.
 *
 * Entre semana, un color de engomado (terminación de placa) descansa cada
 * día:
 *   lunes=5,6 · martes=7,8 · miércoles=3,4 · jueves=1,2 · viernes=9,0
 *
 * Sábado:
 *   - Holograma 1, terminación non (1,3,5,7,9): descansa 1er y 3er sábado.
 *   - Holograma 1, terminación par (0,2,4,6,8): descansa 2do y 4to sábado.
 *   - Holograma 1: si el mes tiene 5to sábado, circulan TODOS sin importar
 *     terminación.
 *   - Holograma 2 y foráneos: descansan TODOS los sábados.
 *
 * === Contingencia Ambiental ===
 * CAME (Comisión Ambiental de la Megalópolis) anuncia cada día de
 * contingencia, vía boletín, exactamente qué terminaciones/hologramas
 * adicionales se restringen ese día específico -- NO es una tabla fija
 * reproducible en código: varía día a día según qué tan grave está la
 * calidad del aire. Lo que sí es estable (documentado en las fuentes de
 * arriba):
 *   - Fase 1 ("Doble Hoy No Circula"): holograma 2 se restringe al 100%
 *     (sin importar terminación); holograma 1 se restringe por paridad
 *     (todas las non o todas las par, según el boletín del día); holograma
 *     0/00 -- normalmente exentos -- también quedan restringidos por
 *     terminación ("20%", según SEDEMA) ese día.
 *   - Fase 2: restricciones más severas que Fase 1 (fuentes coinciden en
 *     que escala, sin dar una tabla fija reproducible).
 *
 * Esta función NO inventa el boletín del día: si `contingencia.activa` es
 * true pero no se pasa `contingencia.boletin` explícito, se aplica un
 * FALLBACK CONSERVADOR (ver `evaluarConBoletinDesconocido` más abajo) en
 * vez de asumir que el usuario puede circular. Elegir mal hacia "sí puede"
 * es el error caro (multa 20-30 UMA + corralón); elegir mal hacia "no
 * puede" solo le hace perder la opción de AUTO ese día. Integrar el
 * boletín real de CAME en vivo (scraping o API, si existe una) es trabajo
 * futuro fuera de esta fase -- documentado en el handoff como pendiente.
 */

export type Holograma = "00" | "0" | "1" | "2" | "exento" | "foraneo";

export interface ContingenciaBoletin {
  /**
   * Hologramas que HOY quedan restringidos además de los que ya restringe
   * el programa regular (p.ej. ["0", "00"] si hoy también les toca, o
   * ["1", "2"] si holograma 1/2 quedan restringidos sin importar
   * terminación). Se llena con el boletín real de CAME del día.
   */
  hologramasRestringidos: Holograma[];
  /**
   * Terminaciones de placa adicionales restringidas hoy para holograma
   * 1/2 más allá de la terminación normal del día ("doble hoy no
   * circula"). `undefined` si no aplica ese día.
   */
  terminacionesAdicionales?: number[];
}

export interface ContingenciaAmbiental {
  activa: boolean;
  fase: 1 | 2 | null;
  /** Boletín del día si se conoce (ver nota de archivo). */
  boletin?: ContingenciaBoletin;
}

export interface HoyNoCirculaInput {
  /** Último dígito de la placa, 0-9. */
  terminacionPlaca: number;
  holograma: Holograma;
  /** Fecha y hora planeada del viaje (afecta día de la semana y ventana horaria). */
  fecha: Date;
  contingencia?: ContingenciaAmbiental;
}

export interface HoyNoCirculaResultado {
  restringido: boolean;
  motivo: string;
  /**
   * "alta" si la regla aplicada es la tabla fija verificada; "baja" si se
   * usó el fallback conservador por contingencia activa sin boletín
   * explícito -- quien consuma esto debería, idealmente, avisar al
   * usuario que la restricción por contingencia es una estimación
   * conservadora, no el boletín oficial del día.
   */
  confianza: "alta" | "baja";
}

const DIAS_ENTRE_SEMANA: Record<number, [number, number]> = {
  1: [5, 6], // lunes
  2: [7, 8], // martes
  3: [3, 4], // miércoles
  4: [1, 2], // jueves
  5: [9, 0], // viernes
};

function esNon(n: number): boolean {
  return n % 2 === 1;
}

/** Número de ocurrencia del día-de-semana dentro del mes (1ro, 2do, ... 5to sábado). */
function ocurrenciaEnMes(fecha: Date): number {
  return Math.floor((fecha.getDate() - 1) / 7) + 1;
}

function esQuintoSabadoDelMes(fecha: Date): boolean {
  // ¿Hay un sábado más adelante en el mismo mes?
  const siguiente = new Date(fecha);
  siguiente.setDate(fecha.getDate() + 7);
  return siguiente.getMonth() !== fecha.getMonth();
}

function siempreExento(holograma: Holograma): boolean {
  // "exento" cubre discapacidad, transporte escolar/personal autorizado,
  // emergencias, etc. (ver fuentes citadas arriba) -- circula siempre,
  // incluso en contingencia, según esas mismas fuentes no listan a
  // "exento" entre las categorías afectadas por Fase 1/2.
  return holograma === "exento";
}

function evaluarProgramaRegular(input: HoyNoCirculaInput): HoyNoCirculaResultado {
  const diaSemana = input.fecha.getDay(); // 0=domingo ... 6=sábado

  if (siempreExento(input.holograma)) {
    return { restringido: false, motivo: "Holograma exento circula todos los días.", confianza: "alta" };
  }

  if (input.holograma === "0" || input.holograma === "00") {
    return {
      restringido: false,
      motivo: `Holograma ${input.holograma} circula todos los días bajo el programa regular.`,
      confianza: "alta",
    };
  }

  if (diaSemana === 0) {
    return { restringido: false, motivo: "Domingo: circulan todos los vehículos.", confianza: "alta" };
  }

  if (diaSemana >= 1 && diaSemana <= 5) {
    const par = DIAS_ENTRE_SEMANA[diaSemana];
    if (par && par.includes(input.terminacionPlaca)) {
      return {
        restringido: true,
        motivo: `Programa regular: terminación ${input.terminacionPlaca} descansa este día (holograma ${input.holograma}).`,
        confianza: "alta",
      };
    }
    return { restringido: false, motivo: "Programa regular: terminación no restringida hoy.", confianza: "alta" };
  }

  // Sábado.
  if (input.holograma === "2" || input.holograma === "foraneo") {
    return {
      restringido: true,
      motivo: `Holograma ${input.holograma} descansa todos los sábados.`,
      confianza: "alta",
    };
  }

  // Holograma 1 en sábado.
  if (esQuintoSabadoDelMes(input.fecha)) {
    return {
      restringido: false,
      motivo: "Quinto sábado del mes: circulan todos los vehículos holograma 1.",
      confianza: "alta",
    };
  }
  const ocurrencia = ocurrenciaEnMes(input.fecha);
  const esSabadoNon = ocurrencia === 1 || ocurrencia === 3;
  const esSabadoPar = ocurrencia === 2 || ocurrencia === 4;
  const terminacionEsNon = esNon(input.terminacionPlaca);

  if ((esSabadoNon && terminacionEsNon) || (esSabadoPar && !terminacionEsNon)) {
    return {
      restringido: true,
      motivo: `Holograma 1, terminación ${terminacionEsNon ? "non" : "par"}: descansa el ${ocurrencia}º sábado del mes.`,
      confianza: "alta",
    };
  }

  return { restringido: false, motivo: "Holograma 1: sábado no restringido para esta terminación.", confianza: "alta" };
}

function aplicaHologramaODeTerminacion(
  input: HoyNoCirculaInput,
  extra: number[] | undefined
): boolean {
  if (!extra || extra.length === 0) return false;
  return extra.includes(input.terminacionPlaca);
}

function evaluarConBoletinConocido(
  input: HoyNoCirculaInput,
  boletin: ContingenciaBoletin
): HoyNoCirculaResultado {
  if (siempreExento(input.holograma)) {
    return { restringido: false, motivo: "Holograma exento circula incluso en contingencia.", confianza: "alta" };
  }
  if (boletin.hologramasRestringidos.includes(input.holograma)) {
    return {
      restringido: true,
      motivo: `Contingencia ambiental: boletín del día restringe holograma ${input.holograma}.`,
      confianza: "alta",
    };
  }
  if (
    (input.holograma === "1" || input.holograma === "2") &&
    aplicaHologramaODeTerminacion(input, boletin.terminacionesAdicionales)
  ) {
    return {
      restringido: true,
      motivo: `Contingencia ambiental (doble hoy no circula): terminación ${input.terminacionPlaca} restringida hoy además de la regla regular.`,
      confianza: "alta",
    };
  }
  return evaluarProgramaRegular(input);
}

/**
 * Fallback conservador para contingencia activa sin boletín explícito.
 * Fase 1: se asume 100% restringido para holograma 1 y 2 (el boletín real
 * siempre restringe holograma 2 al 100% y holograma 1 al menos a la mitad;
 * sobre-restringir holograma 1 es más seguro que adivinar la paridad del
 * día), y para holograma 0/00 SOLO si su terminación coincide con la
 * terminación que descansa hoy en el programa regular (aproximación de la
 * regla real "20% de holograma 0/00 por terminación", sin saber cuál
 * fracción exacta le toca hoy).
 * Fase 2: conservador total -- todo lo que no sea "exento" queda
 * restringido, porque Fase 2 es la más severa y no hay boletín para acotar
 * mejor.
 */
function evaluarConBoletinDesconocido(
  input: HoyNoCirculaInput,
  fase: 1 | 2
): HoyNoCirculaResultado {
  if (siempreExento(input.holograma)) {
    return { restringido: false, motivo: "Holograma exento circula incluso en contingencia.", confianza: "baja" };
  }

  if (fase === 2) {
    return {
      restringido: true,
      motivo:
        "Contingencia Fase 2 activa sin boletín conocido del día: fallback conservador " +
        "restringe todo lo que no sea holograma exento (Fase 2 es la restricción más " +
        "severa del programa; sin el boletín oficial no se puede acotar con precisión).",
      confianza: "baja",
    };
  }

  // Fase 1.
  if (input.holograma === "1" || input.holograma === "2") {
    return {
      restringido: true,
      motivo:
        "Contingencia Fase 1 (doble hoy no circula) activa sin boletín conocido del día: " +
        `fallback conservador restringe holograma ${input.holograma} sin importar terminación.`,
      confianza: "baja",
    };
  }
  if (input.holograma === "0" || input.holograma === "00") {
    const diaSemana = input.fecha.getDay();
    const par = diaSemana >= 1 && diaSemana <= 5 ? DIAS_ENTRE_SEMANA[diaSemana] : undefined;
    if (par && par.includes(input.terminacionPlaca)) {
      return {
        restringido: true,
        motivo:
          `Contingencia Fase 1 activa sin boletín conocido del día: fallback conservador ` +
          `restringe holograma ${input.holograma} con terminación ${input.terminacionPlaca} ` +
          "porque coincide con la terminación que descansa hoy en el programa regular.",
        confianza: "baja",
      };
    }
    return {
      restringido: false,
      motivo: `Holograma ${input.holograma}: terminación no coincide con la restringida hoy (fallback conservador de Fase 1).`,
      confianza: "baja",
    };
  }

  // foraneo u otro: ya restringido por el programa regular si aplica.
  return evaluarProgramaRegular(input);
}

export function evaluarHoyNoCircula(input: HoyNoCirculaInput): HoyNoCirculaResultado {
  if (input.terminacionPlaca < 0 || input.terminacionPlaca > 9 || !Number.isInteger(input.terminacionPlaca)) {
    throw new Error(`terminacionPlaca inválida: ${input.terminacionPlaca} (debe ser entero 0-9).`);
  }

  const contingencia = input.contingencia;
  if (contingencia?.activa && contingencia.fase) {
    if (contingencia.boletin) {
      return evaluarConBoletinConocido(input, contingencia.boletin);
    }
    return evaluarConBoletinDesconocido(input, contingencia.fase);
  }

  return evaluarProgramaRegular(input);
}
