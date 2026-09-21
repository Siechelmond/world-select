type TelescopeFilter =
  | "all"
  | "jwst"
  | "hubble"
  | "other"
  | "solar-system"
  | "galaxies"
  | "nebulae"
  | "stars-clusters";

type TelescopeSubject = "solar-system" | "galaxies" | "nebulae" | "stars-clusters" | "other";
type TelescopeProviderId = "nasa-images" | "esa-webb" | "hubble-science";

type TelescopeItem = {
  id: string;
  sourceId: string;
  providerId: TelescopeProviderId;
  provider: string;
  title: string;
  description: string;
  dateCreated: string | null;
  telescope: string;
  instrument: string | null;
  subject: TelescopeSubject;
  sourceOrganizations: string[];
  credit: string;
  thumbnailUrl: string;
  highResUrl: string | null;
  sourceUrl: string;
  rights: string | null;
  observationType: string | null;
};

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

const HARDWARE_REJECT =
  /\b(spacecraft|telescope in orbit|servicing|astronaut|mirror segment|primary mirror|launch|rocket|space shuttle|deployment|deployed|technician|clean room|assembly|sunshield|observatory building|mission control|control room|engineering model|hardware|artist'?s concept|artist concept|illustration|diagram|graphic|chart)\b/i;

const CELESTIAL_SIGNAL =
  /\b(galax(?:y|ies)|nebula(?:e)?|star(?:s)?|stellar|cluster|planet|moon|comet|asteroid|supernova|remnant|black hole|quasar|deep field|exoplanet|aurora|cosmos|cosmic|interstellar|jupiter|saturn|uranus|neptune|mars|venus|mercury|pluto|carina|orion|magellanic|ngc\s*\d+|messier\s*\d+|m\s*\d+|ic\s*\d+|abell\s*\d+|arp\s*\d+)\b/i;

const KNOWN_TELESCOPE =
  /\b(jwst|james webb|hubble|spitzer|chandra|kepler|tess|wise|galex|swift|fermi|roman|euclid)\b/i;

function clean(value: unknown, limit = 2400) {
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

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtml(value: string, limit = 12000) {
  return clean(
    decodeHtml(
      value
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
    limit,
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function metaContent(html: string, key: string) {
  const escaped = escapeRegExp(key);
  const patterns = [
    new RegExp('<meta[^>]+(?:property|name)=["\\\']' + escaped + '["\\\'][^>]+content=["\\\']([^"\\\']+)["\\\'][^>]*>', "i"),
    new RegExp('<meta[^>]+content=["\\\']([^"\\\']+)["\\\'][^>]+(?:property|name)=["\\\']' + escaped + '["\\\'][^>]*>', "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return clean(decodeHtml(match[1]), 4000);
  }
  return "";
}

function absoluteUrl(base: string, href: string) {
  try {
    return new URL(decodeHtml(href), base).toString();
  } catch {
    return "";
  }
}

function canonicalUrl(html: string, fallback: string) {
  const match = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i)
    ?? html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i);
  return match?.[1] ? absoluteUrl(fallback, match[1]) : fallback;
}

function anchors(html: string, base: string) {
  const items: Array<{ href: string; text: string }> = [];
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const href = absoluteUrl(base, match[1]);
    if (!href) continue;
    items.push({ href, text: stripHtml(match[2], 500) });
  }
  return items;
}

async function fetchText(url: string, cacheTtl = 21600) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "WorldSelect/0.9 (+https://world-select.pages.dev)",
    },
    cf: { cacheTtl, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
  return response.text();
}

function telescopeForText(text: string) {
  if (/\b(james webb|jwst|webb space telescope)\b/i.test(text)) return "James Webb Space Telescope";
  if (/\bhubble\b/i.test(text)) return "Hubble Space Telescope";
  if (/\bchandra\b/i.test(text)) return "Chandra X-ray Observatory";
  if (/\bspitzer\b/i.test(text)) return "Spitzer Space Telescope";
  if (/\bkepler\b/i.test(text)) return "Kepler Space Telescope";
  if (/\btess\b/i.test(text)) return "TESS";
  if (/\bwise\b/i.test(text)) return "WISE";
  if (/\bgalex\b/i.test(text)) return "GALEX";
  if (/\bswift\b/i.test(text)) return "Neil Gehrels Swift Observatory";
  if (/\bfermi\b/i.test(text)) return "Fermi Gamma-ray Space Telescope";
  if (/\beuclid\b/i.test(text)) return "Euclid";
  if (/\broman\b/i.test(text)) return "Nancy Grace Roman Space Telescope";
  return "Space telescope";
}

function instrumentForText(text: string) {
  const matches = [
    ["NIRCam", /\bnircam\b/i],
    ["MIRI", /\bmiri\b/i],
    ["NIRSpec", /\bnirspec\b/i],
    ["NIRISS", /\bniriss\b/i],
    ["WFC3", /\b(?:wfc3|wide field camera 3)\b/i],
    ["ACS", /\b(?:acs|advanced camera for surveys)\b/i],
    ["WFPC2", /\bwfpc2\b/i],
    ["NICMOS", /\bnicmos\b/i],
    ["STIS", /\bstis\b/i],
    ["COS", /\bcos\b/i],
  ].filter(([, pattern]) => (pattern as RegExp).test(text)).map(([name]) => name as string);
  return matches.length ? matches.join(" + ") : null;
}

function classifySubject(text: string): TelescopeSubject {
  if (/\b(jupiter|saturn|uranus|neptune|mars|venus|mercury|pluto|moon|comet|asteroid|solar system|kuiper)\b/i.test(text)) {
    return "solar-system";
  }
  if (/\b(nebula|supernova remnant|stellar nursery|star-forming region)\b/i.test(text)) return "nebulae";
  if (/\b(star cluster|globular cluster|open cluster|stellar cluster)\b/i.test(text)) return "stars-clusters";
  if (/\b(galaxy|galaxies|deep field|quasar|black hole|abell|arp\s*\d+)\b/i.test(text)) return "galaxies";
  return "other";
}

function organizationsFromCredit(credit: string, fallback: string[]) {
  const known = [
    ["NASA", /\bnasa\b/i],
    ["ESA/Webb", /\besa\/webb\b/i],
    ["ESA", /\besa\b/i],
    ["CSA", /\bcsa\b/i],
    ["STScI", /\bstsci\b/i],
    ["ESA/Hubble", /\besa\/hubble\b/i],
  ] as const;
  const found: string[] = [];
  for (const [name, pattern] of known) {
    if (pattern.test(credit) && !found.includes(name)) found.push(name);
  }
  return found.length ? found : fallback;
}

function textMatchesQuery(item: Pick<TelescopeItem, "title" | "description" | "credit" | "instrument" | "telescope">, query: string) {
  const q = clean(query, 120).toLowerCase();
  if (!q) return true;
  const haystack = [item.title, item.description, item.credit, item.instrument, item.telescope].join(" ").toLowerCase();
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

function acceptsFilter(item: TelescopeItem, filter: TelescopeFilter) {
  if (filter === "all") return true;
  if (filter === "jwst") return item.telescope === "James Webb Space Telescope";
  if (filter === "hubble") return item.telescope === "Hubble Space Telescope";
  if (filter === "other") {
    return item.telescope !== "James Webb Space Telescope" && item.telescope !== "Hubble Space Telescope";
  }
  return item.subject === filter;
}

function nasaSearchQueries(filter: TelescopeFilter, query: string) {
  const q = clean(query, 120);
  if (q) {
    if (filter === "jwst") return ["JWST " + q, "James Webb " + q];
    if (filter === "hubble") return ["Hubble " + q];
    if (filter === "other") return ["Chandra " + q, "Spitzer " + q];
    return [q];
  }

  if (filter === "jwst") return ["JWST galaxy", "JWST nebula", "JWST star cluster", "JWST planet"];
  if (filter === "hubble") return ["Hubble galaxy", "Hubble nebula", "Hubble star cluster", "Hubble planet"];
  if (filter === "other") return ["Chandra galaxy", "Spitzer nebula", "Spitzer galaxy"];
  if (filter === "galaxies") return ["galaxy JWST", "galaxy Hubble"];
  if (filter === "nebulae") return ["nebula JWST", "nebula Hubble"];
  if (filter === "stars-clusters") return ["star cluster JWST", "star cluster Hubble"];
  if (filter === "solar-system") return ["planet Hubble", "planet JWST"];
  return ["JWST galaxy", "Hubble nebula", "Hubble star cluster"];
}

async function searchNasa(query: string) {
  const url = new URL("https://images-api.nasa.gov/search");
  url.searchParams.set("q", query);
  url.searchParams.set("media_type", "image");
  url.searchParams.set("page_size", "20");

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": "WorldSelect/0.9 (+https://world-select.pages.dev)",
    },
    cf: { cacheTtl: 3600, cacheEverything: true },
  } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });

  if (!response.ok) throw new Error("NASA Images HTTP " + response.status);
  const payload = await response.json() as {
    collection?: { items?: NasaSearchItem[] };
  };
  return Array.isArray(payload.collection?.items) ? payload.collection.items : [];
}

