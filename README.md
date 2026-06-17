# Buscador de Empresas — M-AR & Asociados

Herramienta de prospección comercial: busca empresas por ciudad y rubro (Google Maps o IA), enriquece cada una buscando email/WhatsApp en su sitio web, las puntúa (A/B/C) y permite contactarlas por WhatsApp o email en lote. Guarda un archivo de lo ya enviado.

Este proyecto es **independiente** del Agente Integral. Va en su **propio servicio de Render**, con su propia URL.

---

## Subirlo a GitHub (repo nuevo y separado)

1. En GitHub, **New repository** → nombre, por ejemplo, `buscador-empresas-mar`. Private o Public, como prefieras.
2. **uploading an existing file** → arrastrá **todo el contenido** de esta carpeta (`index.html`, `server.js`, `package.json`, `render.yaml`, `.gitignore`, `.env.example`). No arrastres la carpeta en sí, sino lo que tiene adentro, para que estos archivos queden en la raíz del repo.
3. **Commit changes**.

> Importante: no lo subas al mismo repo `agente-mar`. Si lo hacés, va a competir de nuevo con el otro `package.json` y volvemos al problema de antes.

## Crear el segundo servicio en Render

1. En Render: **New > Web Service**.
2. Conectá el repo nuevo (`buscador-empresas-mar`).
3. Render lee el `render.yaml` solo. Si te pregunta:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. En **Environment**, cargá (mínimo para que arranque):
   - `GROQ_API_KEY` → tu clave de Groq. Podés repetir la misma que usás en el Agente Integral, o usar otra distinta.
   - Opcional: `GROQ_API_KEY_2`, `_3`, `_4` → si tenés más cuentas/keys, las rota automáticamente para no quedarte sin cuota.
   - Opcional: `GOOGLE_MAPS_API_KEY` → si la tenés, el buscador te da datos reales (teléfonos y webs verificados). Sin ella, todo lo que pidas con "Fuente: Google Maps" cae automáticamente a generar con IA.
5. **Create Web Service**.

Te queda online en su propia URL, por ejemplo `https://buscador-empresas-mar.onrender.com`, sin tocar nada del Agente Integral.

---

## Qué cambié respecto a la versión que tenías

- Renombré `server-2.js` → `server.js` (más prolijo, y es lo que `package.json` espera).
- En el HTML, el selector "Fuente de datos" (Maps / IA) antes no se enviaba al backend — siempre pedía Maps aunque elijieras IA. Ahora si elegís "IA (datos estimados)" se respeta esa elección.
- Agregué `.env.example` y `render.yaml` para que el deploy sea repetible.

Todo lo demás —diseño, plantillas de WhatsApp/email, exportar a CSV, archivo de contactos enviados, scoring A/B/C— queda exactamente igual a como lo tenías.

## Atención: persistencia

Al igual que con el Agente Integral, en el plan gratuito de Render el archivo `contactos-enviados.json` se reinicia con cada deploy nuevo del código (no con cada uso, solo cuando subís cambios). Si te importa conservar ese historial a largo plazo, avisame y lo pasamos a una base persistente como hicimos con los leads del otro agente.
