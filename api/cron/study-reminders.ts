import { createSign } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

type FirestoreValue = {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  timestampValue?: string;
  stringValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
};

type FirestoreDocument = {
  name: string;
  fields?: Record<string, FirestoreValue>;
};

type UserRecord = {
  uid: string;
  email?: string;
  displayName?: string;
  settings?: {
    studyReminder?: {
      enabled?: boolean;
      time?: string;
      timezone?: string;
      lastSentDate?: string;
    };
  };
};

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'anki-learning-78dac';
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '(default)';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIRESTORE_ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${encodeURIComponent(DATABASE_ID)}/documents`;
const REMINDER_TIME = '21:00';
const REMINDER_TIMEZONE = 'Asia/Bangkok';
const DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

function json(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function serviceAccountConfig() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || process.env.FIREBASE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    throw new Error('Missing Firebase service account env vars.');
  }

  return { clientEmail, privateKey };
}

async function getAccessToken() {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }

  const { clientEmail, privateKey } = serviceAccountConfig();
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: clientEmail,
    scope: DATASTORE_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  }));
  const unsignedJwt = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsignedJwt);
  signer.end();
  const signature = base64Url(signer.sign(privateKey));

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsignedJwt}.${signature}`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Unable to get Google access token: ${response.status}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  };
  return cachedAccessToken.token;
}

async function firestoreFetch(path: string, init?: RequestInit) {
  const token = await getAccessToken();
  const response = await fetch(`${FIRESTORE_ROOT}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Firestore request failed ${response.status}: ${text.slice(0, 600)}`);
  }

  return response.json();
}

async function runQuery(structuredQuery: Record<string, unknown>) {
  const data = await firestoreFetch(':runQuery', {
    method: 'POST',
    body: JSON.stringify({ structuredQuery }),
  }) as Array<{ document?: FirestoreDocument }>;

  return data.map((item) => item.document).filter(Boolean) as FirestoreDocument[];
}

async function listDocuments(parentPath: string, collectionId: string) {
  const data = await firestoreFetch(`/${parentPath}/${collectionId}?pageSize=500`) as { documents?: FirestoreDocument[] };
  return data.documents || [];
}

function decodeValue(value?: FirestoreValue): unknown {
  if (!value) return undefined;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) return (value.arrayValue?.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue?.fields || {});
  return undefined;
}

function decodeFields(fields: Record<string, FirestoreValue>) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function decodeDocument<T>(document: FirestoreDocument): T {
  return decodeFields(document.fields || {}) as T;
}

function encodeValue(value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return {
    mapValue: {
      fields: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, encodeValue(item)])),
    },
  };
}

function getLocalDateKey(date = new Date(), timeZone = REMINDER_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value || '0000';
  const month = parts.find((part) => part.type === 'month')?.value || '01';
  const day = parts.find((part) => part.type === 'day')?.value || '01';
  return `${year}-${month}-${day}`;
}

function parseDate(value: unknown) {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cardIsDue(card: Record<string, unknown>, now = new Date()) {
  if (card.suspended === true) return false;

  const today = getLocalDateKey(now);
  if (typeof card.buriedUntil === 'string' && card.buriedUntil >= today) return false;

  const due = parseDate(card.dueDate) || parseDate(card.nextReview) || parseDate(card.due);
  return due ? due.getTime() <= now.getTime() : true;
}

async function getReminderUsers() {
  const documents = await runQuery({
    from: [{ collectionId: 'users' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'settings.studyReminder.enabled' },
        op: 'EQUAL',
        value: { booleanValue: true },
      },
    },
  });

  return documents.map((document) => decodeDocument<UserRecord>(document));
}

async function getDueCountForUser(userId: string) {
  const ownedCards = await runQuery({
    from: [{ collectionId: 'cards', allDescendants: true }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'ownerId' },
        op: 'EQUAL',
        value: { stringValue: userId },
      },
    },
  });
  const progressCards = await listDocuments(`users/${userId}`, 'cardProgress').catch(() => []);
  const allCards = [
    ...ownedCards.map((document) => decodeDocument<Record<string, unknown>>(document)),
    ...progressCards.map((document) => decodeDocument<Record<string, unknown>>(document)),
  ];

  return allCards.filter((card) => cardIsDue(card)).length;
}

