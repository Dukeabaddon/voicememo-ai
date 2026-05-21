import { NextRequest, NextResponse } from 'next/server';
import { RtcTokenBuilder, RtcRole } from 'agora-token';

export async function GET(req: NextRequest) {
  const appId = process.env.NEXT_PUBLIC_AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;
  
  const searchParams = req.nextUrl.searchParams;
  const channelName = searchParams.get('channelName') || 'voicememo';
  const uidParam = searchParams.get('uid');
  const uid = uidParam ? Number.parseInt(uidParam, 10) : 0;

  if (Number.isNaN(uid) || uid < 0 || uid > 2147483647) {
    return NextResponse.json({ error: 'uid must be an integer between 0 and 2147483647' }, { status: 400 });
  }

  if (!appId || !appCertificate) {
    console.error('Agora credentials missing in server environment');
    return NextResponse.json({ error: 'Agora credentials missing' }, { status: 500 });
  }

  try {
    const role = RtcRole.PUBLISHER;
    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid,
      role,
      privilegeExpiredTs,
      privilegeExpiredTs
    );

    return NextResponse.json({ token });
  } catch (error: any) {
    console.error('Token generation error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