function normalizeNasaItem(raw: NasaSearchItem, filter: TelescopeFilter): TelescopeItem | null {
  const data = Array.isArray(raw.data) ? raw.data[0] : undefined;
  if (!data) return null;

  const sourceId = clean(data.nasa_id, 160);
  const title = clean(data.title, 260);
  const description = clean(data.description || data.description_508, 2400);
  const keywords = Array.isArray(data.keywords) ? data.keywords.map((value) => clean(value, 120)).join(" ") : clean(data.keywords, 700);
  const center = clean(data.center, 200);
  const instrumentRaw = clean(data.instrument ?? data.instrument_name, 220);
  const observationText = [title, keywords, description, center, instrumentRaw].join(" ");

  const imageLink = Array.isArray(raw.links)
    ? raw.links.find((link) =>
        typeof link?.href === "string"
        && link.href.startsWith("http")
        && (link.render === "image" || /\.(jpe?g|png|webp)(\?|$)/i.test(link.href))
      )
    : undefined;
  const thumbnailUrl = typeof imageLink?.href === "string" ? imageLink.href : "";

  if (!sourceId || !title || !thumbnailUrl) return null;
  if (HARDWARE_REJECT.test(title)) return null;
  if (!CELESTIAL_SIGNAL.test(title + " " + keywords)) return null;
  if (!KNOWN_TELESCOPE.test(observationText)) return null;

  const telescope = telescopeForText(observationText);
  if (filter === "jwst" && telescope !== "James Webb Space Telescope") return null;
  if (filter === "hubble" && telescope !== "Hubble Space Telescope") return null;
  if (filter === "other" && (telescope === "James Webb Space Telescope" || telescope === "Hubble Space Telescope")) return null;

  const subject = classifySubject(observationText);
  if (["solar-system", "galaxies", "nebulae", "stars-clusters"].includes(filter) && subject !== filter) return null;

  const credit = clean(data.photographer, 300)
    || clean(data.secondary_creator, 300)
    || center
    || "NASA";

  return {
    id: "nasa:" + sourceId,
    sourceId,
    providerId: "nasa-images",
    provider: "NASA Image and Video Library",
    title,
    description,
    dateCreated: clean(data.date_created, 100) || null,
    telescope,
    instrument: instrumentRaw || instrumentForText(observationText),
    subject,
    sourceOrganizations: organizationsFromCredit(credit, ["NASA"]),
    credit,
    thumbnailUrl,
    highResUrl: null,
    sourceUrl: "https://images.nasa.gov/details/" + encodeURIComponent(sourceId),
    rights: "NASA media usage guidance applies; preserve item-specific credits and third-party notices.",
    observationType: "Astronomical observation",
  };
}

