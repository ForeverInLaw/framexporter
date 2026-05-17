import * as cheerio from "cheerio";

export class SitemapDiscoverer {
  async discover(startUrl: URL): Promise<string[]> {
    const sitemapUrl = new URL("/sitemap.xml", startUrl.origin);

    try {
      const response = await fetch(sitemapUrl, { redirect: "follow" });
      if (!response.ok) {
        return [];
      }

      const xml = await response.text();
      return this.#parse(xml, startUrl.origin);
    } catch {
      return [];
    }
  }

  #parse(xml: string, origin: string): string[] {
    const $ = cheerio.load(xml, { xmlMode: true });
    const urls = new Set<string>();

    $("url > loc").each((_, element) => {
      const rawUrl = $(element).text().trim();
      if (!rawUrl) {
        return;
      }

      const url = new URL(rawUrl);
      if (url.origin === origin && /^https?:$/i.test(url.protocol)) {
        url.hash = "";
        urls.add(url.toString());
      }
    });

    return [...urls];
  }
}
