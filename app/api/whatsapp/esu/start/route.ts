import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function sign(rawObj: unknown) {
  const raw = JSON.stringify(rawObj)
  const secret = process.env.ESU_STATE_SECRET || 'dev-secret'
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex')
  return { raw, sig }
}

export async function GET(req: NextRequest) {
  const APP_ID = process.env.FB_APP_ID?.trim()
  const CONFIG_ID = process.env.FB_LOGIN_BUSINESS_CONFIG_ID?.trim()
  const REDIRECT_URI = process.env.ESU_REDIRECT_URI?.trim()
  if (!APP_ID || !CONFIG_ID || !REDIRECT_URI) {
    return NextResponse.json({ error: 'env missing' }, { status: 500 })
  }

  const u = new URL(req.url)
  const tenantId = u.searchParams.get('tenant') || 'default'
  const returnOrigin = u.searchParams.get('origin') || ''

  const payload = {
    tenantId,
    returnOrigin,
    ts: Date.now(),
    nonce: crypto.randomUUID(),
  }
  const { raw, sig } = sign(payload)
  const state = Buffer.from(JSON.stringify({ raw, sig })).toString(
    'base64url',
  )

  const esu =
    `https://www.facebook.com/v20.0/dialog/oauth` +
    `?client_id=${APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&config_id=${CONFIG_ID}` +
    `&state=${state}`

  // This endpoint directly redirects (vs /link which returns JSON {url})
  return NextResponse.redirect(esu, { status: 302 })
}
