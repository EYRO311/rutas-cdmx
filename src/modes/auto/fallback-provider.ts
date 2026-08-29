/**
 * Compone dos `EtaProvider`: intenta el primario, si truena (red, 4xx/5xx,
 * cuota, key faltante) cae al secundario. Es la pieza que hace real el
 * blindaje #3 (.claude/agents/modo-auto.md): quien arma el proveedor final
 * para el resto del sistema decide el orden (Google primero, OSRM como
 * fallback), y nadie más lo sabe.
 *
 * Nota deliberada: si AMBOS proveedores truenan, este wrapper propaga el
 * error del fallback (no el del primario) — quien llama solo necesita el
 * motivo del último intento real.
 */
import type { EtaProvider, EtaRequest, EtaResult } from "./eta-provider.ts";

export class FallbackEtaProvider implements EtaProvider {
  readonly name: EtaProvider["name"];

  constructor(
    private readonly primary: EtaProvider,
    private readonly fallback: EtaProvider,
    private readonly onFallback?: (error: unknown) => void
  ) {
    this.name = primary.name;
  }

  async getEta(request: EtaRequest): Promise<EtaResult> {
    try {
      return await this.primary.getEta(request);
    } catch (err) {
      this.onFallback?.(err);
      return await this.fallback.getEta(request);
    }
  }
}
