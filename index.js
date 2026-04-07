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

function toggleDoneType(dateStr, area, type, userId) {
  const data = loadData();
  if (data.currentDate !== dateStr) {
    data.currentDate = dateStr;
    data.status = {};
    data.threadTs = null;
  }
  const current = normalizeStatusEntry(data.status[area.id]);
  let pressedBy = current[type].pressedBy;
  if (pressedBy.includes('*')) {
    pressedBy = Array.isArray(area.userIds) ? [...area.userIds] : [];
  }
  let isOn = false;
  if (userId) {
    if (pressedBy.includes(userId)) {
      pressedBy = pressedBy.filter((id) => id !== userId);
      isOn = false;
    } else {
      pressedBy = [...pressedBy, userId];
      isOn = true;
    }
  }
  current[type].pressedBy = pressedBy;
  data.status[area.id] = current;
  saveData(data);
  return isOn;
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
  const empty = { lock: { pressedBy: [] }, aed: { pressedBy: [] } };
  if (!entry) return empty;
  if (typeof entry === 'boolean') {
    return {
      lock: { pressedBy: entry ? ['*'] : [] },
      aed: { pressedBy: [] },
    };
  }
  const lock =
    entry.lock && typeof entry.lock === 'object'
      ? entry.lock
      : { pressedBy: entry.lock ? ['*'] : [] };
  const aed =
    entry.aed && typeof entry.aed === 'object'
      ? entry.aed
      : { pressedBy: entry.aed ? ['*'] : [] };
  return {
    lock: { pressedBy: Array.isArray(lock.pressedBy) ? lock.pressedBy : [] },
    aed: { pressedBy: Array.isArray(aed.pressedBy) ? aed.pressedBy : [] },
  };
}

function isDoneForAll(assignedUsers, pressedBy) {
  if (pressedBy.includes('*')) return true;
  if (!assignedUsers || assignedUsers.length === 0) return false;
  return assignedUsers.every((id) => pressedBy.includes(id));
}

function pendingUsersFor(assignedUsers, pressedBy) {
  if (pressedBy.includes('*')) return [];
  if (!assignedUsers || assignedUsers.length === 0) return [];
  return assignedUsers.filter((id) => !pressedBy.includes(id));
}

function areaDone(area, statusMap) {
  const st = normalizeStatusEntry(statusMap?.[area.id]);
  const lockDone = isDoneForAll(area.userIds, st.lock.pressedBy);
  if (area.needsAed) {
    const aedDone = isDoneForAll(area.userIds, st.aed.pressedBy);
    return lockDone && aedDone;
  }
  return lockDone;
}

function isAllDone(dateStr) {
  const data = loadData();
  if (data.currentDate !== dateStr) return false;
  const statusMap = data.status || {};
  return ASSIGNMENTS.every((a) => {
    const st = normalizeStatusEntry(statusMap?.[a.id]);
    const lockAny = st.lock.pressedBy.length > 0;
    if (a.needsAed) {
      const aedAny = st.aed.pressedBy.length > 0;
      return lockAny && aedAny;
    }
    return lockAny;
  });
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
    const aed = area.needsAed ? 'AEDの確認もしてください！' : '';
    const st = normalizeStatusEntry(statusMap?.[area.id]);
    const lockDone = st.lock.pressedBy.length > 0;
    const aedDone = st.aed.pressedBy.length > 0;
    const lockText = lockDone ? '施錠確認済み' : '施錠';
    const aedText = aedDone ? 'AED確認済み' : 'AED';
    const lockStyle = lockDone ? undefined : 'primary';
    const aedStyle = aedDone ? undefined : 'danger';
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
          ...(lockStyle ? { style: lockStyle } : {}),
          value: `${area.id}`,
        },
        ...(area.needsAed
          ? [
              {
                type: 'button',
                action_id: 'aed_check',
                text: { type: 'plain_text', text: aedText, emoji: true },
                ...(aedStyle ? { style: aedStyle } : {}),
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
    text: '22:00です！施錠確認してください',
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
      const st = normalizeStatusEntry(data.status[a.id]);
      const pendingLock = pendingUsersFor(a.userIds, st.lock.pressedBy);
      const pendingAed = a.needsAed ? pendingUsersFor(a.userIds, st.aed.pressedBy) : [];
      const pendingUsers = Array.from(new Set([...pendingLock, ...pendingAed]));
      const mention = mentionList(pendingUsers);
      return `${a.place} ${mention}`.trim();
    })
    .join('\n');

  await app.client.chat.postMessage({
    channel: CHANNEL_ID,
    text: '未確認の施錠があります',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*【⚠️未確認です⚠️】*' },
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
  const turnedOn = toggleDoneType(dateStr, area, 'lock', body.user.id);

  if (CHANNEL_ID) {
    const threadTs = getThreadTs(dateStr);
    if (turnedOn) {
      await client.chat.postMessage({
        channel: CHANNEL_ID,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text: `${area.place}：施錠確認済み by <@${body.user.id}>（${timeStr}）`,
      });
    }
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
  const turnedOn = toggleDoneType(dateStr, area, 'aed', body.user.id);

  if (CHANNEL_ID) {
    const threadTs = getThreadTs(dateStr);
    if (turnedOn) {
      await client.chat.postMessage({
        channel: CHANNEL_ID,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text: `${area.place}：AED確認済み by <@${body.user.id}>（${timeStr}）`,
      });
    }
    await updateParentMessage(dateStr, client);

    if (isAllDone(dateStr)) {
      await client.chat.postMessage({
        channel: CHANNEL_ID,
        text: '全員回答済み。完了！ありがとう！！',
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
