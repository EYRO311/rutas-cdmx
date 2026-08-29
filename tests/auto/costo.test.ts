import { describe, it, expect } from "vitest";
import { calcularCostoAuto } from "../../src/modes/auto/costo.ts";

describe("calcularCostoAuto", () => {
  it("calcula gasolina como (distancia_km / rendimiento) * precio_litro", () => {
    // 20 km, rinde 12 km/l -> 1.6667 litros. Precio 24 MXN/l -> 40 MXN.
    const resultado = calcularCostoAuto({
      distanciaMetros: 20_000,
      rendimientoKmPorLitro: 12,
      precioLitroMxn: 24,
    });
    expect(resultado.gasolinaMxn).toBeCloseTo(40, 2);
    expect(resultado.casetasMxn).toBe(0);
    expect(resultado.estacionamientoMxn).toBe(0);
    expect(resultado.totalMxn).toBeCloseTo(40, 2);
  });

  it("suma casetas cuando vienen del proveedor de ETA", () => {
    const resultado = calcularCostoAuto({
      distanciaMetros: 10_000,
      rendimientoKmPorLitro: 10,
      precioLitroMxn: 24,
      casetasMxn: 55.5,
    });
    // gasolina: 1 litro * 24 = 24
    expect(resultado.gasolinaMxn).toBeCloseTo(24, 2);
    expect(resultado.casetasMxn).toBe(55.5);
    expect(resultado.totalMxn).toBeCloseTo(79.5, 2);
  });

  it("trata casetasMxn null (proveedor no lo soportó para esta ruta/ciudad) como 0, no como estimación inventada", () => {
    const resultado = calcularCostoAuto({
      distanciaMetros: 10_000,
      rendimientoKmPorLitro: 10,
      precioLitroMxn: 24,
      casetasMxn: null,
    });
    expect(resultado.casetasMxn).toBe(0);
  });

  it("suma estacionamiento como tarifa_hora * horas_estimadas", () => {
    const resultado = calcularCostoAuto({
      distanciaMetros: 5_000,
      rendimientoKmPorLitro: 10,
      precioLitroMxn: 24,
      estacionamiento: { tarifaPorHoraMxn: 20, horasEstimadas: 3 },
    });
    expect(resultado.estacionamientoMxn).toBe(60);
  });

  it("suma los tres componentes en el total", () => {
    const resultado = calcularCostoAuto({
      distanciaMetros: 15_000,
      rendimientoKmPorLitro: 15,
      precioLitroMxn: 24,
      casetasMxn: 44,
      estacionamiento: { tarifaPorHoraMxn: 15, horasEstimadas: 4 },
    });
    // gasolina: 1 litro * 24 = 24; casetas 44; estacionamiento 60 -> total 128
    expect(resultado.totalMxn).toBeCloseTo(128, 2);
  });

  it("rechaza rendimiento <= 0", () => {
    expect(() =>
      calcularCostoAuto({ distanciaMetros: 1000, rendimientoKmPorLitro: 0, precioLitroMxn: 24 })
    ).toThrow(/rendimientoKmPorLitro/);
  });

  it("rechaza precio de litro negativo", () => {
    expect(() =>
      calcularCostoAuto({ distanciaMetros: 1000, rendimientoKmPorLitro: 10, precioLitroMxn: -1 })
    ).toThrow(/precioLitroMxn/);
  });
});
