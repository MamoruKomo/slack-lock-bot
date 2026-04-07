require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { App } = require('@slack/bolt');

const TZ = process.env.TZ || 'Asia/Tokyo';
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

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

function loadData() {
  if (!fs.existsSync(DATA_PATH)) {
    return { currentDate: null, status: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    return { currentDate: null, status: {} };
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
    saveData(data);
  }
  return data;
}

function markDone(dateStr, areaId) {
  const data = loadData();
  if (data.currentDate !== dateStr) {
    data.currentDate = dateStr;
    data.status = {};
  }
  data.status[areaId] = true;
  saveData(data);
}

function isAllDone(dateStr) {
  const data = loadData();
  if (data.currentDate !== dateStr) return false;
  return ASSIGNMENTS.every((a) => data.status[a.id]);
}

function buildDailyBlocks() {
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
          text: { type: 'plain_text', text: '確認済み', emoji: true },
          style: 'primary',
          value: `${area.id}`,
        },
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
  const now = nowInTz();
  const dateStr = formatDate(now);
  ensureDate(dateStr);
  await app.client.chat.postMessage({
    channel: CHANNEL_ID,
    text: '施錠確認（22:00）',
    blocks: buildDailyBlocks(),
  });
}

async function postReminder() {
  if (!CHANNEL_ID) return;
  const now = nowInTz();
  const dateStr = formatDate(now);
  const data = ensureDate(dateStr);
  const pending = ASSIGNMENTS.filter((a) => !data.status[a.id]);

  if (pending.length === 0) return;

  const lines = pending
    .map((a) => {
      const mention = mentionList(a.userIds);
      return `${a.place} ${mention}`.trim();
    })
    .join('\n');

  await app.client.chat.postMessage({
    channel: CHANNEL_ID,
    text: '未確認の施錠があります',
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
  const dateStr = formatDate(now);
  const timeStr = formatTime(now);
  ensureDate(dateStr);
  markDone(dateStr, area.id);

  if (CHANNEL_ID) {
    await client.chat.postMessage({
      channel: CHANNEL_ID,
      text: `${area.place}：確認済み by <@${body.user.id}>（${timeStr}）`,
    });

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
  cron.schedule('0 22 * * *', postDailyMessage, { timezone: TZ });
  cron.schedule('50 23 * * *', postReminder, { timezone: TZ });
  const now = nowInTz();
  console.log(`Slack Lock Bot started: ${formatDate(now)} ${formatTime(now)} (${TZ})`);
})();
