type NasaSearchData = {
  nasa_id?: unknown;
  title?: unknown;
  description?: unknown;
  description_508?: unknown;
  date_created?: unknown;
  center?: unknown;
  photographer?: unknown;
  secondary_creator?: unknown;
  keywords?: unknown;
  instrument?: unknown;
  instrument_name?: unknown;
};

type NasaSearchItem = {
  data?: NasaSearchData[];
  links?: Array<{ href?: unknown; render?: unknown; rel?: unknown }>;
};

function clean(value: unknown, limit = 1200) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}

function missionFor(data: NasaSearchData) {
  const keywords = Array.isArray(data.keywords) ? data.keywords.join(" ") : clean(data.keywords, 500);
  const text = [
    clean(data.title, 300),
    clean(data.description, 1200),
    clean(data.center, 120),
    keywords,
  ].join(" ").toLowerCase();

  if (/james webb|\bjwst\b/.test(text)) return "JWST";
  if (/hubble/.test(text)) return "Hubble";
  return clean(data.center, 120) || "NASA Observatory";
}

function normalizeItem(raw: NasaSearchItem) {
  const data = Array.isArray(raw.data) ? raw.data[0] : undefined;
  if (!data) return null;

  const nasaId = clean(data.nasa_id, 160);
  const title = clean(data.title, 240);
  const imageLink = Array.isArray(raw.links)
    ? raw.links.find((link) =>
        typeof link?.href === "string" &&
        link.href.startsWith("http") &&
        (link.render === "image" || /\.(jpe?g|png|webp)(\?|$)/i.test(link.href))
      )
    : undefined;
  const thumbnailUrl = typeof imageLink?.href === "string" ? imageLink.href : "";

  if (!nasaId || !title || !thumbnailUrl) return null;

  const instrumentValue = data.instrument ?? data.instrument_name;
  const instrument = clean(instrumentValue, 160) || null;
  const center = clean(data.center, 160) || null;
  const credit =
    clean(data.photographer, 180) ||
    clean(data.secondary_creator, 180) ||
    center ||
    "NASA";

  return {
    id: `nasa:${nasaId}`,
    nasaId,
    title,
    description: clean(data.description || data.description_508, 1800),
    dateCreated: clean(data.date_created, 80) || null,
    mission: missionFor(data),
    instrument,
    center,
    credit,
    thumbnailUrl,
    sourceUrl: `https://images.nasa.gov/details/${encodeURIComponent(nasaId)}`,
  };
}

async function searchNasa(query: string) {
  const url = new URL("https://images-api.nasa.gov/search");
  url.searchParams.set("q", query);
  url.searchParams.set("media_type", "image");
  url.searchParams.set("page_size", "20");

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": "WorldSelect/0.8 (+https://world-select.pages.dev)",
    },
    cf: { cacheTtl: 3600, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });

  if (!response.ok) throw new Error(`NASA Images HTTP ${response.status}`);
  const payload = await response.json() as {
    collection?: { items?: NasaSearchItem[] };
  };
  return Array.isArray(payload.collection?.items) ? payload.collection.items : [];
}

function searchQueries(source: string, query: string) {
  const q = clean(query, 120);
  if (q) {
    if (source === "jwst") return [`James Webb Space Telescope ${q}`];
    if (source === "hubble") return [`Hubble Space Telescope ${q}`];
    if (source === "observatory") return [`observatory telescope ${q}`];
    return [q];
  }

  if (source === "jwst") return ["James Webb Space Telescope"];
  if (source === "hubble") return ["Hubble Space Telescope"];
  if (source === "observatory") return ["observatory telescope"];
  return [
    "James Webb Space Telescope",
    "Hubble Space Telescope",
    "observatory telescope",
  ];
}

async function resolveAsset(nasaId: string) {
  const url = `https://images-api.nasa.gov/asset/${encodeURIComponent(nasaId)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "WorldSelect/0.8 (+https://world-select.pages.dev)",
    },
    cf: { cacheTtl: 86400, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });

  if (!response.ok) return null;
  const payload = await response.json() as {
    collection?: { items?: Array<{ href?: unknown }> };
  };
  const urls = (payload.collection?.items ?? [])
    .map((item) => typeof item.href === "string" ? item.href : "")
    .filter((href) => /^https?:\/\//.test(href) && /\.(jpe?g|png|webp)(\?|$)/i.test(href));

  const rank = (href: string) => {
    const value = href.toLowerCase();
    if (value.includes("~large")) return 5;
    if (value.includes("~medium")) return 4;
    if (value.includes("~orig")) return 3;
    if (value.includes("~small")) return 2;
    if (value.includes("~thumb")) return 1;
    return 0;
  };

  return urls.sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

export const onRequestGet = async (context: any) => {
  const url = new URL(context.request.url);
  const asset = clean(url.searchParams.get("asset"), 180);
  if (asset) {
    try {
      const imageUrl = await resolveAsset(asset);
      return json({ imageUrl, nasaId: asset, source: "NASA Image and Video Library" }, imageUrl ? 200 : 404);
    } catch {
      return json({ imageUrl: null, nasaId: asset, error: "NASA asset unavailable" }, 502);
    }
  }

  const rawSource = clean(url.searchParams.get("source"), 32).toLowerCase();
  const source = ["jwst", "hubble", "observatory"].includes(rawSource) ? rawSource : "all";
  const query = clean(url.searchParams.get("q"), 120);
  const queries = searchQueries(source, query);

  const settled = await Promise.allSettled(queries.map(searchNasa));
  const successful = settled.filter((result) => result.status === "fulfilled");
  if (!successful.length) {
    return json({
      items: [],
      source: "NASA Image and Video Library",
      dataAsOf: new Date().toISOString(),
      degraded: true,
      error: "NASA image source unavailable",
    }, 502);
  }

  const unique = new Map<string, ReturnType<typeof normalizeItem>>();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const raw of result.value) {
      const item = normalizeItem(raw);
      if (item && !unique.has(item.nasaId)) unique.set(item.nasaId, item);
    }
  }

  const items = Array.from(unique.values()).filter(Boolean).slice(0, 24);
  return json({
    items,
    count: items.length,
    source: "NASA Image and Video Library",
    dataAsOf: new Date().toISOString(),
    degraded: settled.some((result) => result.status === "rejected"),
    sourceUrl: "https://images.nasa.gov/",
  });
};