async function loadNasaImages(filter: TelescopeFilter, query: string) {
  const queries = nasaSearchQueries(filter, query).slice(0, 4);
  const settled = await Promise.allSettled(queries.map(searchNasa));
  const items = new Map<string, TelescopeItem>();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const raw of result.value) {
      const item = normalizeNasaItem(raw, filter);
      if (item && textMatchesQuery(item, query) && !items.has(item.id)) items.set(item.id, item);
    }
  }
  if (!settled.some((result) => result.status === "fulfilled")) throw new Error("NASA Images unavailable");
  return { source: "NASA Image and Video Library", items: Array.from(items.values()).slice(0, 12) };
}

async function resolveNasaAsset(sourceId: string) {
  const url = "https://images-api.nasa.gov/asset/" + encodeURIComponent(sourceId);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "WorldSelect/0.9 (+https://world-select.pages.dev)",
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
    if (value.includes("~large")) return 6;
    if (value.includes("~orig")) return 5;
    if (value.includes("~medium")) return 4;
    if (value.includes("~small")) return 2;
    if (value.includes("~thumb")) return 1;
    return 3;
  };

  return urls.sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

const ESA_ARCHIVE: Record<string, string> = {
  "galaxies": "https://esawebb.org/images/archive/category/galaxies/?sort=-release_date",
  "nebulae": "https://esawebb.org/images/archive/category/nebulae/?sort=-release_date",
  "stars-clusters": "https://esawebb.org/images/archive/category/stars/?sort=-release_date",
  "solar-system": "https://esawebb.org/images/archive/category/solarsystem/?sort=-release_date",
  "all": "https://esawebb.org/images/?sort=-release_date",
};

