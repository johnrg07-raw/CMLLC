/**
 * ═══════════════════════════════════════════════════════════════
 *  CANON MOMENT PHOTOGRAPHY — CLOUDFLARE WORKER
 *  Handles: Stripe payments · Pixieset cover fetch · Email capture
 * ═══════════════════════════════════════════════════════════════
 *
 *  SETUP INSTRUCTIONS (takes ~15 minutes total):
 *
 *  STEP 1 — Create the Worker
 *  ─────────────────────────
 *  1. Go to https://dash.cloudflare.com
 *  2. Click "Workers & Pages" → "Create Application" → "Create Worker"
 *  3. Name it: canon-moment-worker
 *  4. Click "Deploy" then "Edit code"
 *  5. Replace ALL the default code with this entire file
 *  6. Click "Deploy"
 *
 *  STEP 2 — Add Environment Variables (your secret keys)
 *  ──────────────────────────────────────────────────────
 *  In your Worker dashboard → Settings → Variables → Add:
 *
 *    STRIPE_SECRET_KEY     = sk_live_xxxxxxxxxxxx
 *                            (from stripe.com → Developers → API keys)
 *
 *    GOOGLE_SHEET_ID       = your-spreadsheet-id
 *                            (the long ID in your Google Sheet URL)
 *
 *    GOOGLE_SERVICE_ACCOUNT_EMAIL = your-service-account@project.iam.gserviceaccount.com
 *                            (from Google Cloud Console — see Step 4)
 *
 *    GOOGLE_PRIVATE_KEY    = -----BEGIN PRIVATE KEY-----\nxxxx\n-----END PRIVATE KEY-----
 *                            (from your service account JSON file — the "private_key" field)
 *
 *  STEP 3 — Set up Stripe
 *  ──────────────────────
 *  1. Go to https://stripe.com → sign in (or create free account)
 *  2. Dashboard → Developers → API Keys → copy your Secret key (sk_live_...)
 *  3. Also create a "Success URL" page — use your website URL + /?payment=success
 *  4. Paste secret key as STRIPE_SECRET_KEY environment variable above
 *
 *  STEP 4 — Set up Google Sheet for email capture
 *  ───────────────────────────────────────────────
 *  1. Create a new Google Sheet at sheets.google.com
 *     Name it: Canon Moment Email Leads
 *     Add headers in Row 1: Timestamp | Name | Email | Source
 *
 *  2. Go to https://console.cloud.google.com
 *     → New Project → name it "Canon Moment"
 *     → Enable the Google Sheets API (search for it)
 *
 *  3. Create a Service Account:
 *     → IAM & Admin → Service Accounts → Create
 *     → Name: canon-moment-sheets
 *     → Click the account → Keys → Add Key → JSON → Download
 *
 *  4. Open the downloaded JSON file. You need two values:
 *     - "client_email" → paste as GOOGLE_SERVICE_ACCOUNT_EMAIL
 *     - "private_key"  → paste as GOOGLE_PRIVATE_KEY
 *       (include the full -----BEGIN/END PRIVATE KEY----- lines)
 *
 *  5. Share your Google Sheet with the service account email
 *     (same as you'd share with a person — Editor permission)
 *
 *  STEP 5 — Update your website
 *  ─────────────────────────────
 *  In canon_moment_final.html, find this line near the bottom:
 *    const WORKER_URL = 'https://your-worker.your-subdomain.workers.dev';
 *  Replace with your actual Worker URL from the Cloudflare dashboard.
 *
 *  STEP 6 — Test
 *  ──────────────
 *  Open your Worker URL + /health in a browser:
 *    https://canon-moment-worker.YOUR-SUBDOMAIN.workers.dev/health
 *  You should see: {"status":"ok","worker":"Canon Moment Photography"}
 *
 *  That's it! All three features (Stripe, cover fetch, email capture) are live.
 * ═══════════════════════════════════════════════════════════════
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS headers — allow your website to call this Worker
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Handle preflight OPTIONS request
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // ── Health check ──
  if (path === '/health') {
    return jsonResponse({ status: 'ok', worker: 'Canon Moment Photography' }, corsHeaders);
  }

  // ── Route requests ──
  try {
    if (path === '/chat' && request.method === 'POST') {
      return await handleChatProxy(request, corsHeaders);
    }
    if (path === '/create-payment-intent' && request.method === 'POST') {
      return await handleStripePayment(request, corsHeaders);
    }
    if (path === '/fetch-cover' && request.method === 'GET') {
      return await handlePixiesetCover(request, corsHeaders);
    }
    if (path === '/capture-email' && request.method === 'POST') {
      return await handleEmailCapture(request, corsHeaders);
    }
    return jsonResponse({ error: 'Not found' }, corsHeaders, 404);
  } catch (err) {
    console.error('Worker error:', err);
    return jsonResponse({ error: 'Internal server error', message: err.message }, corsHeaders, 500);
  }
}


// ═══════════════════════════════════════════════
//  CLAUDE CHAT PROXY — Solves browser CORS issue
// ═══════════════════════════════════════════════
async function handleChatProxy(request, corsHeaders) {
  const body = await request.json();
  const { system, messages } = body;

  if (!messages || !messages.length) {
    return jsonResponse({ error: 'No messages provided' }, corsHeaders, 400);
  }

  // Get API key from environment variable ANTHROPIC_API_KEY
  const apiKey = typeof ANTHROPIC_API_KEY !== 'undefined' ? ANTHROPIC_API_KEY : null;
  if (!apiKey) {
    return jsonResponse({ error: 'Anthropic API key not configured' }, corsHeaders, 500);
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', // Fast + cheap for chat
      max_tokens: 400,
      system: system || '',
      messages: messages.slice(-10), // Last 10 messages max
    }),
  });

  const data = await response.json();
  if (data.error) {
    return jsonResponse({ error: data.error.message }, corsHeaders, 400);
  }

  const reply = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  return jsonResponse({ reply }, corsHeaders);
}

// ═══════════════════════════════════════════════
//  STRIPE — Create Checkout Session
// ═══════════════════════════════════════════════
async function handleStripePayment(request, corsHeaders) {
  const body = await request.json();
  const { amount, description, clientEmail, clientName, invoiceId, metadata } = body;

  if (!amount || amount < 50) {
    return jsonResponse({ error: 'Invalid amount' }, corsHeaders, 400);
  }

  // Create a Stripe Checkout Session (hosted page — no card handling on your end)
  const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'payment_method_types[]': 'card',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(amount), // already in cents
      'line_items[0][price_data][product_data][name]': description || 'Canon Moment Photography',
      'line_items[0][price_data][product_data][description]': `Canon Moment Photography LLC · Invoice ID: ${invoiceId || 'N/A'}`,
      'line_items[0][quantity]': '1',
      'mode': 'payment',
      'customer_email': clientEmail || '',
      'success_url': 'https://canonmomentphotography.com/?payment=success&session_id={CHECKOUT_SESSION_ID}',
      'cancel_url': 'https://canonmomentphotography.com/?payment=cancelled',
      'metadata[invoiceId]': invoiceId || '',
      'metadata[clientName]': clientName || '',
      'payment_intent_data[description]': description || 'Canon Moment Photography',
      'billing_address_collection': 'auto',
    }).toString(),
  });

  const session = await stripeResponse.json();

  if (session.error) {
    return jsonResponse({ error: session.error.message }, corsHeaders, 400);
  }

  return jsonResponse({ checkoutUrl: session.url, sessionId: session.id }, corsHeaders);
}

// ═══════════════════════════════════════════════
//  PIXIESET — Fetch Gallery Cover Image
// ═══════════════════════════════════════════════
async function handlePixiesetCover(request, corsHeaders) {
  const url = new URL(request.url);
  const galleryUrl = url.searchParams.get('url');

  if (!galleryUrl) {
    return jsonResponse({ error: 'Missing url parameter' }, corsHeaders, 400);
  }

  // Validate it's a Pixieset URL
  if (!galleryUrl.includes('pixieset.com')) {
    return jsonResponse({ error: 'Only Pixieset URLs are supported' }, corsHeaders, 400);
  }

  try {
    // Fetch the Pixieset gallery page
    const pageResponse = await fetch(galleryUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CanonMomentBot/1.0)',
      },
    });

    if (!pageResponse.ok) {
      return jsonResponse({ coverImage: null, error: 'Gallery page not accessible' }, corsHeaders);
    }

    const html = await pageResponse.text();

    // Extract og:image meta tag (Pixieset sets this to the gallery cover)
    const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

    const coverImage = ogImageMatch ? ogImageMatch[1] : null;

    // Also try to get the gallery title
    const titleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const title = titleMatch ? titleMatch[1] : null;

    return jsonResponse({ coverImage, title, galleryUrl }, corsHeaders);
  } catch (err) {
    return jsonResponse({ coverImage: null, error: err.message }, corsHeaders);
  }
}

// ═══════════════════════════════════════════════
//  GOOGLE SHEETS — Email Capture
// ═══════════════════════════════════════════════
async function handleEmailCapture(request, corsHeaders) {
  const body = await request.json();
  const { email, name, source, timestamp } = body;

  if (!email || !email.includes('@')) {
    return jsonResponse({ error: 'Invalid email' }, corsHeaders, 400);
  }

  try {
    // Get a Google OAuth token using the service account
    const token = await getGoogleAccessToken();

    // Append a row to the Google Sheet
    const sheetResponse = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/Sheet1!A:D:append?valueInputOption=USER_ENTERED`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          values: [[
            timestamp || new Date().toISOString(),
            name || '',
            email,
            source || 'website',
          ]],
        }),
      }
    );

    if (!sheetResponse.ok) {
      const errData = await sheetResponse.json();
      throw new Error(errData.error?.message || 'Sheets API error');
    }

    return jsonResponse({ success: true, message: 'Email captured' }, corsHeaders);
  } catch (err) {
    console.error('Email capture error:', err);
    // Return success anyway — don't break the user experience over a sheet write failure
    return jsonResponse({ success: true, message: 'Received (sheet write failed silently)' }, corsHeaders);
  }
}

// ═══════════════════════════════════════════════
//  GOOGLE AUTH — Service Account JWT
// ═══════════════════════════════════════════════
async function getGoogleAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  // Create JWT
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const signingInput = `${header}.${payloadB64}`;

  // Sign with private key
  const privateKeyPem = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const keyData = pemToArrayBuffer(privateKeyPem);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = `${signingInput}.${signatureB64}`;

  // Exchange JWT for access token
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) throw new Error('Failed to get Google access token');
  return tokenData.access_token;
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buffer;
}

// ═══════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════
function jsonResponse(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}
