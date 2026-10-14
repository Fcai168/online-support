// 在线客服后端 Worker（Cloudflare Pages Functions）—— D1 + 短轮询 + 图片
// 存储：D1（写完立即可读）；实时：前端每秒/数秒轮询（since 增量）
// 绑定名：CHAT_DB（D1）
// 密钥：ADMIN_KEY（环境变量）
// 表：sessions(...) / messages(id PK, visitor_id, sender, text, at, image)

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
      'Cache-Control': 'no-store'
    }
  });
}
function now() { return new Date().toISOString(); }
function id() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

let _inited = false;
async function ensureTables(env) {
  if (_inited) return;
  await env.CHAT_DB.batch([
    env.CHAT_DB.prepare(`CREATE TABLE IF NOT EXISTS sessions(
      visitor_id TEXT PRIMARY KEY,
      name TEXT,
      created_at TEXT,
      last_active TEXT,
      unread_for_agent INTEGER DEFAULT 0,
      agent_replied INTEGER DEFAULT 0,
      last_message TEXT DEFAULT '',
      agent_read_at INTEGER DEFAULT 0
    )`),
    env.CHAT_DB.prepare(`CREATE TABLE IF NOT EXISTS messages(
      id TEXT PRIMARY KEY,
      visitor_id TEXT,
      sender TEXT,
      text TEXT,
      at INTEGER,
      image TEXT
    )`),
    env.CHAT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_msg_vid ON messages(visitor_id, at)`),
    env.CHAT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_msg_vid_id ON messages(visitor_id, id)`)
  ]);
  // 迁移：老表若无 image 列则补上
  const info = await env.CHAT_DB.prepare('PRAGMA table_info(messages)').all();
  const cols = (info.results || []).map(c => c.name);
  if (!cols.includes('image')) {
    await env.CHAT_DB.prepare('ALTER TABLE messages ADD COLUMN image TEXT').run();
  }
  _inited = true;
}

async function getSession(env, vid) {
  const r = await env.CHAT_DB.prepare('SELECT * FROM sessions WHERE visitor_id = ?').bind(vid).first();
  return r || null;
}
async function touchVisitor(env, vid, s) {
  await env.CHAT_DB.prepare(
    `INSERT INTO sessions(visitor_id,name,created_at,last_active,unread_for_agent,agent_replied,last_message,agent_read_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(visitor_id) DO UPDATE SET
       name=excluded.name, last_active=excluded.last_active,
       unread_for_agent=excluded.unread_for_agent, agent_replied=excluded.agent_replied,
       last_message=excluded.last_message, agent_read_at=excluded.agent_read_at`
  ).bind(vid, s.name, s.created_at, s.last_active, s.unread_for_agent||0, s.agent_replied?1:0, s.last_message||'', s.agent_read_at||0).run();
}
async function addMsg(env, vid, msg) {
  await env.CHAT_DB.prepare('INSERT INTO messages(id,visitor_id,sender,text,at,image) VALUES(?,?,?,?,?,?)')
    .bind(msg.id, vid, msg.sender, msg.text, msg.at, msg.image || null).run();
  // 保留策略（每个客户独立计数，互不挤占，id 单调递增不会误删）：
  // 1) 图片体积大，每个客户最多保留最近 100 张
  await env.CHAT_DB.prepare(
    `DELETE FROM messages WHERE visitor_id=? AND image IS NOT NULL AND id NOT IN
     (SELECT id FROM messages WHERE visitor_id=? AND image IS NOT NULL ORDER BY id DESC LIMIT 100)`
  ).bind(vid, vid).run();
  // 2) 文字消息，每个客户最多保留最近 400 条
  await env.CHAT_DB.prepare(
    `DELETE FROM messages WHERE visitor_id=? AND image IS NULL AND id NOT IN
     (SELECT id FROM messages WHERE visitor_id=? AND image IS NULL ORDER BY id DESC LIMIT 400)`
  ).bind(vid, vid).run();
}
function mapMsg(m) {
  return { id: m.id, from: m.sender, text: m.text, at: m.at, image: m.image || null };
}
// 复合游标：at 优先，同 at 用 id 兜底，杜绝同毫秒漏消息
async function getNewMsgs(env, vid, sinceAt, sinceId) {
  const r = await env.CHAT_DB.prepare(
    `SELECT id,sender,text,at,image FROM messages
     WHERE visitor_id=? AND (at > ? OR (at = ? AND id > ?))
     ORDER BY at ASC, id ASC`
  ).bind(vid, sinceAt || 0, sinceAt || 0, sinceId || '').all();
  return (r.results || []).map(mapMsg);
}

