// apps/esu/src/app/api/whatsapp/esu/callback/route.ts
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

const GRAPH = 'https://graph.facebook.com/v20.0';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type StatePayload = {
  tenantId: string;
  returnOrigin?: string;
  ts: number;
  nonce: string;
};

type BusinessResp = {
  data?: Array<{
    id: string;
    name: string;
    owned_whatsapp_business_accounts?: {
      data?: Array<{ id: string; name: string }>;
    };
  }>;
};

type PhoneNumbersResp = {
  data?: Array<{
    id: string;
    display_phone_number: string;
    verified_name?: string;
    quality_rating?: string;
    status?: string;
  }>;
};

// --------- state verify: accept signed + legacy ---------

function parseLegacyState(decoded: string): StatePayload {
  let parsed: any = {};
  try {
    parsed = JSON.parse(decoded);
  } catch {
    // ignore JSON errors, fall back to defaults
  }

  return {
    tenantId: parsed.tenantId || parsed.tenant_id || 'default',
    returnOrigin: parsed.returnOrigin || parsed.origin || undefined,
    ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
    nonce: parsed.nonce || 'legacy',
  };
}

function verifyState(b64: string): StatePayload {
  try {
    const decoded = Buffer.from(b64, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as any;

    // New signed format: { raw, sig }
    if (typeof parsed.raw === 'string' && typeof parsed.sig === 'string') {
      const secret = process.env.ESU_STATE_SECRET || 'dev-secret';
      const expected = crypto
        .createHmac('sha256', secret)
        .update(parsed.raw)
        .digest('hex');

      if (parsed.sig !== expected) {
        console.error('[ESU] state signature mismatch');
        throw new Error('sig_mismatch');
      }

      return JSON.parse(parsed.raw) as StatePayload;
    }

    // Legacy format (no signature, e.g. {origin: "..."} )
    return parseLegacyState(decoded);
  } catch (err) {
    console.error('[ESU] verifyState failed, state =', b64, 'err =', err);
    throw new Error('bad_state');
  }
}

// ---- exchange auth code -> user token ----
async function exchangeCode(code: string) {
  const appId = process.env.FB_APP_ID!;
  const appSecret = process.env.FB_APP_SECRET!;
  const redirectUri = process.env.ESU_REDIRECT_URI!;

  const url =
    `${GRAPH}/oauth/access_token` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code=${encodeURIComponent(code)}`;

  const r = await fetch(url);
  const body = await r.text();
  if (!r.ok) throw new Error(body);
  return JSON.parse(body) as { access_token: string };
}

// ---- get business + WABA from user token ----
async function fetchBusinessAndWaba(
  token: string,
): Promise<{ businessId?: string; wabaId?: string }> {
  const r = await fetch(
    `${GRAPH}/me/businesses?fields=id,name,owned_whatsapp_business_accounts{id,name}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  const body = await r.text();
  if (!r.ok) throw new Error(body);

  const json = JSON.parse(body) as BusinessResp;

  const withWabas =
    json.data?.find((b) => b.owned_whatsapp_business_accounts?.data?.length) ??
    json.data?.[0];

  const waba = withWabas?.owned_whatsapp_business_accounts?.data?.[0];

  return {
    businessId: withWabas?.id,
    wabaId: waba?.id,
  };
}

// ---- get phone numbers for that WABA (optional) ----
async function fetchNumbers(
  wabaId: string,
  token: string,
): Promise<PhoneNumbersResp> {
  const r = await fetch(
    `${GRAPH}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,status`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  const body = await r.text();
  if (!r.ok) throw new Error(body);
  return JSON.parse(body) as PhoneNumbersResp;
}

function buildHtml(targetOrigin: string, payload: unknown, allowed: string[]) {
  const safeOrigin =
    allowed.length === 0 || allowed.includes(targetOrigin)
      ? targetOrigin
      : '*';

  return `<!doctype html><html><body>
<script>
  try {
    window.opener && window.opener.postMessage(${JSON.stringify(
      payload,
    )}, ${JSON.stringify(safeOrigin)});
  } catch (e) {}
  window.close();
</script>
Done.
</body></html>`;
}

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  const error = u.searchParams.get('error');

  const allowList = (process.env.ALLOWED_TENANT_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const send = (targetOrigin: string, payload: unknown) =>
    new NextResponse(buildHtml(targetOrigin, payload, allowList), {
      headers: { 'Content-Type': 'text/html' },
    });

  // error directly from Meta UI
  if (error) {
    return send('*', { type: 'wa:connected', error });
  }

  if (!code || !state) {
    return send('*', {
      type: 'wa:connected',
      error: 'missing_code_or_state',
    });
  }

  let statePayload: StatePayload;
  try {
    statePayload = verifyState(state);
  } catch {
    return send('*', { type: 'wa:connected', error: 'bad_state' });
  }
  const origin = statePayload.returnOrigin || '*';

  try {
    const t = await exchangeCode(code);

    // 1) try to detect business + WABA from Meta
    let { businessId, wabaId } = await fetchBusinessAndWaba(t.access_token);

    // 2) fallback to .env defaults (for testing / review)
    if (!businessId && process.env.FB_DEFAULT_BUSINESS_ID) {
      businessId = process.env.FB_DEFAULT_BUSINESS_ID;
    }
    if (!wabaId && process.env.FB_DEFAULT_WABA_ID) {
      wabaId = process.env.FB_DEFAULT_WABA_ID;
    }

    if (!businessId || !wabaId) {
      return send(origin, {
        type: 'wa:connected',
        error: 'no_waba_found_for_user',
      });
    }

    // 3) phone number lookup is OPTIONAL – we ignore failures
    let phoneNumberId = '';
    let displayName = '';
    let quality = '';

    try {
      const nums = await fetchNumbers(wabaId, t.access_token);
      const n = nums.data?.[0];
      if (n) {
        phoneNumberId = n.id;
        displayName = n.verified_name || n.display_phone_number;
        quality = n.quality_rating || '';
      }
    } catch (e) {
      console.warn('Failed to fetch phone numbers for WABA', wabaId, e);
      // continue – we still return businessId + wabaId
    }

    return send(origin, {
      type: 'wa:connected',
      data: {
        tenant_id: statePayload.tenantId,
        business_id: businessId,
        waba_id: wabaId,
        phone_number_id: phoneNumberId,
        display_name: displayName,
        quality,
        access_token: t.access_token,
      },
    });
  } catch (e) {
    const msg = String((e as Error).message || e);
    return send(origin, {
      type: 'wa:connected',
      error: msg,
    });
  }
}
