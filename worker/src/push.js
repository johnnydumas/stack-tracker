import { buildPushPayload } from '@block65/webcrypto-web-push';
import { listSubscriptions, removeSubscriptionById } from './db.js';

/**
 * Sends one push notification (data payload) to every stored subscription.
 * `payloadObj` is whatever the service worker's `push` handler expects,
 * see public/sw.js for the shape.
 */
export async function sendPushToAll(env, payloadObj) {
  const subs = await listSubscriptions(env);
  if (subs.length === 0) return { sent: 0, removed: 0 };

  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  const message = { data: JSON.stringify(payloadObj), options: { ttl: 3600 } };

  let sent = 0;
  let removed = 0;

  await Promise.allSettled(
    subs.map(async (sub) => {
      const subscription = {
        endpoint: sub.endpoint,
        expirationTime: null,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      try {
        const payload = await buildPushPayload(message, subscription, vapid);
        const res = await fetch(subscription.endpoint, payload);
        if (res.status === 404 || res.status === 410) {
          await removeSubscriptionById(env, sub.id);
          removed += 1;
        } else if (res.ok) {
          sent += 1;
        } else {
          console.error(`push send failed: ${res.status} for subscription ${sub.id}`);
        }
      } catch (err) {
        console.error('push send error', err);
      }
    })
  );

  return { sent, removed };
}
