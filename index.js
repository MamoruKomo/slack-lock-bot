require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { App } = require('@slack/bolt');

const TZ = process.env.TZ || 'Asia/Tokyo';
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const RUN_ON_START = process.env.RUN_ON_START === '1';
const RUN_REMINDER_ON_START = process.env.RUN_REMINDER_ON_START === '1';

function parseUserIds(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function mentionList(userIds) {
  if (!userIds || userIds.length === 0) return '未設定';
  return userIds.map((id) => `<@${id}>`).join(' ');
}

const ASSIGNMENTS = [
  { id: 'A', place: 'A棟', userIds: parseUserIds(process.env.USER_A), needsAed: true },
  { id: 'B1', place: 'B棟1F', userIds: parseUserIds(process.env.USER_B1), needsAed: false },
  { id: 'B2', place: 'B棟2F', userIds: parseUserIds(process.env.USER_B2), needsAed: false },
  { id: 'C', place: 'C棟', userIds: parseUserIds(process.env.USER_C), needsAed: true },
];

const DATA_PATH = path.join(__dirname, 'data.json');

function nowInTz() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTime(d) {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function effectiveDate(d) {
  const hour = d.getHours();
  if (hour < 12) {
    const prev = new Date(d);
    prev.setDate(prev.getDate() - 1);
    return prev;
  }
  return d;
}

function currentDateStr() {
  return formatDate(effectiveDate(nowInTz()));
}

function loadData() {
  if (!fs.existsSync(DATA_PATH)) {
    return { currentDate: null, status: {}, threadTs: null };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    return { currentDate: null, status: {}, threadTs: null };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function ensureDate(dateStr) {
  const data = loadData();
  if (data.currentDate !== dateStr) {
    data.currentDate = dateStr;
    data.status = {};
    data.threadTs = null;
    saveData(data);
  }
  return data;
}

function markDoneType(dateStr, areaId, type) {
  const data = loadData();
  if (data.currentDate !== dateStr) {
    data.currentDate = dateStr;
    data.status = {};
    data.threadTs = null;
  }
  const current = normalizeStatusEntry(data.status[areaId]);
  current[type] = true;
  data.status[areaId] = current;
  saveData(data);
}

function setThreadTs(dateStr, threadTs) {
  const data = loadData();
  if (data.currentDate !== dateStr) {
    data.currentDate = dateStr;
    data.status = {};
  }
  data.threadTs = threadTs;
  saveData(data);
}

function getThreadTs(dateStr) {
  const data = loadData();
  if (data.currentDate !== dateStr) return null;
  return data.threadTs || null;
}

async function updateParentMessage(dateStr, client) {
  if (!CHANNEL_ID) return;
  const threadTs = getThreadTs(dateStr);
  if (!threadTs) return;
  const data = loadData();
  if (data.currentDate !== dateStr) return;
  await client.chat.update({
    channel: CHANNEL_ID,
    ts: threadTs,
    text: '施錠確認（22:00）',
    blocks: buildDailyBlocks(data.status),
  });
}

function normalizeStatusEntry(entry) {
  if (!entry) return { lock: false, aed: false };
  if (typeof entry === 'boolean') {
    return { lock: entry, aed: false };
  }
  return {
    lock: Boolean(entry.lock),
    aed: Boolean(entry.aed),
  };
}

function areaDone(area, statusMap) {
  const st = normalizeStatusEntry(statusMap?.[area.id]);
  if (area.needsAed) return st.lock && st.aed;
  return st.lock;
}

function isAllDone(dateStr) {
  const data = loadData();
  if (data.currentDate !== dateStr) return false;
  const statusMap = data.status || {};
  return ASSIGNMENTS.every((a) => areaDone(a, statusMap));
}

function buildDailyBlocks(statusMap) {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '施錠確認（22:00）', emoji: true },
    },
    { type: 'divider' },
  ];

  for (const area of ASSIGNMENTS) {
    const mention = mentionList(area.userIds);
    const aed = area.needsAed ? '（AED確認含む）' : '';
    const st = normalizeStatusEntry(statusMap?.[area.id]);
    const lockText = st.lock ? '施錠確認済み' : '施錠';
    const aedText = st.aed ? 'AED確認済み' : 'AED';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${area.place}* ${aed}\n${mention}`,
      },
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'lock_check',
          text: { type: 'plain_text', text: lockText, emoji: true },
          style: 'primary',
          value: `${area.id}`,
        },
        ...(area.needsAed
          ? [
              {
                type: 'button',
                action_id: 'aed_check',
                text: { type: 'plain_text', text: aedText, emoji: true },
                style: 'danger',
                value: `${area.id}`,
              },
            ]
          : []),
      ],
    });
  }

  return blocks;
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

async function postDailyMessage() {
  if (!CHANNEL_ID) return;
  const dateStr = currentDateStr();
  const data = ensureDate(dateStr);
  const res = await app.client.chat.postMessage({
    channel: CHANNEL_ID,
    text: '施錠確認（22:00）',
    blocks: buildDailyBlocks(data.status),
  });
  if (res && res.ts) {
    setThreadTs(dateStr, res.ts);
  }
}

async function postReminder() {
  if (!CHANNEL_ID) return;
  const dateStr = currentDateStr();
  const data = ensureDate(dateStr);
  const pending = ASSIGNMENTS.filter((a) => !areaDone(a, data.status));

  if (pending.length === 0) return;

  const lines = pending
    .map((a) => {
      const mention = mentionList(a.userIds);
      return `${a.place} ${mention}`.trim();
    })
    .join('\n');

  const threadTs = getThreadTs(dateStr);
  await app.client.chat.postMessage({
    channel: CHANNEL_ID,
    text: '未確認の施錠があります',
    ...(threadTs ? { thread_ts: threadTs } : {}),
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*【未確認があります⚠️】*' },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `${lines}\n施錠を確認してください。` },
      },
    ],
  });
}

app.action('lock_check', async ({ ack, body, payload, client }) => {
  await ack();

  const areaId = payload.value;
  const area = ASSIGNMENTS.find((a) => a.id === areaId);
  if (!area) return;

  const now = nowInTz();
  const dateStr = currentDateStr();
  const timeStr = formatTime(now);
  ensureDate(dateStr);
  markDoneType(dateStr, area.id, 'lock');

  if (CHANNEL_ID) {
    const threadTs = getThreadTs(dateStr);
    await client.chat.postMessage({
      channel: CHANNEL_ID,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: `${area.place}：施錠確認済み by <@${body.user.id}>（${timeStr}）`,
    });
    await updateParentMessage(dateStr, client);

    if (isAllDone(dateStr)) {
      await client.chat.postMessage({
        channel: CHANNEL_ID,
        text: '全員回答済み。完了',
      });
    }
  }
});

app.action('aed_check', async ({ ack, body, payload, client }) => {
  await ack();

  const areaId = payload.value;
  const area = ASSIGNMENTS.find((a) => a.id === areaId);
  if (!area) return;

  const now = nowInTz();
  const dateStr = currentDateStr();
  const timeStr = formatTime(now);
  ensureDate(dateStr);
  markDoneType(dateStr, area.id, 'aed');

  if (CHANNEL_ID) {
    const threadTs = getThreadTs(dateStr);
    await client.chat.postMessage({
      channel: CHANNEL_ID,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: `${area.place}：AED確認済み by <@${body.user.id}>（${timeStr}）`,
    });
    await updateParentMessage(dateStr, client);

    if (isAllDone(dateStr)) {
      await client.chat.postMessage({
        channel: CHANNEL_ID,
        text: '全員回答済み。完了',
      });
    }
  }
});

(async () => {
  await app.start();
  if (RUN_ON_START) {
    await postDailyMessage();
  }
  if (RUN_REMINDER_ON_START) {
    await postReminder();
  }
  cron.schedule('0 22 * * *', postDailyMessage, { timezone: TZ });
  cron.schedule('50 23 * * *', postReminder, { timezone: TZ });
  const now = nowInTz();
  console.log(`Slack Lock Bot started: ${formatDate(now)} ${formatTime(now)} (${TZ})`);
})();