function esaArchiveFor(filter: TelescopeFilter) {
  if (filter === "galaxies" || filter === "nebulae" || filter === "stars-clusters" || filter === "solar-system") {
    return ESA_ARCHIVE[filter];
  }
  return ESA_ARCHIVE.all;
}

function esaDetailLinks(html: string, base: string) {
  const unique = new Set<string>();
  for (const item of anchors(html, base)) {
    try {
      const url = new URL(item.href);
      const parts = url.pathname.split("/").filter(Boolean);
      if (!url.hostname.endsWith("esawebb.org")) continue;
      if (parts.length !== 2 || parts[0] !== "images" || parts[1] === "archive") continue;
      unique.add(url.origin + "/images/" + parts[1] + "/");
    } catch {}
  }
  return Array.from(unique);
}

function extractEsaCredit(text: string) {
  const match = text.match(/Credit:\s*(.+?)(?=\s+(?:About the Image|Usage of ESA\/Hubble\/Webb Images and Videos|Are you a journalist\?))/i);
  return clean(match?.[1], 900) || "ESA/Webb";
}

function extractEsaField(text: string, label: string, stops: string[]) {
  const pattern = new RegExp(
    escapeRegExp(label) + "\\s*:\\s*(.+?)(?=\\s+(?:" + stops.map(escapeRegExp).join("|") + ")\\s*:|$)",
    "i",
  );
  return clean(text.match(pattern)?.[1], 500);
}

async function normalizeEsaDetail(url: string, requestedSubject: TelescopeSubject | null, query: string): Promise<TelescopeItem | null> {
  const html = await fetchText(url, 43200);
  const text = stripHtml(html);
  const type = extractEsaField(text, "Type", ["Release date", "Related releases", "Size", "Image Formats"]);
  if (type.toLowerCase() !== "observation") return null;

  const title = metaContent(html, "og:title").replace(/\s*\|\s*ESA\/Webb.*$/i, "").trim()
    || clean(text.match(/About the Image\s+(.+?)\s+Id:/i)?.[1], 260);
  const description = metaContent(html, "og:description");
  const image = metaContent(html, "og:image");
  if (!title || !image || HARDWARE_REJECT.test(title)) return null;

  const allText = [title, description, text.slice(0, 7000)].join(" ");
  if (!CELESTIAL_SIGNAL.test(allText)) return null;

  const credit = extractEsaCredit(text);
  const releaseDate = extractEsaField(text, "Release date", ["Related releases", "Size", "Image Formats"]);
  const sourceId = extractEsaField(text, "Id", ["Type", "Release date", "Related releases", "Size"]) || url.split("/").filter(Boolean).pop() || title;
  const pageAnchors = anchors(html, url);
  const highRes =
    pageAnchors.find((item) => /large jpeg/i.test(item.text))?.href
    || pageAnchors.find((item) => /publication jpeg/i.test(item.text))?.href
    || pageAnchors.find((item) => /fullsize original/i.test(item.text))?.href
    || image;
  const subject = requestedSubject ?? classifySubject(allText);
  const instrument = instrumentForText(allText);

  const item: TelescopeItem = {
    id: "esa-webb:" + sourceId,
    sourceId,
    providerId: "esa-webb",
    provider: "ESA/Webb",
    title,
    description,
    dateCreated: releaseDate || null,
    telescope: "James Webb Space Telescope",
    instrument,
    subject,
    sourceOrganizations: organizationsFromCredit(credit, ["ESA/Webb", "NASA", "CSA"]),
    credit,
    thumbnailUrl: image,
    highResUrl: highRes,
    sourceUrl: canonicalUrl(html, url),
    rights: "ESA/Webb usage terms apply; full original item credit must be preserved.",
    observationType: "Observation",
  };
  return textMatchesQuery(item, query) ? item : null;
}

