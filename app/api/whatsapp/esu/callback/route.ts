import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
const GRAPH = 'https://graph.facebook.com/v20.0'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function verifyState(b64: string) {
  const parsed = JSON.parse(Buffer.from(b64, 'base64url').toString())
  const raw = parsed.raw as string
  const sig = parsed.sig as string
  const secret = process.env.ESU_STATE_SECRET || 'dev-secret'
  const expect = crypto.createHmac('sha256', secret).update(raw).digest('hex')
  if (sig !== expect) throw new Error('bad_state')
  return JSON.parse(raw) as { tenantId: string; returnOrigin?: string; ts: number; nonce: string }
}

async function exchangeCode(code: string) {
  const appId = process.env.FB_APP_ID!
  const appSecret = process.env.FB_APP_SECRET!
  const redirectUri = process.env.ESU_REDIRECT_URI!
  const url = `${GRAPH}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`
  const r = await fetch(url)
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()) as { access_token: string }
}

async function fetchWabas(token: string) {
  const r = await fetch(`${GRAPH}/me/businesses?fields=id,name,owned_whatsapp_business_accounts{id,name}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<{ data: Array<{ id: string; owned_whatsapp_business_accounts?: { data: Array<{ id: string; name: string }> } }> }>
}

async function fetchNumbers(wabaId: string, token: string) {
  const r = await fetch(`${GRAPH}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,status`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<{ data: Array<{ id: string; display_phone_number: string; verified_name?: string; quality_rating?: string; status?: string }> }>
}

export async function GET(req: NextRequest) {
  const u = new URL(req.url)
  const code = u.searchParams.get('code')
  const state = u.searchParams.get('state')
  const error = u.searchParams.get('error')

  const allowList = (process.env.ALLOWED_TENANT_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean)

  const send = (targetOrigin: string, payload: unknown) => {
    const safe = allowList.length === 0 || allowList.includes(targetOrigin) ? targetOrigin : '*'
    const html = `<!doctype html><html><body>
      <script>
        try { window.opener && window.opener.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(safe)}); } catch(e) {}
        window.close();
      </script>Done.</body></html>`
    return new NextResponse(html, { headers: { 'Content-Type': 'text/html' } })
  }

  if (error) return send('*', { type: 'wa:connected', error })
  if (!code || !state) return send('*', { type: 'wa:connected', error: 'missing_code_or_state' })

  let target
  try { target = verifyState(state) } catch { return send('*', { type: 'wa:connected', error: 'bad_state' }) }
  const origin = target.returnOrigin || '*'

  try {
    const t = await exchangeCode(code)
    const biz = await fetchWabas(t.access_token)

    let businessId = '', wabaId = ''
    for (const b of biz.data || []) {
      const w = b.owned_whatsapp_business_accounts?.data || []
      if (w.length) { businessId = b.id; wabaId = w[0].id; break }
    }

    let phoneNumberId = '', displayName = '', quality = ''
    if (wabaId) {
      const nums = await fetchNumbers(wabaId, t.access_token)
      if (nums.data?.length) {
        const n = nums.data[0]
        phoneNumberId = n.id
        displayName = n.verified_name || n.display_phone_number
        quality = n.quality_rating || ''
      }
    }

    return send(origin, {
      type: 'wa:connected',
      data: {
        tenant_id: target.tenantId,
        business_id: businessId,
        waba_id: wabaId,
        phone_number_id: phoneNumberId,
        display_name: displayName,
        quality,
        access_token: t.access_token
      }
    })
  } catch (e) {
    return send(origin, { type: 'wa:connected', error: String((e as Error).message || e) })
  }
}
