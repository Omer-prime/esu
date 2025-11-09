// Server component: immediately redirects to Meta Business Login
import { redirect } from 'next/navigation';

function fbDialogURL(params: Record<string, string>) {
  const u = new URL('https://www.facebook.com/v20.0/dialog/oauth');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export default function Page({ searchParams }: { searchParams: { origin?: string } }) {
  const appId = process.env.FB_APP_ID;
  const configId = process.env.FB_LOGIN_BUSINESS_CONFIG_ID;
  const redirectUri = process.env.ESU_REDIRECT_URI; // e.g. https://connect.advistors.co.uk/api/whatsapp/esu/callback
  if (!appId || !configId || !redirectUri) {
    // Show a tiny error page if envs are missing
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh', fontFamily: 'system-ui' }}>
        <div>
          <h1>Setup incomplete</h1>
          <p>Missing FB_APP_ID / FB_LOGIN_BUSINESS_CONFIG_ID / ESU_REDIRECT_URI on the ESU server.</p>
        </div>
      </div>
    );
  }

  // Pass the tenant origin to the callback (so it can postMessage back to the LMS window)
  const origin = searchParams.origin ?? '';
  const state = Buffer.from(JSON.stringify({ origin }), 'utf8').toString('base64url');

  const url = fbDialogURL({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    business_login: '1',
    config_id: configId,
    scope: 'public_profile,business_management,whatsapp_business_messaging',
    state,
  });

  redirect(url);
}
