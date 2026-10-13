// 在线客服后端 Worker（Cloudflare Pages Functions）
// 存储设计：单键存数组，一个会话一条 key，读写各一次，避开 KV list() 每日1000次限制
// KV 绑定名：CHAT_KV
// 密钥：ADMIN_KEY（客服台登录口令，通过环境变量设置）

const PREFIX = 'chat:';

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

// ============ 会话存储 ============
// 一条会话 = { visitor_id, name, last_message, last_active, unread_for_agent, agent_replied, last_from_agent }
async function getSession(env, vid) {
  return await env.CHAT_KV.get(PREFIX + 'session:' + vid, { type: 'json' });
}
async function putSession(env, vid, s) {
  await env.CHAT_KV.put(PREFIX + 'session:' + vid, JSON.stringify(s));
}
// 消息 = { vid, msgs:[{id,from,text,at}], agentReadAt }
async function getThread(env, vid) {
  return await env.CHAT_KV.get(PREFIX + 'thread:' + vid, { type: 'json' }) || { msgs: [], agentReadAt: 0 };
}
async function putThread(env, vid, t) {
  await env.CHAT_KV.put(PREFIX + 'thread:' + vid, JSON.stringify(t));
}
async function listVisitors(env) {
  // 仅列出会话索引（避免全量读消息体）——用一个汇总 key 记录所有 vid
  let idx = await env.CHAT_KV.get(PREFIX + 'visitors', { type: 'json' }) || [];
  return idx;
}
async function addVisitor(env, vid, meta) {
  let idx = await listVisitors(env);
  let found = idx.find(x => x.visitor_id === vid);
  if (!found) {
    found = { visitor_id: vid, ...meta };
    idx.push(found);
  } else {
    Object.assign(found, meta);
  }
  await env.CHAT_KV.put(PREFIX + 'visitors', JSON.stringify(idx));
}

// ============ 校验 ============
function checkAdmin(request, env) {
  const key = request.headers.get('x-admin-key') || '';
  if (!env.ADMIN_KEY) return { ok: false, msg: '服务端未配置 ADMIN_KEY' };
  if (key !== env.ADMIN_KEY) return { ok: false, msg: '口令错误' };
  return { ok: true };
}
function validText(t, max = 2000) {
  return typeof t === 'string' && t.trim().length > 0 && t.length <= max;
}

// ============ 主入口：按路由分派 ============
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
    // ---- 客户：创建/进入会话（携带昵称） ----
    if (path === '/session' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      let vid = body.visitor_id;
      if (!vid) vid = 'v-' + id();
      const name = (typeof body.name === 'string' && body.name.trim()) ? body.name.trim().slice(0, 30) : '访客' + vid.slice(2, 6);
      let s = await getSession(env, vid);
      if (!s) {
        s = { visitor_id: vid, name, created_at: now(), last_active: now(),
              unread_for_agent: 0, agent_replied: false, last_from_agent: 0, last_message: '' };
        await addVisitor(env, vid, { visitor_id: vid, name, created_at: s.created_at });
      }
      await putSession(env, vid, s);
      return json({ visitor_id: vid, name: s.name, agent_replied: s.agent_replied });
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

      let t = await getThread(env, visitor_id);
      const msg = { id: 'm' + id(), from: 'visitor', text: text.trim().slice(0, 2000), at: Date.now() };
      t.msgs.push(msg);
      if (t.msgs.length > 500) t.msgs = t.msgs.slice(-500); // 防爆
      await putThread(env, visitor_id, t);

      s.last_active = now();
      s.last_message = msg.text.slice(0, 60);
      s.unread_for_agent = (s.unread_for_agent || 0) + 1;
      await putSession(env, visitor_id, s);
      await addVisitor(env, visitor_id, { visitor_id, last_message: s.last_message, last_active: s.last_active });
      return json({ ok: true, msg });
    }

    // ---- 客户：拉取本会话消息 ----
    if (path === '/messages' && request.method === 'GET') {
      const vid = url.searchParams.get('visitor_id');
      if (!vid) return json({ error: '缺少 visitor_id' }, 400);
      const t = await getThread(env, vid);
      return json({ messages: t.msgs, agentReadAt: t.agentReadAt || 0 });
    }

    // ---- 客服：访客列表（按最近活跃排序） ----
    if (path === '/visitors' && request.method === 'GET') {
      if (!checkAdmin(request, env).ok) return json({ error: '未授权' }, 401);
      let idx = await listVisitors(env);
      const sessions = await Promise.all(idx.map(async v => {
        const s = await getSession(env, v.visitor_id);
        return s ? { visitor_id: s.visitor_id, name: s.name, last_message: s.last_message,
                     last_active: s.last_active, unread_for_agent: s.unread_for_agent || 0,
                     agent_replied: s.agent_replied } : null;
      }));
      const list = sessions.filter(Boolean).sort((a, b) => new Date(b.last_active) - new Date(a.last_active));
      return json({ visitors: list });
    }

    // ---- 客服：拉取某访客的消息（并标记已读） ----
    if (path === '/thread' && request.method === 'GET') {
      if (!checkAdmin(request, env).ok) return json({ error: '未授权' }, 401);
      const vid = url.searchParams.get('visitor_id');
      if (!vid) return json({ error: '缺少 visitor_id' }, 400);
      const s = await getSession(env, vid);
      const t = await getThread(env, vid);
      // 标记客服已读
      t.agentReadAt = Date.now();
      await putThread(env, vid, t);
      if (s && s.unread_for_agent) {
        s.unread_for_agent = 0;
        await putSession(env, vid, s);
      }
      return json({ name: s ? s.name : '未知', messages: t.msgs });
    }

    // ---- 客服：回复消息 ----
    if (path === '/reply' && request.method === 'POST') {
      if (!checkAdmin(request, env).ok) return json({ error: '未授权' }, 401);
      const body = await request.json().catch(() => ({}));
      const { visitor_id } = body;
      const text = body.text;
      if (!visitor_id) return json({ error: '缺少 visitor_id' }, 400);
      if (!validText(text)) return json({ error: '消息内容不合法' }, 400);

      let s = await getSession(env, visitor_id);
      if (!s) return json({ error: '会话不存在' }, 404);

      let t = await getThread(env, visitor_id);
      const msg = { id: 'm' + id(), from: 'agent', text: text.trim().slice(0, 2000), at: Date.now() };
      t.msgs.push(msg);
      t.agentReadAt = Date.now();
      if (t.msgs.length > 500) t.msgs = t.msgs.slice(-500);
      await putThread(env, visitor_id, t);

      s.last_active = now();
      s.last_message = msg.text.slice(0, 60);
      s.agent_replied = true;
      s.last_from_agent = msg.at;
      await putSession(env, visitor_id, s);
      await addVisitor(env, visitor_id, { visitor_id, last_message: s.last_message, last_active: s.last_active });
      return json({ ok: true, msg });
    }

    // ---- 客服：修改口令 ----
    if (path === '/password' && request.method === 'POST') {
      if (!checkAdmin(request, env).ok) return json({ error: '未授权' }, 401);
      const body = await request.json().catch(() => ({}));
      const np = body.new_password;
      if (!np || String(np).length < 6) return json({ error: '新口令至少6位' }, 400);
      // 口令实际存在环境变量里，这里仅提示通过 Cloudflare 后台修改更安全
      return json({ ok: true, hint: '口令请通过 Cloudflare 环境变量 ADMIN_KEY 修改后重新部署' });
    }

    return json({ error: 'Not Found' }, 404);
  } catch (e) {
    return json({ error: '服务器错误: ' + e.message }, 500);
  }
}
