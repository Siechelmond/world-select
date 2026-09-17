type CelesTrakGroup = { name: string; limit?: number };

const CORE_GROUPS: CelesTrakGroup[] = [
  { name: 'STATIONS' },
  { name: 'VISUAL' },
  { name: 'GPS-OPS' },
  { name: 'GLO-OPS' },
  { name: 'GALILEO' },
  { name: 'GEO' },
];

// DENSE is intentionally opt-in. It adds multiple LEO constellations so the
// mode still expands visibly if one large upstream group is temporarily unavailable.
const DENSE_GROUPS: CelesTrakGroup[] = [
  ...CORE_GROUPS,
  { name: 'IRIDIUM-NEXT', limit: 100 },
  { name: 'ONEWEB', limit: 450 },
  { name: 'STARLINK', limit: 900 },
];

function splitRecords(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const out: Array<{ name: string; line1: string; line2: string }> = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    if (!lines[i + 1].startsWith('1 ') || !lines[i + 2].startsWith('2 ')) continue;
    out.push({ name: lines[i], line1: lines[i + 1], line2: lines[i + 2] });
  }
  return out;
}

export const onRequestGet = async ({ request }: { request: Request }) => {
  const catalog = new URL(request.url).searchParams.get('catalog') === 'dense' ? 'dense' : 'core';
  const groups = catalog === 'dense' ? DENSE_GROUPS : CORE_GROUPS;

  const responses = await Promise.allSettled(groups.map(async (group) => {
    const upstream = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group.name}&FORMAT=TLE`, {
      headers: { 'User-Agent': 'WorldSelect/0.6 (+https://world-select.pages.dev)' },
      cf: { cacheTtl: 7200, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
    if (!upstream.ok) throw new Error(`${group.name} HTTP ${upstream.status}`);
    const records = splitRecords(await upstream.text());
    return group.limit ? records.slice(0, group.limit) : records;
  }));

  const byNorad = new Map<string, { name: string; line1: string; line2: string }>();
  const okGroups: string[] = [];
  const failedGroups: string[] = [];
  responses.forEach((result, index) => {
    const group = groups[index];
    if (result.status !== 'fulfilled') {
      failedGroups.push(group.name);
      return;
    }
    okGroups.push(group.name);
    for (const record of result.value) {
      const norad = record.line1.slice(2, 7).trim();
      if (norad && !byNorad.has(norad)) byNorad.set(norad, record);
    }
  });

  if (!byNorad.size) return new Response('CelesTrak groups unavailable', { status: 502 });
  const text = Array.from(byNorad.values()).map((r) => `${r.name}\n${r.line1}\n${r.line2}`).join('\n') + '\n';
  return new Response(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=7200',
      'X-World-Select-Satellite-Count': String(byNorad.size),
      'X-World-Select-Satellite-Catalog': catalog,
      'X-World-Select-Satellite-Groups': okGroups.join(','),
      'X-World-Select-Satellite-Failed-Groups': failedGroups.join(','),
    },
  });
};
