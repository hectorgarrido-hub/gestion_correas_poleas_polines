# Gestión de Correas, Poleas y Polines — CMP

Tablero operacional para el seguimiento del estado de **poleas** (y polines) por
proceso y correa: última fecha de cambio, días transcurridos, TBO, órdenes y avisos.

## Estructura

| Ruta | Descripción |
|---|---|
| `index.html` | Aplicación desplegable en **un solo archivo** (React + Babel + datos embebidos). Es lo que se publica. |
| `codigo-fuente/dashboard.html` | Fuente modular y legible de la misma app (más cómoda para editar). |
| `codigo-fuente/poleas-data.js` | Datos base de poleas por proceso / correa (`window.POLEAS_DATA`). |
| `codigo-fuente/polines-data.js` | Estructura base de polines (`window.POLINES_DATA`); los hallazgos viven en Supabase. |
| `codigo-fuente/shared.css` | Sistema de diseño (tokens de color, tipografía y espaciado). |
| `supabase/functions/enviar-resumen-criticos/` | Edge Function que envía el resumen de críticos. |

La aplicación funciona en modo **demo** (localStorage) o **en línea** (Supabase),
según estén definidas `SUPABASE_URL` y `SUPABASE_ANON_KEY`.

## Cómo ejecutar

- **`index.html`**: se abre directo en el navegador (todo va embebido) o se sube tal cual al hosting.
- **`codigo-fuente/dashboard.html`**: necesita a su lado `poleas-data.js`, `polines-data.js` y
  `shared.css`, y React/Babel desde CDN. Sírvelo con un servidor estático:

```bash
cd codigo-fuente
python3 -m http.server 8000
# luego abre http://localhost:8000/dashboard.html
```
