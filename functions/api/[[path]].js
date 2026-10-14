// 在线客服后端 Worker（Cloudflare Pages Functions）—— D1 数据库版
// 存储：D1（写完立即可读，无 KV 同步延迟，解决"不稳定"）
// 绑定名：CHAT_DB（D1 数据库）
// 密钥：ADMIN_KEY（环境变量）
//
// 表结构（首次自动初始化）：
//   sessions(visitor_id TEXT PRIMARY KEY, name, created_at, last_active,
//            unread_for_agent INT, agent_replied INT, last_message TEXT, agent_read_at INT)
//   messages(id TEXT PRIMARY KEY, visitor_id, sender TEXT, text TEXT, at INT)

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-key'
    }
  });
}
function now() { return new Date().toISOString(); }
function id() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

let _inited = false;
async function ensureTables(env) {
  if (_inited) return;
  await env.CHAT_DB.exec(`
    CREATE TABLE IF NOT EXISTS sessions(
      visitor_id TEXT PRIMARY KEY,
      name TEXT,
      created_at TEXT,
      last_active TEXT,
      unread_for_agent INTEGER DEFAULT 0,
      agent_replied INTEGER DEFAULT 0,
      last_message TEXT DEFAULT '',
      agent_read_at INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages(
      id TEXT PRIMARY KEY,
      visitor_id TEXT,
      sender TEXT,
      text TEXT,
      at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_msg_vid ON messages(visitor_id, at);
  `);
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
  await env.CHAT_DB.prepare('INSERT INTO messages(id,visitor_id,sender,text,at) VALUES(?,?,?,?,?)')
    .bind(msg.id, vid, msg.sender, msg.text, msg.at).run();
  // 防爆：只保留最近500条
  await env.CHAT_DB.prepare(
    `DELETE FROM messages WHERE visitor_id=? AND id NOT IN
     (SELECT id FROM messages WHERE visitor_id=? ORDER BY at DESC LIMIT 500)`
  ).bind(vid, vid).run();
}
async function getMsgs(env, vid) {
  const r = await env.CHAT_DB.prepare('SELECT id,sender,text,at FROM messages WHERE visitor_id=? ORDER BY at ASC').bind(vid).all();
  return (r.results || []).map(m => ({ id: m.id, from: m.sender, text: m.text, at: m.at }));
}

function checkAdmin(request, env) {
  const key = request.headers.get('x-admin-key') || '';
  if (!env.ADMIN_KEY) return { ok: false, msg: '服务端未配置 ADMIN_KEY' };
  if (key !== env.ADMIN_KEY) return { ok: false, msg: '口令错误' };
  return { ok: true };
}
function validText(t, max = 2000) {
  return typeof t === 'string' && t.trim().length > 0 && t.length <= max;
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

    // ---- 客户：发消息 ----
    if (path === '/send' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { visitor_id } = body;
      const text = body.text;
      if (!visitor_id) return json({ error: '缺少 visitor_id' }, 400);
      if (!validText(text)) return json({ error: '消息内容不合法' }, 400);

      let s = await getSession(env, visitor_id);
      if (!s) return json({ error: '会话不存在，请先 /api/session 创建' }, 404);

      const msg = { id: 'm' + id(), sender: 'visitor', text: text.trim().slice(0, 2000), at: Date.now() };
      await addMsg(env, visitor_id, msg);
      s.last_active = now();
      s.last_message = msg.text.slice(0, 60);
      s.unread_for_agent = (s.unread_for_agent || 0) + 1;
      await touchVisitor(env, visitor_id, s);
      return json({ ok: true, msg: { id: msg.id, from: 'visitor', text: msg.text, at: msg.at } });
    }

    // ---- 客户：拉取本会话消息 ----
    if (path === '/messages' && request.method === 'GET') {
      const vid = url.searchParams.get('visitor_id');
      if (!vid) return json({ error: '缺少 visitor_id' }, 400);
      const msgs = await getMsgs(env, vid);
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

    // ---- 客服：拉取某访客消息（标记已读） ----
    if (path === '/thread' && request.method === 'GET') {
      if (!checkAdmin(request, env).ok) return json({ error: '未授权' }, 401);
      const vid = url.searchParams.get('visitor_id');
      if (!vid) return json({ error: '缺少 visitor_id' }, 400);
      const s = await getSession(env, vid);
      const msgs = await getMsgs(env, vid);
      if (s && (s.unread_for_agent || 0) > 0) {
        s.unread_for_agent = 0;
        s.agent_read_at = Date.now();
        await touchVisitor(env, vid, s);
      }
      return json({ name: s ? s.name : '未知', messages: msgs });
    }

    // ---- 客服：回复 ----
    if (path === '/reply' && request.method === 'POST') {
      if (!checkAdmin(request, env).ok) return json({ error: '未授权' }, 401);
      const body = await request.json().catch(() => ({}));
      const { visitor_id } = body;
      const text = body.text;
      if (!visitor_id) return json({ error: '缺少 visitor_id' }, 400);
      if (!validText(text)) return json({ error: '消息内容不合法' }, 400);

      let s = await getSession(env, visitor_id);
      if (!s) return json({ error: '会话不存在' }, 404);

      const msg = { id: 'm' + id(), sender: 'agent', text: text.trim().slice(0, 2000), at: Date.now() };
      await addMsg(env, visitor_id, msg);
      s.last_active = now();
      s.last_message = msg.text.slice(0, 60);
      s.agent_replied = 1;
      s.agent_read_at = msg.at;
      await touchVisitor(env, visitor_id, s);
      return json({ ok: true, msg: { id: msg.id, from: 'agent', text: msg.text, at: msg.at } });
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
    return json({ error: '服务器错误: ' + e.message }, 500);
  }
}
