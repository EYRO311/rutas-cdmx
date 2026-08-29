/**
 * Costeo del modo AUTO: gasolina + casetas + estimación de estacionamiento
 * en destino (.claude/agents/modo-auto.md: "el auto casi nunca gana en
 * costo; que el número lo demuestre").
 *
 * Deliberadamente NO hay un precio de gasolina ni un rendimiento
 * hardcodeado aquí: `user_modes` (migración 0010, Fase 2) ya tiene
 * `rendimiento_km_l` y `costo_combustible` por usuario -- ese es el dato
 * real a usar, no una constante que se desactualiza (el precio de la
 * gasolina en CDMX cambia semana a semana). Quien llame a
 * `calcularCostoAuto` lee esas columnas y las pasa explícitas.
 */

export interface EstacionamientoInput {
  /** Tarifa por hora en el destino, en MXN. Estimación del usuario o de una tabla externa -- no se inventa un default silencioso. */
  tarifaPorHoraMxn: number;
  /** Horas estimadas que el coche se queda estacionado. */
  horasEstimadas: number;
}

export interface CostoAutoInput {
  distanciaMetros: number;
  rendimientoKmPorLitro: number;
  /** Precio del litro de gasolina en MXN (magna/premium, según lo que use el usuario). */
  precioLitroMxn: number;
  /**
   * Costo de casetas en MXN. Preferentemente viene de
   * `EtaResult.tollInfoMxn` (Google Routes con extraComputations TOLLS,
   * cuando está disponible para la ruta/ciudad); si es `null`/`undefined`
   * se asume 0 -- NO se estima con una heurística inventada, porque un
   * número inventado que "el auto casi nunca gana en costo" tiene que
   * demostrar es peor que uno faltante (subestimar el costo real del auto
   * es el error caro para el propósito de esta comparación).
   */
  casetasMxn?: number | null;
  estacionamiento?: EstacionamientoInput | null;
}

export interface CostoAutoResultado {
  gasolinaMxn: number;
  casetasMxn: number;
  estacionamientoMxn: number;
  totalMxn: number;
}

export function calcularCostoAuto(input: CostoAutoInput): CostoAutoResultado {
  if (input.rendimientoKmPorLitro <= 0) {
    throw new Error(`rendimientoKmPorLitro debe ser > 0, recibí ${input.rendimientoKmPorLitro}.`);
  }
  if (input.precioLitroMxn < 0) {
    throw new Error(`precioLitroMxn no puede ser negativo, recibí ${input.precioLitroMxn}.`);
  }

  const distanciaKm = input.distanciaMetros / 1000;
  const litrosConsumidos = distanciaKm / input.rendimientoKmPorLitro;
  const gasolinaMxn = litrosConsumidos * input.precioLitroMxn;

  const casetasMxn = input.casetasMxn ?? 0;

  const estacionamientoMxn = input.estacionamiento
    ? input.estacionamiento.tarifaPorHoraMxn * input.estacionamiento.horasEstimadas
    : 0;

  const totalMxn = gasolinaMxn + casetasMxn + estacionamientoMxn;

  return {
    gasolinaMxn: round2(gasolinaMxn),
    casetasMxn: round2(casetasMxn),
    estacionamientoMxn: round2(estacionamientoMxn),
    totalMxn: round2(totalMxn),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