function checkAdmin(request, env) {
  const key = request.headers.get('x-admin-key') || '';
  if (!env.ADMIN_KEY) return { ok: false, msg: '服务端未配置 ADMIN_KEY' };
  if (key !== env.ADMIN_KEY) return { ok: false, msg: '口令错误' };
  return { ok: true };
}
// 图片白名单：必须是 data:image/(jpeg|png|webp|gif);base64, 且 ≤300KB
const IMG_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;
function validMsg(text, image) {
  const hasText = typeof text === 'string' && text.trim().length > 0;
  const hasImg = typeof image === 'string' && image.length > 0;
  if (!hasText && !hasImg) return { ok: false, error: '消息内容不合法' };
  if (hasText && text.length > 2000) return { ok: false, error: '文字过长' };
  if (hasImg) {
    if (!IMG_RE.test(image)) return { ok: false, error: '图片格式不支持' };
    if (image.length > 300000) return { ok: false, error: '图片过大（请压缩后重试）' };
  }
  return { ok: true };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key'
  }});

  try {
    await ensureTables(env);

    // ---- 客户：创建/进入会话 ----
    if (path === '/session' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      let vid = body.visitor_id;
      if (!vid) vid = 'v-' + id();
      const name = (typeof body.name === 'string' && body.name.trim()) ? body.name.trim().slice(0, 30) : '访客' + vid.slice(2, 6);
      let s = await getSession(env, vid);
      if (!s) {
        s = { visitor_id: vid, name, created_at: now(), last_active: now(),
              unread_for_agent: 0, agent_replied: 0, last_message: '', agent_read_at: 0 };
        await touchVisitor(env, vid, s);
      }
      return json({ visitor_id: vid, name: s.name, agent_replied: !!s.agent_replied });
    }

    // ---- 客户：发消息（文字/图片） ----
    if (path === '/send' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { visitor_id, image } = body;
      const text = body.text;
      if (!visitor_id) return json({ error: '缺少 visitor_id' }, 400);
      const v = validMsg(text, image);
      if (!v.ok) return json({ error: v.error }, 400);

      let s = await getSession(env, visitor_id);
      if (!s) return json({ error: '会话不存在，请先 /api/session 创建' }, 404);

      const msg = { id: 'm' + id(), sender: 'visitor',
        text: (typeof text === 'string' && text.trim()) ? text.trim().slice(0, 2000) : '',
        at: Date.now(), image: image || null };
      await addMsg(env, visitor_id, msg);
      s.last_active = now();
      s.last_message = msg.text ? msg.text.slice(0, 60) : '[图片]';
      s.unread_for_agent = (s.unread_for_agent || 0) + 1;
      await touchVisitor(env, visitor_id, s);
      return json({ ok: true, msg: { id: msg.id, from: 'visitor', text: msg.text, at: msg.at, image: msg.image } });
    }

    // ---- 拉取新消息（复合游标） ----
    if (path === '/messages' && request.method === 'GET') {
      const vid = url.searchParams.get('visitor_id');
      if (!vid) return json({ error: '缺少 visitor_id' }, 400);
      const sinceAt = parseInt(url.searchParams.get('sinceAt') || '0', 10);
      const sinceId = url.searchParams.get('sinceId') || '';
      const msgs = await getNewMsgs(env, vid, sinceAt, sinceId);
      return json({ messages: msgs });
    }

    // ---- 客服：访客列表 ----
    if (path === '/visitors' && request.method === 'GET') {
      if (!checkAdmin(request, env).ok) return json({ error: '未授权' }, 401);
      const r = await env.CHAT_DB.prepare(
        'SELECT visitor_id,name,last_message,last_active,unread_for_agent,agent_replied FROM sessions ORDER BY last_active DESC LIMIT 200'
      ).all();
      const list = (r.results || []).map(s => ({
        visitor_id: s.visitor_id, name: s.name, last_message: s.last_message,
        last_active: s.last_active, unread_for_agent: s.unread_for_agent || 0, agent_replied: !!s.agent_replied
      }));
      return json({ visitors: list });
    }

    // ---- 客服：拉取某访客消息（复合游标 + 标记已读） ----
    if (path === '/thread' && request.method === 'GET') {
      if (!checkAdmin(request, env).ok) return json({ error: '未授权' }, 401);
      const vid = url.searchParams.get('visitor_id');
      if (!vid) return json({ error: '缺少 visitor_id' }, 400);
      const sinceAt = parseInt(url.searchParams.get('sinceAt') || '0', 10);
      const sinceId = url.searchParams.get('sinceId') || '';
      const s = await getSession(env, vid);
      const msgs = await getNewMsgs(env, vid, sinceAt, sinceId);
      if (msgs.length > 0 && s && (s.unread_for_agent || 0) > 0) {
        s.unread_for_agent = 0;
        s.agent_read_at = Date.now();
        await touchVisitor(env, vid, s);
      }
      return json({ name: s ? s.name : '未知', messages: msgs });
    }

    // ---- 客服：回复（文字/图片） ----
    if (path === '/reply' && request.method === 'POST') {
      if (!checkAdmin(request, env).ok) return json({ error: '未授权' }, 401);
      const body = await request.json().catch(() => ({}));
      const { visitor_id, image } = body;
      const text = body.text;
      if (!visitor_id) return json({ error: '缺少 visitor_id' }, 400);
      const v = validMsg(text, image);
      if (!v.ok) return json({ error: v.error }, 400);

      let s = await getSession(env, visitor_id);
      if (!s) return json({ error: '会话不存在' }, 404);

      const msg = { id: 'm' + id(), sender: 'agent',
        text: (typeof text === 'string' && text.trim()) ? text.trim().slice(0, 2000) : '',
        at: Date.now(), image: image || null };
      await addMsg(env, visitor_id, msg);
      s.last_active = now();
      s.last_message = msg.text ? msg.text.slice(0, 60) : '[图片]';
      s.agent_replied = 1;
      s.agent_read_at = msg.at;
      await touchVisitor(env, visitor_id, s);
      return json({ ok: true, msg: { id: msg.id, from: 'agent', text: msg.text, at: msg.at, image: msg.image } });
    }

    // ---- 客服：修改口令提示 ----
    if (path === '/password' && request.method === 'POST') {
      if (!checkAdmin(request, env).ok) return json({ error: '未授权' }, 401);
      const body = await request.json().catch(() => ({}));
      const np = body.new_password;
      if (!np || String(np).length < 6) return json({ error: '新口令至少6位' }, 400);
      return json({ ok: true, hint: '口令请通过 Cloudflare 环境变量 ADMIN_KEY 修改后重新部署' });
    }

    return json({ error: 'Not Found' }, 404);
  } catch (e) {
    return json({ error: '服务器错误' }, 500); // 不回显内部细节
  }
}
