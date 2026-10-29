export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const backendUrl = process.env.RENDER_BACKEND_URL;
  if (!backendUrl) {
    return new Response(
      JSON.stringify({
        error: 'RENDER_BACKEND_URL is not set. Add it in Vercel Settings -> Environment Variables with your Render app URL (e.g. https://e-junkie.onrender.com).',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const url = new URL(req.url);
  const base = backendUrl.replace(/\/$/, '');
  const targetUrl = `${base}${url.pathname}${url.search}`;

  const forwardHeaders = new Headers(req.headers);
  forwardHeaders.set('host', new URL(backendUrl).host);

  const init = {
    method: req.method,
    headers: forwardHeaders,
    redirect: 'manual',
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body;
  }

  try {
    const backendRes = await fetch(targetUrl, init);
    return new Response(backendRes.body, {
      status: backendRes.status,
      headers: backendRes.headers,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Could not connect to Render backend: ${err.message}` }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

