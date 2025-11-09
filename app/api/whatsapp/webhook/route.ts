import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const u = new URL(req.url)
  if (u.searchParams.get('hub.verify_token') === process.env.WA_VERIFY_TOKEN) {
    return new NextResponse(u.searchParams.get('hub.challenge') ?? 'OK', { status: 200 })
  }
  return new NextResponse('Forbidden', { status: 403 })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  console.log('WA webhook', JSON.stringify(body))
  return NextResponse.json({ ok: true })
}