async function loadEsaWebb(filter: TelescopeFilter, query: string) {
  if (filter === "hubble" || filter === "other") return { source: "ESA/Webb", items: [] as TelescopeItem[] };
  const archiveUrl = esaArchiveFor(filter);
  const archiveHtml = await fetchText(archiveUrl, 21600);
  const requestedSubject =
    filter === "galaxies" || filter === "nebulae" || filter === "stars-clusters" || filter === "solar-system"
      ? filter
      : null;
  const urls = esaDetailLinks(archiveHtml, archiveUrl).slice(0, 10);
  const settled = await Promise.allSettled(urls.map((url) => normalizeEsaDetail(url, requestedSubject, query)));
  const items = settled
    .filter((result): result is PromiseFulfilledResult<TelescopeItem | null> => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((item): item is TelescopeItem => Boolean(item))
    .filter((item) => acceptsFilter(item, filter))
    .slice(0, 8);
  return { source: "ESA/Webb", items };
}

const HUBBLE_GALLERY = {
  all: "https://science.nasa.gov/gallery/hubble-images/",
  nebulae: "https://science.nasa.gov/gallery/hubbles-nebulae/",
  clusters: "https://science.nasa.gov/gallery/hubbles-star-clusters/",
};

function hubbleGalleryFor(filter: TelescopeFilter) {
  if (filter === "nebulae") return HUBBLE_GALLERY.nebulae;
  if (filter === "stars-clusters") return HUBBLE_GALLERY.clusters;
  return HUBBLE_GALLERY.all;
}

function hubbleDetailLinks(html: string, base: string) {
  const unique = new Set<string>();
  for (const item of anchors(html, base)) {
    try {
      const url = new URL(item.href);
      if (url.hostname !== "science.nasa.gov") continue;
      if (!url.pathname.startsWith("/image-detail/")) continue;
      unique.add(url.origin + url.pathname);
    } catch {}
  }
  return Array.from(unique);
}

function extractHubbleCredit(text: string) {
  const match = text.match(/Image Credit:\s*(.+?)(?=\s+(?:https:\/\/science\.nasa\.gov\/image-detail\/|Download|Tags|Size|Image Credit))/i);
  return clean(match?.[1], 900) || "NASA";
}

async function normalizeHubbleDetail(url: string, requestedSubject: TelescopeSubject | null, query: string): Promise<TelescopeItem | null> {
  const html = await fetchText(url, 43200);
  const text = stripHtml(html);
  const title = metaContent(html, "og:title").replace(/\s*-\s*NASA Science.*$/i, "").trim()
    || clean(text.match(/#?\s*(.+?)\s+Image Credit:/i)?.[1], 260);
  const description = metaContent(html, "og:description");
  const image = metaContent(html, "og:image");
  if (!title || !image || HARDWARE_REJECT.test(title)) return null;

  const allText = [title, description, text.slice(0, 7000)].join(" ");
  if (!CELESTIAL_SIGNAL.test(allText)) return null;
  if (!/\bhubble\b/i.test(allText)) return null;

  const credit = extractHubbleCredit(text);
  const published = metaContent(html, "article:published_time") || metaContent(html, "article:modified_time");
  const pageAnchors = anchors(html, url);
  const download = pageAnchors.find((item) => {
    try {
      return /download/i.test(item.text) && new URL(item.href).hostname === "assets.science.nasa.gov";
    } catch {
      return false;
    }
  })?.href;
  const sourceId = url.split("/").filter(Boolean).pop() || title;
  const subject = requestedSubject ?? classifySubject(allText);
  const item: TelescopeItem = {
    id: "hubble-science:" + sourceId,
    sourceId,
    providerId: "hubble-science",
    provider: "NASA Hubble Science",
    title,
    description,
    dateCreated: published || null,
    telescope: "Hubble Space Telescope",
    instrument: instrumentForText(allText),
    subject,
    sourceOrganizations: organizationsFromCredit(credit, ["NASA", "ESA", "STScI"]),
    credit,
    thumbnailUrl: image,
    highResUrl: download || image,
    sourceUrl: canonicalUrl(html, url),
    rights: "NASA media usage guidance applies; preserve the full item-specific image credit.",
    observationType: "Science image",
  };
  return textMatchesQuery(item, query) ? item : null;
}

async function loadHubbleScience(filter: TelescopeFilter, query: string) {
  if (filter === "jwst" || filter === "other") return { source: "NASA Hubble Science", items: [] as TelescopeItem[] };
  const galleryUrl = hubbleGalleryFor(filter);
  const galleryHtml = await fetchText(galleryUrl, 21600);
  const requestedSubject =
    filter === "galaxies" || filter === "nebulae" || filter === "stars-clusters" || filter === "solar-system"
      ? filter
      : null;
  const urls = hubbleDetailLinks(galleryHtml, galleryUrl).slice(0, 10);
  const settled = await Promise.allSettled(urls.map((url) => normalizeHubbleDetail(url, requestedSubject, query)));
  const items = settled
    .filter((result): result is PromiseFulfilledResult<TelescopeItem | null> => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((item): item is TelescopeItem => Boolean(item))
    .filter((item) => acceptsFilter(item, filter))
    .slice(0, 8);
  return { source: "NASA Hubble Science", items };
}

function sortItems(items: TelescopeItem[]) {
  return [...items].sort((a, b) => {
    const aTime = a.dateCreated ? Date.parse(a.dateCreated) : 0;
    const bTime = b.dateCreated ? Date.parse(b.dateCreated) : 0;
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });
}

export const onRequestGet = async (context: any) => {
  const url = new URL(context.request.url);
  const asset = clean(url.searchParams.get("asset"), 180);
  if (asset) {
    try {
      const imageUrl = await resolveNasaAsset(asset);
      return json({
        imageUrl,
        sourceId: asset,
        providerId: "nasa-images",
        source: "NASA Image and Video Library",
      }, imageUrl ? 200 : 404);
    } catch {
      return json({ imageUrl: null, sourceId: asset, error: "NASA asset unavailable" }, 502);
    }
  }

  const rawSource = clean(url.searchParams.get("source"), 40).toLowerCase();
  const allowed: TelescopeFilter[] = [
    "all",
    "jwst",
    "hubble",
    "other",
    "solar-system",
    "galaxies",
    "nebulae",
    "stars-clusters",
  ];
  const filter: TelescopeFilter = allowed.includes(rawSource as TelescopeFilter)
    ? rawSource as TelescopeFilter
    : "jwst";
  const query = clean(url.searchParams.get("q"), 120);

  const providers: Array<Promise<{ source: string; items: TelescopeItem[] }>> = [];
  if (filter !== "hubble" && filter !== "other") providers.push(loadEsaWebb(filter, query));
  if (filter !== "jwst" && filter !== "other") providers.push(loadHubbleScience(filter, query));
  providers.push(loadNasaImages(filter, query));

  const settled = await Promise.allSettled(providers);
  const successful = settled.filter(
    (result): result is PromiseFulfilledResult<{ source: string; items: TelescopeItem[] }> => result.status === "fulfilled",
  );

  if (!successful.length) {
    return json({
      items: [],
      sources: [],
      dataAsOf: new Date().toISOString(),
      degraded: true,
      error: "Telescope observation sources unavailable",
    }, 502);
  }

  const unique = new Map<string, TelescopeItem>();
  for (const result of successful) {
    for (const item of result.value.items) {
      if (!acceptsFilter(item, filter) || !textMatchesQuery(item, query)) continue;
      const key = item.providerId + ":" + item.sourceId;
      if (!unique.has(key)) unique.set(key, item);
    }
  }

  const items = sortItems(Array.from(unique.values())).slice(0, 24);
  return json({
    items,
    count: items.length,
    filter,
    query,
    sources: successful.map((result) => result.value.source),
    dataAsOf: new Date().toISOString(),
    degraded: settled.some((result) => result.status === "rejected"),
    semantics: "Astronomical observations produced with telescopes; telescope hardware, servicing and launch imagery are excluded.",
  });
};
