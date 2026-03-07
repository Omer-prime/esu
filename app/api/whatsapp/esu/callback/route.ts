// apps/esu/src/app/api/whatsapp/esu/callback/route.ts
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

const GRAPH = 'https://graph.facebook.com/v20.0'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type StatePayload = {
  tenantId: string
  returnOrigin?: string
  ts: number
  nonce: string
}

type WabaLite = { id: string; name?: string }

type BusinessNode = {
  id: string
  name: string
  owned_whatsapp_business_accounts?: { data?: WabaLite[] }
  client_whatsapp_business_accounts?: { data?: WabaLite[] }
}

type BusinessesResp = {
  data?: BusinessNode[]
}

type AssignedWabasResp = {
  data?: WabaLite[]
}

type PhoneNumbersResp = {
  data?: Array<{
    id: string
    display_phone_number: string
    verified_name?: string
    quality_rating?: string
    status?: string
  }>
}

function parseLegacyState(decoded: string): StatePayload {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(decoded) as Record<string, unknown>
  } catch {
    //
  }

  return {
    tenantId:
      typeof parsed.tenantId === 'string'
        ? parsed.tenantId
        : typeof parsed.tenant_id === 'string'
        ? parsed.tenant_id
        : 'default',
    returnOrigin:
      typeof parsed.returnOrigin === 'string'
        ? parsed.returnOrigin
        : typeof parsed.origin === 'string'
        ? parsed.origin
        : undefined,
    ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
    nonce: typeof parsed.nonce === 'string' ? parsed.nonce : 'legacy',
  }
}

