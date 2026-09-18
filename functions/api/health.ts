type Env = {
  OPENSKY_CLIENT_ID?: string;
  OPENSKY_CLIENT_SECRET?: string;
  OPENSKY_AUTH_MODE?: string;
  AIRCRAFT_GATEWAY_URL?: string;
};

function providerStatus(name: string, configured: boolean): { name: string; configured: boolean } {
  return { name, configured };
}

export const onRequestGet = async (context: { request: Request; env: Env }) => {
  const openSkyMode = (context.env.OPENSKY_AUTH_MODE ?? 'auto').toLowerCase();
  const openSkyConfigured = openSkyMode !== 'off' && openSkyMode !== 'disabled';
  const openSkyOAuth = Boolean(context.env.OPENSKY_CLIENT_ID && context.env.OPENSKY_CLIENT_SECRET);
  const gatewayConfigured = Boolean(context.env.AIRCRAFT_GATEWAY_URL);

  const body = {
    status: 'ok',
    version: '0.8.0',
    providers: [
      { ...providerStatus('opensky', openSkyConfigured), authMode: openSkyOAuth ? 'oauth' : 'anonymous' },
      providerStatus('adsb.lol', true),
      providerStatus('aircraft-gateway', gatewayConfigured),
    ],
  };

  return Response.json(body, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    },
  });
};