function buildEmailHtml(user: UserRecord, dueCount: number) {
  const name = user.displayName || 'bạn';
  const title = dueCount > 0
    ? `Tối nay bạn có ${dueCount} thẻ cần ôn`
    : 'Tối nay là một nhịp ôn nhẹ';

  return `
    <div style="font-family:Inter,Arial,sans-serif;background:#f6f7f9;padding:28px;color:#18181b">
      <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:28px">
        <p style="margin:0 0 8px;font-size:13px;color:#71717a">Learning Card</p>
        <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25">${title}</h1>
        <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#3f3f46">Chào ${name}, đây là nhắc học lúc 21:00. Mở app vài phút để giữ nhịp ôn tập và giảm số thẻ dồn lại ngày mai.</p>
        <div style="border-radius:12px;background:#f4f4f5;padding:16px;margin:20px 0">
          <p style="margin:0;font-size:13px;color:#71717a">Thẻ đến hạn</p>
          <p style="margin:4px 0 0;font-size:32px;font-weight:700">${dueCount}</p>
        </div>
        <a href="${process.env.PUBLIC_APP_URL || 'https://learning-with-trunghieu.vercel.app'}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;border-radius:10px;padding:12px 18px;font-size:14px;font-weight:700">Mở Learning Card</a>
        <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#71717a">Bạn có thể tắt nhắc học trong Cài đặt của ứng dụng.</p>
      </div>
    </div>
  `;
}

async function sendReminderEmail(user: UserRecord, dueCount: number) {
  const resendApiKey = process.env.RESEND_API_KEY;
  const from = process.env.REMINDER_FROM_EMAIL;

  if (!resendApiKey || !from) {
    throw new Error('Missing RESEND_API_KEY or REMINDER_FROM_EMAIL.');
  }
  if (!user.email) {
    throw new Error(`User ${user.uid} has no email.`);
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${resendApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [user.email],
      subject: dueCount > 0 ? `Bạn có ${dueCount} thẻ cần ôn tối nay` : 'Nhắc học Learning Card lúc 21:00',
      html: buildEmailHtml(user, dueCount),
      text: `Learning Card nhắc bạn ôn tập lúc 21:00. Số thẻ đến hạn: ${dueCount}.`,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend failed ${response.status}: ${text.slice(0, 600)}`);
  }
}

async function markReminderSent(userId: string, today: string, dueCount: number) {
  const fields = {
    settings: {
      studyReminder: {
        lastSentDate: today,
        lastDueCount: dueCount,
        lastEmailStatus: 'sent',
      },
    },
  };
  const updateMask = [
    'settings.studyReminder.lastSentDate',
    'settings.studyReminder.lastDueCount',
    'settings.studyReminder.lastEmailStatus',
  ].map((fieldPath) => `updateMask.fieldPaths=${encodeURIComponent(fieldPath)}`).join('&');

  await firestoreFetch(`/users/${userId}?${updateMask}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: encodeValue(fields).mapValue?.fields }),
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  const cronSecret = process.env.CRON_SECRET;
  const authorization = req.headers.authorization;
  if (!cronSecret || authorization !== `Bearer ${cronSecret}`) {
    json(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    const users = await getReminderUsers();
    const today = getLocalDateKey(new Date(), REMINDER_TIMEZONE);
    let sent = 0;
    let skipped = 0;
    const failures: Array<{ userId: string; error: string }> = [];

    for (const user of users) {
      const reminder = user.settings?.studyReminder;
      if (!user.uid || reminder?.lastSentDate === today || (reminder?.time && reminder.time !== REMINDER_TIME)) {
        skipped += 1;
        continue;
      }

      try {
        const dueCount = await getDueCountForUser(user.uid);
        await sendReminderEmail(user, dueCount);
        await markReminderSent(user.uid, today, dueCount);
        sent += 1;
      } catch (error) {
        failures.push({
          userId: user.uid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    json(res, failures.length > 0 ? 207 : 200, {
      ok: failures.length === 0,
      date: today,
      sent,
      skipped,
      failed: failures.length,
      failures,
    });
  } catch (error) {
    json(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