function verifyState(b64: string): StatePayload {
  try {
    const decoded = Buffer.from(b64, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as Record<string, unknown>

    if (typeof parsed.raw === 'string' && typeof parsed.sig === 'string') {
      const secret = process.env.ESU_STATE_SECRET || 'dev-secret'
      const expected = crypto
        .createHmac('sha256', secret)
        .update(parsed.raw)
        .digest('hex')

      if (parsed.sig !== expected) {
        console.error('[ESU] state signature mismatch')
        throw new Error('sig_mismatch')
      }

      return JSON.parse(parsed.raw) as StatePayload
    }

    return parseLegacyState(decoded)
  } catch (err) {
    console.error('[ESU] verifyState failed, state =', b64, 'err =', err)
    throw new Error('bad_state')
  }
}

async function graphGet(path: string, token: string) {
  const r = await fetch(`${GRAPH}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })

  const text = await r.text()
  return {
    ok: r.ok,
    status: r.status,
    text,
  }
}

async function exchangeCode(code: string) {
  const appId = process.env.FB_APP_ID!
  const appSecret = process.env.FB_APP_SECRET!
  const redirectUri = process.env.ESU_REDIRECT_URI!

  const url =
    `${GRAPH}/oauth/access_token` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code=${encodeURIComponent(code)}`

  const r = await fetch(url)
  const body = await r.text()
  if (!r.ok) throw new Error(body)

  const json = JSON.parse(body) as { access_token: string }
  console.log('[ESU] token exchange success')
  return json
}

async function discoverWaba(token: string) {
  const debug: Record<string, unknown> = {}

  // Strategy 1: businesses with owned + client WABAs
  const businessesRes = await graphGet(
    `me/businesses?fields=id,name,owned_whatsapp_business_accounts{id,name},client_whatsapp_business_accounts{id,name}&limit=100`,
    token
  )

  debug.businessesStatus = businessesRes.status
  debug.businessesBody = businessesRes.text

  if (businessesRes.ok) {
    const json = JSON.parse(businessesRes.text) as BusinessesResp
    console.log('[ESU] me/businesses response:', JSON.stringify(json, null, 2))

    for (const b of json.data || []) {
      const owned = b.owned_whatsapp_business_accounts?.data || []
      if (owned.length > 0) {
        return {
          businessId: b.id,
          businessName: b.name,
          wabaId: owned[0].id,
          wabaName: owned[0].name || '',
          source: 'me/businesses -> owned_whatsapp_business_accounts',
          debug,
        }
      }

      const client = b.client_whatsapp_business_accounts?.data || []
      if (client.length > 0) {
        return {
          businessId: b.id,
          businessName: b.name,
          wabaId: client[0].id,
          wabaName: client[0].name || '',
          source: 'me/businesses -> client_whatsapp_business_accounts',
          debug,
        }
      }
    }
  }

  // Strategy 2: user assigned WABAs
  const assignedRes = await graphGet('me/assigned_whatsapp_business_accounts?fields=id,name&limit=100', token)
  debug.assignedStatus = assignedRes.status
  debug.assignedBody = assignedRes.text

  if (assignedRes.ok) {
    const json = JSON.parse(assignedRes.text) as AssignedWabasResp
    console.log('[ESU] me/assigned_whatsapp_business_accounts response:', JSON.stringify(json, null, 2))

    const first = json.data?.[0]
    if (first?.id) {
      return {
        businessId: '',
        businessName: '',
        wabaId: first.id,
        wabaName: first.name || '',
        source: 'me/assigned_whatsapp_business_accounts',
        debug,
      }
    }
  }

  return {
    businessId: '',
    businessName: '',
    wabaId: '',
    wabaName: '',
    source: '',
    debug,
  }
}

async function fetchNumbers(wabaId: string, token: string) {
  const r = await graphGet(
    `${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,status`,
    token
  )

  console.log('[ESU] phone numbers raw response for WABA', wabaId, ':', r.text)

  if (!r.ok) {
    throw new Error(r.text)
  }

  return JSON.parse(r.text) as PhoneNumbersResp
}

function buildHtml(targetOrigin: string, payload: unknown, allowed: string[]) {
  const safeOrigin =
    allowed.length === 0 || allowed.includes(targetOrigin)
      ? targetOrigin
      : '*'

  return `<!doctype html><html><body>
<script>
  try {
    window.opener && window.opener.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(safeOrigin)});
  } catch (e) {}
  window.close();
</script>
Done.
</body></html>`
}

export async function GET(req: NextRequest) {
  const u = new URL(req.url)
  const code = u.searchParams.get('code')
  const state = u.searchParams.get('state')
  const error = u.searchParams.get('error')

  const allowList = (process.env.ALLOWED_TENANT_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const send = (targetOrigin: string, payload: unknown) =>
    new NextResponse(buildHtml(targetOrigin, payload, allowList), {
      headers: { 'Content-Type': 'text/html' },
    })

  if (error) {
    return send('*', { type: 'wa:connected', error })
  }

  if (!code || !state) {
    return send('*', {
      type: 'wa:connected',
      error: 'missing_code_or_state',
    })
  }

  let statePayload: StatePayload
  try {
    statePayload = verifyState(state)
  } catch {
    return send('*', { type: 'wa:connected', error: 'bad_state' })
  }

  const origin = statePayload.returnOrigin || '*'

  try {
    const t = await exchangeCode(code)

    const discovered = await discoverWaba(t.access_token)

    console.log('[ESU] WABA discovery result:', JSON.stringify(discovered, null, 2))

    if (!discovered.wabaId) {
      return send(origin, {
        type: 'wa:connected',
        error: 'no_real_waba_found_from_embedded_signup',
        data: {
          tenant_id: statePayload.tenantId,
          business_id: discovered.businessId || '',
          waba_id: '',
          access_token: t.access_token,
          discovery_source: discovered.source || '',
          debug: discovered.debug,
        },
      })
    }

    let phoneNumberId = ''
    let displayName = ''
    let displayPhoneNumber = ''
    let quality = ''
    let phoneStatus = ''
    let phoneLookupError = ''

    try {
      const nums = await fetchNumbers(discovered.wabaId, t.access_token)
      const n = nums.data?.[0]

      if (n) {
        phoneNumberId = n.id
        displayName = n.verified_name || n.display_phone_number
        displayPhoneNumber = n.display_phone_number || ''
        quality = n.quality_rating || ''
        phoneStatus = n.status || ''
      }
    } catch (e) {
      phoneLookupError = String((e as Error).message || e)
      console.warn('[ESU] Failed to fetch phone numbers for WABA', discovered.wabaId, phoneLookupError)
    }

    return send(origin, {
      type: 'wa:connected',
      data: {
        tenant_id: statePayload.tenantId,
        business_id: discovered.businessId,
        business_name: discovered.businessName,
        waba_id: discovered.wabaId,
        waba_name: discovered.wabaName,
        discovery_source: discovered.source,
        phone_number_id: phoneNumberId,
        display_name: displayName,
        display_phone_number: displayPhoneNumber,
        phone_status: phoneStatus,
        quality,
        access_token: t.access_token,
        phone_lookup_error: phoneLookupError,
        debug: discovered.debug,
      },
    })
  } catch (e) {
    const msg = String((e as Error).message || e)
    console.error('[ESU] callback fatal error:', msg)

    return send(origin, {
      type: 'wa:connected',
      error: msg,
    })
  }
}