import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push';

const VAPID_PUBLIC_KEY  = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const SB_URL            = Deno.env.get('SUPABASE_URL')!;
const SB_SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

webpush.setVapidDetails(
  'mailto:admin@manyukafarm.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const record  = payload.record;
    if (!record?.recipient_id) return new Response('ok');

    const supabase = createClient(SB_URL, SB_SERVICE_KEY);

    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', record.recipient_id);

    const pushPayload = JSON.stringify({
      title: '💬 New Message — Manyuka Farm',
      body:  `From ${record.sender_name || 'Someone'}: ${(record.subject || '').slice(0, 80)}`,
      link:  'messages',
      type:  'message'
    });

    for (const sub of (subs || [])) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          pushPayload
        );
      } catch (err: any) {
        if (err.statusCode === 410) {
          await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        }
      }
    }
    return new Response('ok');
  } catch (e) {
    return new Response('error', { status: 500 });
  }
});
