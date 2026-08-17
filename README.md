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

## Diagrama de poleas — mejora visual

El diagrama esquemático de cada correa se rediseñó para que se entienda de un vistazo:

- **Tamaño uniforme.** Antes la polea motriz se dibujaba más grande (r=18 vs r=13),
  lo que sugería una importancia o criticidad que no existía. Ahora todas las poleas
  usan el mismo radio.
- **Símbolo reconocible.** Cada polea es una **rueda** (aro + pernos de brida + número
  al centro), no un círculo abstracto.
- **Tipo rotulado.** Bajo cada rueda va un código de tipo de 3 letras (`MOT`, `DEF`,
  `TEN`, `COL`, `QUI`, `CPE`, `ENV`); el nombre completo aparece en el tooltip.
- **La motriz se distingue por rol, no por tamaño**, mediante un doble aro y su etiqueta.
- **La correa se ve como correa:** una banda recorre las poleas en su orden.
- **Escala adaptativa por correa.** El tamaño de rueda y de los textos se calcula desde la
  separación real entre poleas (`layoutDiag`), y las correas de perfil plano se reparten con
  paso constante y centrado. Así una correa de 2 poleas y otra de 12 se ven proporcionadas,
  sin huecos ni etiquetas que se solapan. Dentro de una misma correa todas las poleas son iguales.
- **Antigüedad compacta** (`15a`, `133d`) bajo cada rueda; el detalle exacto va en el tooltip.
- **Leyenda** que explica el símbolo y los colores (verde = cambiada, rojo = sin cambio).

El diagrama vive en los componentes `Diagram`, `Wheel` y el auxiliar `layoutDiag`, presentes
tanto en `index.html` como en `codigo-fuente/dashboard.html`.

## Tipografía de navegación

Las pestañas de proceso, las de correa, los botones de vista/filtro y las tablas comparten
tres tokens de tamaño, para que todo lea como un mismo sistema:

| Token | Tamaño | Uso |
|---|---|---|
| `--fs-nav` | `0.80rem` (12px) | Pestañas de proceso y de correa, botones de vista y de filtro, texto de tablas. |
| `--fs-caps` | `0.667rem` (10px) | Etiquetas en mayúscula (p. ej. «FEEDERS», cabeceras de tabla). |
| `--fs-chip` | `0.733rem` (11px) | Chips y celdas de datos (belt-chip, heatmap, botones utilitarios). |

Proceso y correa usan el mismo tamaño; la jerarquía la dan el estilo (píldora vs. subrayado)
y el peso del elemento activo, no el tamaño.

## Resumen por correa

Para priorizar de un vistazo sin abrir cada correa:

- **Barra de chips** en la cabecera de la correa (sobre el diagrama): total de poleas,
  cuántas **cambiadas** (verde), cuántas **sin cambio** (rojo), la **más antigua** (ámbar)
  y el **TBO** (con «· en Xa Yd» o «· VENCIDO» en rojo si corresponde).
- **Contador en la pestaña**: cada pestaña de correa muestra un globo rojo con el número de
  poleas sin cambio (`beltBadge` / `beltSinCambio`), para detectar las correas pendientes
  antes de entrar.

Los conteos salen de `mergePolea`, por lo que reflejan los cambios registrados en Supabase,
no solo los datos base.

## Despliegue en Netlify

El sitio es **estático** (el `index.html` lleva todo embebido), así que no hay build.

**Opción A — Conectar el repositorio (despliegue continuo):**
1. En Netlify: *Add new site → Import an existing project → GitHub* y elige este repositorio.
2. Deja *Build command* vacío y *Publish directory* en `.` (ya viene en `netlify.toml`).
3. *Deploy*. Cada cambio en la rama publicada se re-despliega solo.

**Opción B — Arrastrar y soltar (rápido, sin git):**
1. Descarga `index.html`.
2. Ve a <https://app.netlify.com/drop> y arrastra el archivo (o una carpeta que lo contenga).

En ambos casos Netlify entrega una URL pública (`https://<nombre>.netlify.app`) que puedes compartir.
