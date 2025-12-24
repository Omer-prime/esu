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
    return NextResponse.json(
      {
        error:
          'Missing FB_APP_ID / FB_LOGIN_BUSINESS_CONFIG_ID / ESU_REDIRECT_URI',
      },
      { status: 500 },
    )
  }

  const url = new URL(req.url)
  const tenantId = url.searchParams.get('tenant') || 'default'
  const returnOrigin = url.searchParams.get('origin') || ''

  const payload = {
    tenantId,
    returnOrigin,
    ts: Date.now(),
    nonce: crypto.randomUUID(),
  }

  const { raw, sig } = sign(payload)
  const state = Buffer.from(JSON.stringify({ raw, sig })).toString('base64url')

  // Same scopes as /start
  const scopes = [
    'business_management',
    'whatsapp_business_management',
    'whatsapp_business_messaging',
  ].join(',')

  const esu =
    `https://www.facebook.com/v20.0/dialog/oauth` +
    `?client_id=${encodeURIComponent(APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&config_id=${encodeURIComponent(CONFIG_ID)}` +
    `&response_type=code` + // 👈 force code flow
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${state}`

  return NextResponse.json({ url: esu })
}
