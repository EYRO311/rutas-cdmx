# Pruebas de campo por correo (100% local)

Worker que corre en tu laptop, vigila tu Gmail por IMAP, y cuando le
mandas un correo con origen/destino calcula la ruta usando la API local
(`npm run dev:api`) y responde por correo con el itinerario. Todo corre
en tu máquina — no toca Vercel ni Supabase.

## Setup (una sola vez)

1. **Activa verificación en 2 pasos** en tu cuenta de Google, si no la
   tienes ya: https://myaccount.google.com/security

2. **Genera una "contraseña de aplicación"**:
   https://myaccount.google.com/apppasswords
   - App: "Correo" (Mail), dispositivo: "Otro" → nómbrala
     `rutas-cdmx-worker`.
   - Google te da un código de 16 caracteres. Cópialo.

3. **Agrega estas líneas a tu `.env`** (nunca las mandes por chat ni las
   subas a git — `.env` ya está en `.gitignore`):

   ```
   EMAIL_USER=tu_correo@gmail.com
   EMAIL_APP_PASSWORD=el_codigo_de_16_caracteres
   ```

   `API_KEY` y `DATABASE_URL` ya deberían estar en tu `.env` de antes
   (Fase 3, `api-http`). Si no, corre `npm run seed:api-key -- "field-test" "emiliano"`
   primero.

## Cómo correrlo

1. Levanta Postgres local (Docker, puerto 5433) si no está corriendo.
2. En una terminal: `npm run dev:api` (deja esta corriendo).
3. En otra terminal: `npm run field-test:email` (deja esta corriendo
   también — es el worker).

Vas a ver:
```
[email-worker] Conectado como tu_correo@gmail.com. Vigilando INBOX por correos con asunto "RUTA"...
[email-worker] API de rutas: http://localhost:3000
```

## Cómo usarlo desde el celular

Desde tu teléfono, manda un correo **a tu misma cuenta de Gmail** (el
worker solo procesa correos que vienen de tu propia dirección, por
seguridad), con:

**Asunto:** algo que contenga la palabra `RUTA` (ej. "RUTA prueba 1")

**Cuerpo:**
```
origen: Río Becerra 129, Col. 8 de Agosto, CDMX
destino: ESCOM, Zacatenco, CDMX
hora: 15:00
```

- `hora` es opcional (24h, hora CDMX) — si la omites, calcula "ahora mismo".
- También puedes poner coordenadas directas en vez de texto, si ya
  tienes el pin de Google Maps: `origen: 19.3910,-99.1845`.

El worker responde en el mismo hilo, normalmente en unos segundos
(viajes cortos, ≤6km) o **20-25 segundos para viajes largos** (>6km,
tier de distancia larga — es esperado, ver
`docs/handoff/03-algoritmo.md` sección 12, no es que se haya trabado).

## Limitaciones conocidas, a propósito

- **Geocodificación vía Nominatim (OpenStreetMap), gratis, sin API key.**
  No siempre acierta con direcciones ambiguas o mal escritas — si la
  respuesta trae un lugar muy distinto al que esperabas, revisa la línea
  `-> geocodificado: ...` de la respuesta y ajusta el texto (agrega
  colonia/alcaldía, o usa coordenadas directas).
- **Solo procesa correos desde tu propia cuenta con "RUTA" en el
  asunto.** Cualquier otro correo se ignora — es la única capa de
  seguridad, no hay autenticación adicional.
- **El worker tiene que estar corriendo en tu laptop encendida** con
  internet. Si cierras la terminal o apagas la laptop, no hay quien
  responda.
- No maneja HTML enriquecido en la respuesta, solo texto plano.
