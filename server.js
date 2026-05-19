const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright-core");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Playwright: rutas para Render/containers ──────────────────────
// playwright-core no empaqueta navegadores — hay que instalarlos en el build :
//   npx playwright install chromium
// Render guarda el navegador en una de estas rutas según la versión:
process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/render/.cache/ms-playwright";

async function withBrowser(fn) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
    ],
  });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    "Accept-Language": "es-ES,es;q=0.9",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  try {
    return await fn(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── GET /api/allpeliculas-servers?title=<titulo> ─────────────────
// Devuelve todos los servidores de streaming de AllPelículas
app.get("/api/allpeliculas-servers", async (req, res) => {
  const title = req.query.title;
  if (!title) return res.status(400).json({ error: "Falta el parámetro title" });

  try {
    const data = await withBrowser(async (page) => {
      const searchUrl = `https://allpeliculas.la/search/${encodeURIComponent(title)}`;
      console.log("[AllPelículas] Buscando:", searchUrl);

      await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(3000);

      // Extraer primer resultado SIN cheerio — todo en page.evaluate
      const result = await page.evaluate(() => {
        const article = document.querySelector("article.cc-post a");
        if (!article) return { link: null, error: "No se encontraron resultados" };
        return { link: article.getAttribute("href"), error: null };
      });

      if (result.error || !result.link) return { servers: [], error: result.error || "Sin resultados" };

      const detailUrl = result.link.startsWith("http")
        ? result.link
        : `https://allpeliculas.la${result.link}`;
      console.log("[AllPelículas] Abriendo:", detailUrl);

      await page.goto(detailUrl, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(4000);

      // Extraer TODO en un solo evaluate para máxima eficiencia
      const extracted = await page.evaluate(() => {
        const servers = [];
        const seen = new Set();

        // Obtener iframe inicial
        const getIframeSrc = () => {
          const f = document.querySelector("iframe[src]");
          return f ? f.src : null;
        };

        // Obtener nombres de botones de servidor
        const names = [];
        document.querySelectorAll("button.btn span").forEach((s) => {
          const t = s.textContent.trim().toLowerCase();
          const skip = ["trailer", "luces", "películas", "series", "animes", "géneros"];
          if (t && !skip.some((kw) => t.includes(kw)) && !names.find((x) => x.toLowerCase() === t))
            names.push(s.textContent.trim());
        });

        // Capturar iframe inicial
        const initial = getIframeSrc();
        if (initial && !seen.has(initial)) {
          seen.add(initial);
          servers.push({ name: names[0] || "Servidor 1", url: initial, type: "streaming" });
        }

        // Clickear cada botón y capturar el iframe resultante
        for (const name of names) {
          try {
            document.querySelector(`button:has-text("${name}")`)?.click();
            // Esperar 2s por si el iframe cambia
            await new Promise(r => setTimeout(r, 2000));
            const src = getIframeSrc();
            if (src && !seen.has(src)) {
              seen.add(src);
              servers.push({ name, url: src, type: "streaming" });
            }
          } catch {
            // Botón sin iframe o ya clickeado
          }
        }

        // Capturar todos los iframes como fallback
        document.querySelectorAll("iframe[src]").forEach((f) => {
          const src = f.src;
          if (src && !seen.has(src)) {
            seen.add(src);
            const host = src.split("/")[2] || "Servidor";
            servers.push({ name: host, url: src, type: "streaming" });
          }
        });

        // Enlaces de descarga
        const downloads = [];
        document
          .querySelectorAll('a[href*="magnet:"],a[href*="torrent"],a[href*="1fichier"],a[href*="mediafire"],a[href*="mega"],a[href*="megaup"]')
          .forEach((a) => {
            const h = a.getAttribute("href");
            if (h) downloads.push({ name: a.textContent.trim() || "Descargar", url: h, type: "download" });
          });
        servers.push(...downloads);

        // Metadata
        const title = document.querySelector("h1")?.textContent?.trim() || "";
        const poster = document.querySelector("img[class*='cover'], img[class*='poster']")?.src || "";
        const desc = document.querySelector("p[class*='desc'], .description, [class*='content']")?.textContent?.trim() || "";

        return { title, poster, desc, servers };
      });

      console.log("[AllPelículas] Servidores encontrados:", extracted.servers.length);
      return extracted;
    });

    // Incluye servers si data es undefined (caso edge)
    const payload = data || { servers: [] };
    res.json(payload);
  } catch (e) {
    console.error("[AllPelículas] Error:", e);
    console.error("[AllPelículas] Stack:", e.stack);
    res.status(500).json({ error: e.message, servers: [] });
  }
});

// ─── Servir archivos estáticos (el HTML del frontend) ──────────────
app.use(express.static("."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("OK puerto", PORT));
