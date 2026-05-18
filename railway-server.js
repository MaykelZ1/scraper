const express = require('express');
const { chromium } = require('playwright-core');
const cors = require('cors');

const app = express();
app.use(cors());

async function withBrowser(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-ES,es;q=0.9" });
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

// GET /api/servers?title=Avatar
app.get('/api/servers', async (req, res) => {
  const title = req.query.title;
  if (!title) return res.status(400).json({ error: 'Falta title' });

  try {
    const data = await withBrowser(async (page) => {
      // Buscar en AllPelículas
      await page.goto(`https://allpeliculas.la/search/${encodeURIComponent(title)}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);

      const html = await page.content();
      const $ = require('cheerio').load(html);

      // Extraer primer resultado
      const linkEl = $('article.cc-post a[href*="/peliculas/"]').first() || $('a[href*="/peliculas/"]').first();
      const href = linkEl?.attr('href');
      if (!href) return { servers: [], error: 'Sin resultados' };

      const url = href.startsWith('http') ? href : 'https://allpeliculas.la' + href;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(4000);

      const getIframe = () => page.evaluate(() => {
        const f = document.querySelector('iframe[src]');
        return f ? f.src : null;
      });

      const clickAndGet = async (name) => {
        try {
          await page.click(`button:has-text("${name}")`, { timeout: 3000 });
          await page.waitForTimeout(2000);
          return getIframe();
        } catch { return null; }
      };

      const names = await page.evaluate(() => {
        const n = [];
        document.querySelectorAll('button.btn span').forEach(s => {
          const t = s.textContent.trim().toLowerCase();
          if (t && !t.includes('trailer') && !t.includes('luces') && !t.includes('películ') && !t.includes('serie') && !t.includes('anime') && !t.includes('géneros') && !n.find(x => x.toLowerCase() === t))
            n.push(s.textContent.trim());
        });
        return n;
      });

      const servers = [];
      let last = null;

      for (const name of names) {
        const loaded = getIframe();
        if (loaded && loaded !== last) { servers.push({ name, url: loaded, type: 'streaming' }); last = loaded; }

        const next = await clickAndGet(name);
        if (next && next !== last) { servers.push({ name, url: next, type: 'streaming' }); last = next; }
      }

      // Descargas
      const downloads = await page.evaluate(() => {
        const r = [];
        document.querySelectorAll('a[href*="magnet:"], a[href*="torrent"], a[href*="1fichier"], a[href*="mediafire"], a[href*="mega"], a[href*="megaup"]').forEach(a => {
          const h = a.getAttribute('href');
          if (h) r.push({ name: a.textContent.trim() || 'Descargar', url: h, type: 'download' });
        });
        return r;
      });
      servers.push(...downloads);

      const meta = await page.evaluate(() => ({
        title: document.querySelector('h1')?.textContent?.trim() || '',
        poster: document.querySelector('img[class*="cover"]')?.src || '',
        desc: document.querySelector('p[class*="desc"]')?.textContent?.trim() || ''
      }));

      return { ...meta, servers };
    });

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('OK'));
