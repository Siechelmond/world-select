const GROUPS = [
  { name: 'VISUAL', limit: 120 },
  { name: 'STATIONS', limit: 40 },
  { name: 'WEATHER', limit: 100 },
  { name: 'GPS-OPS', limit: 40 },
  { name: 'GALILEO', limit: 40 },
  { name: 'STARLINK', limit: 220 },
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

export const onRequestGet = async () => {
  const responses = await Promise.allSettled(GROUPS.map(async (group) => {
    const upstream = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group.name}&FORMAT=TLE`, {
      headers: { 'User-Agent': 'WorldSelect/0.4 (+https://world-select.pages.dev)' },
      cf: { cacheTtl: 7200, cacheEverything: true },
    } as RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } });
    if (!upstream.ok) throw new Error(`${group.name} HTTP ${upstream.status}`);
    return splitRecords(await upstream.text()).slice(0, group.limit);
  }));

  const byNorad = new Map<string, { name: string; line1: string; line2: string }>();
  for (const result of responses) {
    if (result.status !== 'fulfilled') continue;
    for (const record of result.value) {
      const norad = record.line1.slice(2, 7).trim();
      if (norad && !byNorad.has(norad)) byNorad.set(norad, record);
    }
  }

  if (!byNorad.size) return new Response('CelesTrak groups unavailable', { status: 502 });
  const text = Array.from(byNorad.values()).map((r) => `${r.name}\n${r.line1}\n${r.line2}`).join('\n') + '\n';
  return new Response(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=7200',
      'X-World-Select-Satellite-Count': String(byNorad.size),
    },
  });
};
