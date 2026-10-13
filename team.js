/* ============================================================
   team.js —— UE 团队看板「植入工具」  v2.0.0-20261012
   ------------------------------------------------------------
   设计目标（用户口径）：
     「同事有自己的 html 个人工作站，也是 git 同步的，跟 NIKO 一个原理，
       但不是 NIKO 本体，是完全独立的。我不想又开多一个网页，
       而是搞一个植入工具，把这个团队看板植入任何 html 里面。」
   ------------------------------------------------------------
   用法（同事只需 2 行）：
     <div id="niko-team" data-me="a"></div>
     <script src="https://skipperjames.github.io/uep-squad-board/team.js"><\/script>

   本版把「合并预览版」里验证过的 19 个方案**全部**搬了进来：
     06 六列状态看板 · 21 冲突告警条 · 23 变更时光机 · 24 正在编辑提示
     26 今日待办提醒 · 27 @我提醒 · 28 阻塞超时升级 · 30 每日变更摘要
     33 批量操作栏 · 35 撤销/重做 · 37 新建看板模板 · 42 字段级合并
     43 草稿暂存 · 44 操作回放 · 47 回收站 · 48 自动备份牌
     51 卡片内讨论区 · 56 看板列自定义 · 58 卡片模板套用

   技术要点：
     · 零依赖、原生 JS
     · Shadow DOM 隔离 —— 不污染宿主工作站任何样式（:host{all:initial}）
     · 数据同步不是文件同步：GitHub 一处数据，三人读写同一份
     · ★ 卡片级三方合并（按 id 逐张比 updatedAt），改不同字段静默合并
     · SHA 冲突自动重试（409/422 → 重拉+重合并+重推）
     · 800ms 节流推送（拖拽高频写入不触发 SHA 风暴）
     · 全量走白名单键 niko_team_*，绝不外泄个人数据
   ============================================================ */
(function (global) {
  'use strict';

  const VERSION = 'v2.0.0-20261012';

  /* ---------- 配置（宿主页可覆盖） ---------- */
  const DEFAULT_CONFIG = {
    me: 'me',                              // 我是谁：me | a | b
    channel: {
      type: 'github',                      // github | local
      repo: 'skipperjames/niko-team-data', // 团队数据仓库（**私有**；代码仓是 uep-squad-board，两者区分）
      file: 'board.json',
      branch: 'main',
      token: null                          // 共用写入 token（空=公开只读）
    },
    theme: 'auto',                         // auto | light | dark
    showMyView: true,
    defaultView: 'all',                    // all | mine
    lockedPollMs: 5000                     // 「正在编辑」锁轮询（预留）
  };

  /* ---------- 数据模型 ---------- */
  const ST = {
    todo:    { l: '待排期', c: '#f59e0b' },
    doing:   { l: '开发中', c: '#3b82f6' },
    review:  { l: '待验收', c: '#8b5cf6' },
    bug:     { l: 'BUG',    c: '#ef4444' },
    discuss: { l: '讨论中', c: '#ec4899' },
    done:    { l: '已完成', c: '#10b981' }
  };
  const ROLE = {
    me: { n: '我',   c: '#667eea', r: '制作人/策划' },
    a:  { n: '月饼', c: '#34d399', r: '程序' },
    b:  { n: '邢锦', c: '#f59e0b', r: '美术TA' }
  };
  const SYNC_PREFIX = 'niko_team_';

  let CONFIG = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  let DATA = [];
  let TRASH = [];          // 47 回收站
  let LOG = [];            // 23 时光机 / 44 回放
  let DISCUSS = {};        // 51 讨论区
  let COLUMNS = [          // 56 列自定义
    { k: 'todo',    l: '待排期', c: '#f59e0b' },
    { k: 'doing',   l: '开发中', c: '#3b82f6' },
    { k: 'review',  l: '待验收', c: '#8b5cf6' },
    { k: 'bug',     l: 'BUG',    c: '#ef4444' },
    { k: 'discuss', l: '讨论中', c: '#ec4899' }
  ];
  let LOCKED = {};         // 24 正在编辑
  let UNDO = [], REDO = [];// 35 撤销/重做
  let REMOTE_PENDING = null; // 21/42 冲突暂存
  let FILTER = 'all', KW = '', BATCH = false, SEL = new Set();
  let VIEW = 'all';
  let hostEl = null, root = null;
  let syncing = false, pendingPush = false, pushTimer = null, pollTimer = null;
  let mounted = false;

  const now = () => Date.now();
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const fmtT = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
  const daysLeft = ms => Math.round((ms - now()) / 86400000);
  const dstr = ms => { const d = new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
  const fieldLabel = f => ({ prog:'进度', note:'备注', owner:'负责人', status:'状态', pri:'优先级', due:'交付日', name:'名称' }[f] || f);
  const fieldVal = (f, v) => {
    if (f === 'status') return ST[v] ? ST[v].l : v;
    if (f === 'owner') return (ROLE[v] || {}).n || v;
    if (f === 'prog') return v + '%';
    if (f === 'due') return dstr(v);
    return String(v);
  };
  const roleOf = id => ROLE[id] || { n: String(id), c: '#888', r: '' };

  /* ---------- 种子（首次拉取前占位） ---------- */
  function seed() {
    const D = n => { const d = new Date(); d.setHours(18,0,0,0); d.setDate(d.getDate()+n); return +d; };
    return [
      ['主角_基础移动','角色','me','doing',60,D(5),'P0','基础移动完成，冲刺闪避在调'],
      ['主角_战斗连招','角色','a','doing',45,D(7),'P0','连招 4 段已通，第 5 段卡顿'],
      ['敌人_小怪_地精','角色','b','review',90,D(2),'P1','建模绑定完成，等验收蒙皮'],
      ['敌人_BOSS_岩魔','角色','b','doing',35,D(12),'P1','高模完成，材质分层中'],
      ['场景_森林主关卡','场景','me','doing',50,D(9),'P0','地形完成，植被散布中'],
      ['场景_洞穴支线','场景','a','todo',0,D(18),'P2','待排期，等森林关卡过关'],
      ['特效_火焰灼烧','特效','b','doing',70,D(4),'P0','粒子 70%，烟尘层待调'],
      ['特效_受击顿帧','特效','a','bug',80,D(1),'P0','BUG：低帧率粒子消失，疑似 LOD 阈值'],
      ['UI_主菜单','UI','me','done',100,D(-2),'P1','已完成并归档 /Content/UI/MainMenu'],
      ['UI_血条技能图标','UI','b','discuss',40,D(6),'P1','讨论：技能图标用 2D 还是 3D 渲染'],
      ['音频_战斗BGM','音频','me','todo',0,D(20),'P2','待排期，音频外包还没定'],
      ['音频_脚步音效集','音频','a','done',100,D(-5),'P2','已完成']
    ].map((s, i) => ({
      id: 'a' + i, name: s[0], type: s[1], owner: s[2], status: s[3], prog: s[4],
      due: s[5], pri: s[6], note: s[7], tags: [s[1]],
      createdAt: now() - i*86400000, updatedAt: now() - i*3600000,
      lockedBy: null, draft: null
    }));
  }

  /* ============================================================
     存储 & 云同步（collectLocal → computeMerge → doSyncChannel）
     ============================================================ */
  function collectLocal() {
    return { DATA, TRASH, LOG, DISCUSS, COLUMNS, _ts: now(), _by: CONFIG.me, _v: VERSION };
  }
  function saveLocal(s) {
    try { localStorage.setItem(SYNC_PREFIX + 'data', JSON.stringify(s || collectLocal())); } catch (e) {}
  }
  function loadLocal() {
    try { const s = JSON.parse(localStorage.getItem(SYNC_PREFIX + 'data') || 'null'); return (s && s.DATA) ? s : null; } catch (e) { return null; }
  }
  function applyState(s) {
    if (!s) return;
    if (s.DATA) DATA = s.DATA;
    if (s.TRASH) TRASH = s.TRASH;
    if (s.LOG) LOG = s.LOG;
    if (s.DISCUSS) DISCUSS = s.DISCUSS;
    if (s.COLUMNS && s.COLUMNS.length >= 2) COLUMNS = s.COLUMNS;
  }

  /* ★ 卡片级三方合并 */
  function mergeCards(local, remote) {
    const map = new Map();
    (remote || []).forEach(c => map.set(c.id, c));
    (local || []).forEach(c => {
      const r = map.get(c.id);
      if (!r) { map.set(c.id, c); return; }
      map.set(c.id, (c.updatedAt || 0) >= (r.updatedAt || 0) ? c : r);
    });
    return [...map.values()];
  }
  function mergeList(a, b, keyFn) {
    const seen = new Set(), out = [];
    [...(a || []), ...(b || [])].sort((x, y) => (y.t || 0) - (x.t || 0)).forEach(i => {
      const k = keyFn(i);
      if (!seen.has(k)) { seen.add(k); out.push(i); }
    });
    return out;
  }
  function mergeDiscuss(a, b) {
    const out = {};
    new Set([...Object.keys(a || {}), ...Object.keys(b || {})]).forEach(k => {
      const arr = mergeList((a && a[k]) || [], (b && b[k]) || [], m => m.t + '|' + m.u + '|' + m.x);
      if (arr.length) out[k] = arr;
    });
    return out;
  }
  function computeMerge(local, remote) {
    if (!remote) return local;
    if (!local) return remote;
    return {
      DATA:    mergeCards(local.DATA, remote.DATA),
      TRASH:   mergeList(local.TRASH, remote.TRASH, i => i.id + '|' + (i.deletedAt || 0)).slice(0, 100),
      LOG:     mergeList(local.LOG, remote.LOG, i => i.t + '|' + i.act + '|' + (i.cardId || '')).slice(0, 200),
      DISCUSS: mergeDiscuss(local.DISCUSS, remote.DISCUSS),
      COLUMNS: (remote.COLUMNS && remote.COLUMNS.length >= 2) ? remote.COLUMNS : local.COLUMNS,
      _ts: Math.max(local._ts || 0, remote._ts || 0)
    };
  }

  const GH_API = () => `https://api.github.com/repos/${CONFIG.channel.repo}/contents/${CONFIG.channel.file}`;
  const b64enc = o => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
  const b64dec = s => JSON.parse(decodeURIComponent(escape(atob(String(s).replace(/\s/g, '')))));

  async function ghGet() {
    const ch = CONFIG.channel;
    const url = GH_API() + (ch.branch ? ('?ref=' + ch.branch) : '');
    const res = await fetch(url, {
      headers: ch.token ? { Authorization: 'token ' + ch.token } : {},
      cache: 'no-store'
    });
    if (res.status === 404) return { sha: null, data: null };   // 仓库/文件未建
    if (!res.ok) throw new Error('GET ' + res.status);
    const j = await res.json();
    return { sha: j.sha, data: j.content ? b64dec(j.content) : null };
  }
  async function ghPut(payload, sha, retries) {
    const ch = CONFIG.channel;
    const body = {
      message: `board sync · ${CONFIG.me} · ${new Date().toLocaleString('zh-CN')}`,
      content: b64enc(payload),
      ...(sha ? { sha } : {})
    };
    if (ch.branch) body.branch = ch.branch;
    const res = await fetch(GH_API(), {
      method: 'PUT',
      headers: { Authorization: 'token ' + ch.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if ((res.status === 409 || res.status === 422) && retries > 0) {
      const cur = await ghGet();
      const merged = computeMerge(collectLocal(), cur.data);
      applyState(merged);
      return ghPut(merged, cur.sha, retries - 1);
    }
    if (!res.ok) throw new Error('PUT ' + res.status);
    return res.json();
  }

  function setDot(state, txt) {
    if (!root) return;
    const dot = root.querySelector('.syncdot'); if (!dot) return;
    const i = dot.querySelector('i');
    if (i) i.style.background = state === 'ok' ? '#10b981' : state === 'busy' ? '#f59e0b' : state === 'err' ? '#ef4444' : '#888';
    const t = dot.querySelector('.stxt'); if (t) t.textContent = txt;
  }

  async function doSyncChannel(channel) {
    const ch = CONFIG.channel;
    if (channel !== 'github' || ch.type === 'local') return;
    if (!ch.token) { setDot('err', '未配 token · 仅本地'); return; }
    if (syncing) { pendingPush = true; return; }
    syncing = true; setDot('busy', '同步中…');
    try {
      const cur = await ghGet();
      const merged = computeMerge(collectLocal(), cur.data);
      applyState(merged);
      await ghPut(merged, cur.sha, 3);
      saveLocal(); render();
      setDot('ok', '已同步 · ' + fmtT(now()));
      emit('push', { count: DATA.length });
    } catch (e) {
      setDot('err', '同步失败');
      emit('push-error', { error: String(e) });
    } finally {
      syncing = false;
      if (pendingPush) { pendingPush = false; doSyncChannel('github'); }
    }
  }
  /* 800ms 节流：拖拽/连续编辑只推一次 */
  function scheduleSync() {
    if (CONFIG.channel.type === 'local') return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => doSyncChannel('github'), 800);
  }
  /* 每次本地变更都调它：落盘 + 节流上云 */
  function save() { saveLocal(); scheduleSync(); }

  async function pull() {
    const ch = CONFIG.channel;
    if (ch.type === 'local') { setDot('warn', '本地模式 · 未接云端'); return; }
    setDot('busy', '拉取中…');
    try {
      const cur = await ghGet();
      if (!cur.data) {
        setDot('busy', '首次上行…');
        if (ch.token) await ghPut(collectLocal(), null, 3);
        saveLocal();
        setDot('ok', '已建云端 · ' + fmtT(now()));
        emit('pull', { count: DATA.length });
        return;
      }
      const merged = computeMerge(collectLocal(), cur.data);
      applyState(merged);
      saveLocal(); render();
      setDot('ok', '已同步 · ' + fmtT(now()));
      emit('pull', { count: DATA.length });
    } catch (e) {
      setDot('err', '拉取失败');
      emit('pull-error', { error: String(e) });
    }
  }

  /* ============================================================
     日志 & 撤销栈
     ============================================================ */
  function log(act, cardId, detail) {
    LOG.unshift({ t: now(), by: CONFIG.me, act, cardId: cardId || null, detail: detail || '' });
    if (LOG.length > 200) LOG.pop();
  }
  function actLabel(a) {
    return { move:'拖动卡片', edit:'编辑保存', create:'新建卡片', delete:'删除卡片', restore:'还原卡片',
      undo:'撤销', redo:'重做', discuss:'发表讨论', template:'套用模板', merge:'自动合并',
      column:'修改列', 'conflict-resolve':'解决冲突', draft:'存草稿' }[a] || a;
  }
  function snapshot() { UNDO.push(JSON.stringify({ DATA, TRASH, LOG, DISCUSS, COLUMNS })); if (UNDO.length > 30) UNDO.shift(); REDO = []; updateUndoBtns(); }
  function applySnap(str) { const s = JSON.parse(str); DATA = s.DATA; TRASH = s.TRASH; LOG = s.LOG; DISCUSS = s.DISCUSS; COLUMNS = s.COLUMNS; }
  function undo() { if (!UNDO.length) return; REDO.push(JSON.stringify({ DATA, TRASH, LOG, DISCUSS, COLUMNS })); applySnap(UNDO.pop()); log('undo', null, '撤销'); save(); render(); toast('已撤销'); }
  function redo() { if (!REDO.length) return; UNDO.push(JSON.stringify({ DATA, TRASH, LOG, DISCUSS, COLUMNS })); applySnap(REDO.pop()); log('redo', null, '重做'); save(); render(); toast('已重做'); }
  function updateUndoBtns() {
    if (!root) return;
    const u = root.querySelector('.undoBtn'), r = root.querySelector('.redoBtn');
    if (u) u.disabled = !UNDO.length;
    if (r) r.disabled = !REDO.length;
  }

  /* ============================================================
     21 + 42 冲突处理
     ============================================================ */
  function showConflict(card, field, myVal, remote) {
    const m = root.querySelector('.conflictModal');
    const b = root.querySelector('.cbody');
    if (!m || !b) return;
    b.innerHTML = `
      <div style="font-size:12.5px">卡片 <b>${esc(card.name)}</b> 的<b>「${fieldLabel(field)}」</b>被你
      和 <b style="color:${roleOf(remote.by).c}">${roleOf(remote.by).n}</b> 同时修改。</div>
      <div class="fielddiff">
        <div class="fd pick"><h4>👤 你的改动（${fmtT(now())}）</h4><div class="v">${esc(fieldVal(field, myVal))}</div></div>
        <div class="fd"><h4>👥 ${roleOf(remote.by).n} 的改动（${fmtT(remote.at)}）</h4><div class="v">${esc(fieldVal(field, remote.val))}</div></div>
      </div>
      <div class="mut tiny" style="margin-top:9px">💡 点下方任一按钮决定保留哪版；数值类字段的「合并」取较新值。</div>`;
    m.classList.add('show');
    const close = () => m.classList.remove('show');
    root.querySelector('#cfMine').onclick = () => { card[field] = myVal; card.updatedAt = now(); log('conflict-resolve', card.id, `冲突取「我的」：${fieldLabel(field)}`); REMOTE_PENDING = null; close(); save(); render(); toast('已保留你的改动'); };
    root.querySelector('#cfTheirs').onclick = () => { card[field] = remote.val; card.updatedAt = now(); log('conflict-resolve', card.id, `冲突取「${roleOf(remote.by).n}的」：${fieldLabel(field)}`); REMOTE_PENDING = null; close(); save(); render(); toast(`已保留 ${roleOf(remote.by).n} 的改动`, 'warn'); };
    root.querySelector('#cfMerge').onclick = () => {
      if (field === 'prog') card[field] = Math.max(+myVal || 0, +remote.val || 0);
      else card[field] = myVal;
      card.updatedAt = now(); log('conflict-resolve', card.id, `冲突合并：${fieldLabel(field)}`);
      REMOTE_PENDING = null; close(); save(); render(); toast('已合并两者 ✅');
    };
  }
  /* 42 字段级合并：改「别人没动的字段」→ 静默合并 */
  function changeField(cardId, field, val) {
    const c = DATA.find(x => x.id === cardId); if (!c) return;
    if (REMOTE_PENDING && REMOTE_PENDING.cardId === cardId && REMOTE_PENDING.field !== field) {
      c[field] = val; c.updatedAt = now();
      log('merge', cardId, `自动合并：我改「${fieldLabel(field)}」，${roleOf(REMOTE_PENDING.by).n}改「${fieldLabel(REMOTE_PENDING.field)}」`);
      toast(`✅ 与 ${roleOf(REMOTE_PENDING.by).n} 的改动自动合并，无需处理`);
      REMOTE_PENDING = null; save(); render(); return;
    }
    if (REMOTE_PENDING && REMOTE_PENDING.cardId === cardId && REMOTE_PENDING.field === field) {
      snapshot(); showConflict(c, field, val, REMOTE_PENDING); return;
    }
    snapshot();
    c[field] = val; c.updatedAt = now();
    log('edit', cardId, `改${fieldLabel(field)}：${fieldVal(field, val)}`);
    save(); render();
  }

  /* ============================================================
     样式（全在 Shadow DOM 内，:host{all:initial} 保证零污染）
     ============================================================ */
  const CSS = `
  :host { all: initial; display: block;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .t-root { font-size: 13px; line-height: 1.5; color: #333; }
  /* 6 套 NIKO 主题令牌（跟随宿主 data-theme） */
  .t-root[data-th="default"]{--app-bg:#f5f2ed;--accent:#667eea;--accent2:#764ba2;--card-bg:#fff;--card-bg-2:#faf9f7;--card-border:#e8e6e1;--text:#333;--muted:#888}
  .t-root[data-th="midnight"]{--app-bg:#14141c;--accent:#818cf8;--accent2:#a78bfa;--card-bg:#1f1f2e;--card-bg-2:#181824;--card-border:#333345;--text:#d0d0d8;--muted:#888899}
  .t-root[data-th="forest"]{--app-bg:#101c15;--accent:#34d399;--accent2:#10b981;--card-bg:#16251b;--card-bg-2:#101c14;--card-border:#2a4235;--text:#d1e8da;--muted:#7fb39a}
  .t-root[data-th="mocha"]{--app-bg:#1e1611;--accent:#f5a524;--accent2:#d97706;--card-bg:#251b12;--card-bg-2:#1c140d;--card-border:#3d2e1f;--text:#ece0d2;--muted:#a08a72}
  .t-root[data-th="ocean"]{--app-bg:#0e192b;--accent:#38bdf8;--accent2:#2563eb;--card-bg:#12203a;--card-bg-2:#0d1829;--card-border:#24406a;--text:#d6e6f7;--muted:#7ea2c8}
  .t-root[data-th="lavender"]{--app-bg:#171129;--accent:#a78bfa;--accent2:#7c3aed;--card-bg:#1d1535;--card-bg-2:#151027;--card-border:#3a2d63;--text:#e0d9f5;--muted:#9a8fc0}
  .t-root { background: var(--app-bg); color: var(--text); border-radius: 12px; overflow: hidden;
    border: 1px solid var(--card-border); position: relative; }
  .top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 13px;background:var(--card-bg);border-bottom:1px solid var(--card-border)}
  .brand{font-weight:700;font-size:14px;white-space:nowrap}.brand small{font-weight:400;color:var(--muted);font-size:11px}
  .spacer{flex:1}
  .grp{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
  .gb{padding:4px 10px;border-radius:6px;border:1px solid var(--card-border);background:var(--card-bg);color:var(--muted);cursor:pointer;font-size:11.5px;white-space:nowrap;font-family:inherit}
  .gb:hover{border-color:var(--accent)}
  .gb.on{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border-color:transparent;font-weight:600}
  .gb:disabled{opacity:.45;cursor:not-allowed}
  .syncdot{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted);padding:3px 9px;border-radius:6px;border:1px solid var(--card-border);cursor:pointer;background:var(--card-bg-2)}
  .syncdot i{width:8px;height:8px;border-radius:50%;background:#888;display:block}
  .kpibar{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:1px;background:var(--card-border);border-bottom:1px solid var(--card-border)}
  .kpi{background:var(--card-bg);padding:8px 13px;cursor:pointer}
  .kpi:hover{background:var(--card-bg-2)}
  .kpi .n{font-size:19px;font-weight:700;line-height:1.15}
  .kpi .l{font-size:10px;color:var(--muted);margin-top:1px}
  .toolbar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:11px 13px 0}
  .search{padding:5px 10px;border-radius:7px;border:1px solid var(--card-border);background:var(--card-bg);color:var(--text);font-size:12px;width:170px;outline:none;font-family:inherit}
  .search:focus{border-color:var(--accent)}
  .cols{display:grid;gap:10px;align-items:start;padding:11px 13px 13px}
  .col{background:var(--card-bg-2);border:1px solid var(--card-border);border-radius:10px;overflow:hidden}
  .col.over{box-shadow:0 0 0 2px var(--accent)}
  .ch{padding:8px 10px;display:flex;align-items:center;gap:6px;font-weight:600;font-size:12px;border-bottom:1px solid var(--card-border);background:var(--card-bg)}
  .ch .cnt{margin-left:auto;color:#fff;font-size:10.5px;font-weight:700;padding:1px 8px;border-radius:9px}
  .ch .colMenu{cursor:pointer;color:var(--muted);font-size:13px;padding:0 3px}
  .ch .colMenu:hover{color:var(--accent)}
  .cb{padding:7px;display:flex;flex-direction:column;gap:7px;min-height:70px;max-height:60vh;overflow-y:auto}
  .empty{text-align:center;color:var(--muted);font-size:10.5px;padding:16px 0}
  .card{background:var(--card-bg);border:1px solid var(--card-border);border-left:3px solid var(--accent);border-radius:8px;padding:8px 9px;cursor:grab;transition:transform .13s,box-shadow .13s;position:relative}
  .card:hover{transform:translateY(-2px);box-shadow:0 4px 14px rgba(0,0,0,.1)}
  .card.dragging{opacity:.4;transform:rotate(2deg)}
  .card.locked{opacity:.62}
  .card.ghost{opacity:.35;border-style:dashed}
  .lockTag{position:absolute;top:-7px;right:6px;background:#ef4444;color:#fff;font-size:9px;padding:1px 6px;border-radius:8px;font-weight:700}
  .ct{font-weight:650;font-size:12.5px;display:flex;gap:5px;align-items:flex-start;margin-bottom:5px;padding-right:14px}
  .pri{font-size:9.5px;font-weight:800;padding:1px 5px;border-radius:3px;flex-shrink:0}
  .pri.P0{background:#ef4444;color:#fff}.pri.P1{background:#f59e0b;color:#fff}.pri.P2{background:var(--card-border);color:var(--muted)}
  .meta{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--muted);margin-bottom:5px}
  .av{width:17px;height:17px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;flex-shrink:0}
  .prog{display:flex;align-items:center;gap:5px;margin-bottom:5px}
  .pb{flex:1;height:5px;border-radius:3px;background:var(--card-bg-2);overflow:hidden}
  .pb>i{display:block;height:100%;border-radius:3px;transition:width .3s}
  .note{font-size:10.5px;color:var(--muted);padding:4px 6px;border-radius:5px;background:var(--card-bg-2);line-height:1.4;border-left:2px solid var(--card-border)}
  .cft{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:10px;color:var(--muted)}
  .cft .miniBtn{cursor:pointer;padding:1px 5px;border-radius:4px;border:1px solid var(--card-border)}
  .cft .miniBtn:hover{border-color:var(--accent);color:var(--accent)}
  .due{margin-left:auto;font-weight:700}
  /* 2026-10-13 由「右侧抽屉」改「居中弹窗」（用户要求：编辑窗口放中间）+ 遮罩 + 备注框放大 */
  .dscrim{position:absolute;inset:0;background:rgba(0,0,0,.45);z-index:4;opacity:0;pointer-events:none;transition:opacity .22s}
  .dscrim.show{opacity:1;pointer-events:auto}
  .drawer{position:absolute;left:50%;top:50%;width:min(640px,94%);max-height:88%;background:var(--card-bg);border:1px solid var(--card-border);border-radius:14px;z-index:5;transform:translate(-50%,-50%) scale(.97);opacity:0;pointer-events:none;transition:transform .22s ease,opacity .22s ease;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,.34)}
  .drawer.show{transform:translate(-50%,-50%) scale(1);opacity:1;pointer-events:auto}
  .dhd{padding:12px 16px;border-bottom:1px solid var(--card-border);display:flex;align-items:center;gap:9px;font-weight:700}
  .dbd{padding:14px 16px;overflow-y:auto;flex:1}
  .dft{padding:11px 16px;border-top:1px solid var(--card-border);display:flex;gap:8px}
  .closeX{margin-left:auto;cursor:pointer;color:var(--muted);font-size:17px;line-height:1;padding:2px 6px;border-radius:5px}
  .closeX:hover{background:var(--card-bg-2);color:var(--text)}
  .field{margin-bottom:11px}
  .flabel{font-size:10.5px;color:var(--muted);margin-bottom:3px}
  input[type=text],input[type=date],select,textarea{border:1px solid var(--card-border);background:var(--card-bg);color:var(--text);border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit;outline:none;width:100%}
  input:focus,select:focus,textarea:focus{border-color:var(--accent)}
  input[type=range]{width:100%;accent-color:var(--accent)}
  textarea{resize:vertical;min-height:56px}
  textarea.noteArea{min-height:168px;line-height:1.7}
  .btn{padding:4px 12px;border-radius:6px;border:1px solid var(--card-border);background:var(--card-bg);cursor:pointer;font-size:11.5px;color:var(--text);font-family:inherit;white-space:nowrap}
  .btn:hover{border-color:var(--accent)}
  .btn.pri{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border-color:transparent;font-weight:600}
  .btn.pri:hover{filter:brightness(1.08)}
  .btn.danger{background:#ef4444;color:#fff;border-color:transparent}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .disc{background:var(--card-bg-2);border:1px solid var(--card-border);border-radius:8px;padding:9px;margin-bottom:8px}
  .disc-i{display:flex;gap:7px;margin-bottom:9px}
  .disc-b{flex:1;min-width:0}
  .disc-h{display:flex;align-items:center;gap:6px;font-size:11px}
  .disc-h .tm{margin-left:auto;color:var(--muted);font-size:10px}
  .disc-t{font-size:11.5px;margin-top:3px;word-break:break-word}
  .disc-t .at{color:var(--accent);font-weight:600}
  .batchbar{position:absolute;bottom:0;left:0;right:0;background:var(--card-bg);border-top:1px solid var(--card-border);padding:10px 14px;display:flex;align-items:center;gap:9px;flex-wrap:wrap;box-shadow:0 -3px 14px rgba(0,0,0,.13);z-index:6;transform:translateY(110%);transition:transform .22s}
  .batchbar.show{transform:translateY(0)}
  .batchbar .sel{font-weight:700;font-size:12.5px}
  .batchbar .sel b{color:var(--accent);font-size:16px}
  .toast{position:absolute;bottom:70px;left:50%;transform:translateX(-50%) translateY(90px);background:#10b981;color:#fff;padding:9px 18px;border-radius:9px;font-weight:600;font-size:12.5px;opacity:0;transition:all .28s;z-index:20;pointer-events:none;display:flex;align-items:center;gap:9px;max-width:90%}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .toast.warn{background:#f59e0b}.toast.err{background:#ef4444}
  .toast .undoBtn{background:rgba(255,255,255,.22);border:none;color:#fff;padding:3px 10px;border-radius:5px;cursor:pointer;font-size:11.5px;font-weight:600;font-family:inherit;pointer-events:auto}
  .modal{position:absolute;inset:0;background:rgba(0,0,0,.55);z-index:30;display:none;align-items:center;justify-content:center;padding:20px}
  .modal.show{display:flex}
  .mbox{background:var(--card-bg);border-radius:12px;max-width:600px;width:100%;max-height:86%;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--card-border)}
  .mhd{padding:13px 17px;border-bottom:1px solid var(--card-border);display:flex;align-items:center;gap:9px;font-weight:700}
  .mbd{padding:15px 17px;overflow-y:auto;flex:1}
  .mft{padding:12px 17px;border-top:1px solid var(--card-border);display:flex;gap:8px;justify-content:flex-end}
  .fielddiff{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:9px}
  .fd{border:1px solid var(--card-border);border-radius:8px;padding:9px}
  .fd h4{font-size:11px;color:var(--muted);margin-bottom:6px;font-weight:600}
  .fd .v{font-size:12px;padding:4px 7px;border-radius:5px;background:var(--card-bg-2);margin-bottom:4px;word-break:break-word}
  .fd.pick{border-color:var(--accent);box-shadow:0 0 0 2px rgba(102,126,234,.2)}
  .tl{position:relative;padding-left:15px}
  .tl::before{content:'';position:absolute;left:4px;top:4px;bottom:4px;width:2px;background:var(--card-border)}
  .tl-i{position:relative;margin-bottom:11px;font-size:11.5px}
  .tl-i::before{content:'';position:absolute;left:-14px;top:5px;width:8px;height:8px;border-radius:50%;background:var(--accent)}
  .tl-i .tm{font-size:10px;color:var(--muted)}
  .trash-i{display:flex;align-items:center;gap:9px;padding:9px;border:1px solid var(--card-border);border-radius:8px;margin-bottom:7px;background:var(--card-bg-2)}
  .tmpl{display:flex;align-items:center;gap:9px;padding:10px;border:1px solid var(--card-border);border-left-width:3px;border-radius:8px;margin-bottom:7px;background:var(--card-bg-2);cursor:pointer}
  .tmpl:hover{border-color:var(--accent)}
  .tmpl .tn{font-weight:650;font-size:12.5px}
  .tmpl .td{font-size:10.5px;color:var(--muted);margin-top:2px}
  .hidden{display:none!important}
  .mut{color:var(--muted)}.tiny{font-size:10.5px}
  .row{display:flex;align-items:center;gap:7px}
  .chkbox{width:15px;height:15px;accent-color:var(--accent);cursor:pointer;flex-shrink:0}
  `;

  /* ============================================================
     渲染
     ============================================================ */
  function curTheme() {
    if (CONFIG.theme === 'dark') return 'midnight';
    if (CONFIG.theme === 'light') return 'default';
    try {
      const dt = document.documentElement.dataset.theme || '';
      if (/default|midnight|forest|mocha|ocean|lavender/.test(dt)) return dt;
      const host = hostEl && hostEl.closest ? hostEl.closest('[data-theme]') : null;
      if (host && /default|midnight|forest|mocha|ocean|lavender/.test(host.dataset.theme)) return host.dataset.theme;
      return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'midnight' : 'default';
    } catch (e) { return 'default'; }
  }

  function visible() {
    let list = DATA;
    if (CONFIG.showMyView && VIEW === 'mine') list = list.filter(a => a.owner === CONFIG.me);
    if (FILTER === 'mine') list = list.filter(a => a.owner === CONFIG.me);
    else if (FILTER === 'P0') list = list.filter(a => a.pri === 'P0');
    else if (FILTER === 'bug') list = list.filter(a => a.status === 'bug');
    else if (FILTER === 'blocked') list = list.filter(a => a.status === 'bug' || LOCKED[a.id]);
    if (KW) {
      const k = KW.toLowerCase();
      list = list.filter(a => (a.name + a.note + (a.tags || []).join() + roleOf(a.owner).n).toLowerCase().includes(k));
    }
    return list;
  }

  /* 影子根只搭一次：style + 持久层（抽屉/弹窗/toast）+ 可重绘主区 .surface
     —— 这样 toast() 不会被后续 render() 抹掉 */
  function buildChrome() {
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="t-root" data-th="${curTheme()}">
        <div class="surface"></div>
        <div class="dscrim" id="dScrim"></div>
        <div class="drawer" id="drawer">
          <div class="dhd"><span id="dTitle">卡片</span><span class="closeX" id="dClose">×</span></div>
          <div class="dbd" id="dBody"></div>
          <div class="dft" id="dFoot"></div>
        </div>
        <div class="modal conflictModal">
          <div class="mbox">
            <div class="mhd">⚠️ 检测到编辑冲突 <span class="spacer"></span><span class="closeX" id="cfClose">×</span></div>
            <div class="mbd cbody"></div>
            <div class="mft">
              <button class="btn" id="cfMine">保留我的</button>
              <button class="btn" id="cfTheirs">保留对方的</button>
              <button class="btn pri" id="cfMerge">合并两者 ✅</button>
            </div>
          </div>
        </div>
        <div class="modal genericModal">
          <div class="mbox">
            <div class="mhd"><span id="gmTitle">标题</span><span class="spacer"></span><span class="closeX" id="gmClose">×</span></div>
            <div class="mbd" id="gmBody"></div>
            <div class="mft" id="gmFoot"></div>
          </div>
        </div>
        <div class="toast"></div>
      </div>`;
    // 持久层事件只绑一次
    root.querySelector('#dClose').onclick = closeDrawer;
    root.querySelector('#dScrim').onclick = closeDrawer;   // 点遮罩也关
    root.querySelector('#gmClose').onclick = () => closeModal('genericModal');
    root.querySelector('#cfClose').onclick = () => closeModal('conflictModal');
    root.addEventListener('click', onRootClick);
    root.addEventListener('change', onRootChange);
  }

  function render() {
    if (!root) return;
    const theme = curTheme();
    const tr = root.querySelector('.t-root');
    if (tr) tr.dataset.th = theme;
    const surf = root.querySelector('.surface');
    if (!surf) return;
    surf.innerHTML = `
        <div class="top">
          <div class="brand">🎮 UE 团队看板 <small>· 共 ${DATA.length} 项</small></div>
          <div class="spacer"></div>
          <div class="syncdot" id="syncDot"><i></i><span class="stxt">初始化…</span></div>
          <div class="grp">
            <button class="gb undoBtn" disabled>↶ 撤销</button>
            <button class="gb redoBtn" disabled>↷ 重做</button>
          </div>
          <div class="grp">
            <button class="gb" id="tmplBtn">📋 模板</button>
            <button class="gb" id="trashBtn">🗑️ 回收站</button>
            <button class="gb" id="replayBtn">⏯ 回放</button>
            <button class="gb" id="summaryBtn">📊 今日摘要</button>
            ${CONFIG.showMyView ? `<button class="gb${VIEW === 'mine' ? ' on' : ''}" id="viewBtn">${VIEW === 'mine' ? '👤 我的' : '👤 全部'}</button>` : ''}
          </div>
        </div>
        <div class="kpibar" id="kpibar"></div>
        <div class="toolbar">
          <input class="search" id="q" placeholder="🔍 搜资产 / 负责人 / 标签" value="${esc(KW)}">
          <button class="gb${FILTER === 'all' ? ' on' : ''}" data-f="all">全部</button>
          <button class="gb${FILTER === 'mine' ? ' on' : ''}" data-f="mine">只看我的</button>
          <button class="gb${FILTER === 'P0' ? ' on' : ''}" data-f="P0">🔴 P0</button>
          <button class="gb${FILTER === 'bug' ? ' on' : ''}" data-f="bug">🐛 BUG</button>
          <button class="gb${FILTER === 'blocked' ? ' on' : ''}" data-f="blocked">🚧 阻塞</button>
          <div class="spacer"></div>
          <button class="gb${BATCH ? ' on' : ''}" id="batchToggle">☑️ 批量</button>
          <button class="btn pri" id="newBtn" style="padding:5px 14px">+ 新建卡片</button>
        </div>
        <div class="cols" id="cols"></div>
        <div class="batchbar${BATCH ? ' show' : ''}" id="batchbar">
          <div class="sel">已选 <b id="selCnt">${SEL.size}</b> 张</div>
          <button class="gb" id="bAll">全选</button>
          <button class="gb" id="bNone">清空</button>
          <select id="bStatus" style="width:auto">
            <option value="">改状态…</option>
            ${Object.entries(ST).map(([k, v]) => `<option value="${k}">${v.l}</option>`).join('')}
          </select>
          <select id="bOwner" style="width:auto">
            <option value="">改负责人…</option>
            ${Object.entries(ROLE).map(([id, u]) => `<option value="${id}">${u.n}</option>`).join('')}
          </select>
          <select id="bPri" style="width:auto">
            <option value="">改优先级…</option><option>P0</option><option>P1</option><option>P2</option>
          </select>
          <button class="btn danger" id="bDel">🗑️ 批量删除</button>
          <div class="spacer"></div>
          <button class="gb" id="batchClose">退出批量</button>
        </div>`;
    renderKPI();
    renderBoard();
    bindStatic();
    updateUndoBtns();
    updateSel();
    const ch = CONFIG.channel;
    setDot(ch.type === 'local' ? 'warn' : (ch.token ? 'ok' : 'err'),
           ch.type === 'local' ? '本地模式' : (ch.token ? '已连云端' : '未配 token · 仅本地'));
  }

  function renderKPI() {
    const list = visible();
    const cnt = k => list.filter(a => a.status === k).length;
    const total = list.length;
    const avg = total ? Math.round(list.reduce((s, a) => s + (a.prog || 0), 0) / total) : 0;
    const urgent = list.filter(a => a.status !== 'done' && daysLeft(a.due) <= 2).length;
    const mine = DATA.filter(a => a.owner === CONFIG.me && a.status !== 'done').length;
    const blocked = list.filter(a => a.status === 'bug' || LOCKED[a.id]).length;
    const items = [
      [total, '资产总数', 'var(--text)', ''],
      [cnt('doing'), '开发中', '#3b82f6', 'doing'],
      [cnt('bug'), 'BUG', '#ef4444', 'bug'],
      [cnt('review'), '待验收', '#8b5cf6', 'review'],
      [cnt('done'), '已完成', '#10b981', 'done'],
      [avg + '%', '平均完成', '#f59e0b', ''],
      [urgent, '⏰ 2天内到期', '#ef4444', ''],
      [mine, '我的在手', '#667eea', 'mine'],
      [blocked, '🚧 阻塞', '#ef4444', '']
    ];
    const kb = root.querySelector('#kpibar');
    kb.innerHTML = items.map(([n, l, c, f]) =>
      `<div class="kpi" data-f="${f}"><div class="n" style="color:${c}">${n}</div><div class="l">${l}</div></div>`).join('');
    kb.querySelectorAll('.kpi[data-f]').forEach(k => k.onclick = () => {
      if (!k.dataset.f) return;
      const f = k.dataset.f;
      FILTER = (FILTER === f ? 'all' : f);
      root.querySelectorAll('.toolbar .gb[data-f]').forEach(x => x.classList.toggle('on', x.dataset.f === FILTER));
      render();
    });
  }

  function renderBoard() {
    const list = visible();
    const colsEl = root.querySelector('#cols');
    const hasDone = COLUMNS.some(c => c.k === 'done');
    const total = COLUMNS.length + (hasDone ? 0 : 1);
    colsEl.style.gridTemplateColumns = `repeat(${Math.min(total, 6)},1fr)`;
    colsEl.innerHTML = COLUMNS.map(col => {
      const items = list.filter(a => a.status === col.k);
      return `<div class="col" data-k="${col.k}">
        <div class="ch">
          <i style="width:8px;height:8px;border-radius:2px;background:${col.c};display:block"></i>
          ${esc(col.l)}<span class="cnt" style="background:${col.c}">${items.length}</span>
          <span class="colMenu" data-colmenu="${col.k}">⋮</span>
        </div>
        <div class="cb" data-k="${col.k}">
          ${items.map(cardHTML).join('') || '<div class="empty">—</div>'}
        </div></div>`;
    }).join('') + (hasDone ? '' : doneColumnHTML(list));
    bindDnD();
  }
  /* 已完成列（done）不在 COLUMNS 里，单独补一个可拖入的完成区 */
  function doneColumnHTML(list) {
    const items = list.filter(a => a.status === 'done');
    return `<div class="col" data-k="done">
      <div class="ch"><i style="width:8px;height:8px;border-radius:2px;background:${ST.done.c};display:block"></i>
        ${ST.done.l}<span class="cnt" style="background:${ST.done.c}">${items.length}</span></div>
      <div class="cb" data-k="done">${items.map(cardHTML).join('') || '<div class="empty">—</div>'}</div></div>`;
  }
  function cardHTML(a) {
    const st = ST[a.status] || ST.todo, u = roleOf(a.owner), dl = daysLeft(a.due);
    const dc = a.status === 'done' ? '#10b981' : dl < 0 ? '#10b981' : dl <= 2 ? '#ef4444' : dl <= 5 ? '#f59e0b' : 'var(--muted)';
    const lock = LOCKED[a.id], sel = BATCH && SEL.has(a.id), dcount = (DISCUSS[a.id] || []).length;
    return `<div class="card${lock ? ' locked' : ''}${sel ? ' ghost' : ''}" draggable="${lock ? 'false' : 'true'}" data-id="${a.id}" style="border-left-color:${st.c}">
      ${lock ? `<span class="lockTag">🔴 ${roleOf(lock.by).n}正在编辑</span>` : ''}
      ${BATCH ? `<input type="checkbox" class="chkbox" data-chk="${a.id}" ${sel ? 'checked' : ''} style="position:absolute;top:8px;right:8px">` : ''}
      <div class="ct">${esc(a.name)}<span class="pri ${a.pri}">${a.pri}</span></div>
      <div class="meta">${av(a.owner)}${u.n}
        <span style="margin-left:auto;color:${dc};font-weight:700">${a.status === 'done' ? '已完成' : dl < 0 ? '超期' : dl + '天'}</span></div>
      <div class="prog"><div class="pb"><i style="width:${a.prog}%;background:${st.c}"></i></div>
        <span class="tiny mut">${a.prog}%</span></div>
      <div class="note">${esc(a.note)}</div>
      <div class="cft">
        <span class="miniBtn" data-disc="${a.id}">💬 ${dcount}</span>
        <span class="miniBtn" data-hist="${a.id}">🕘 历史</span>
        <span class="miniBtn" data-del="${a.id}">🗑️</span>
      </div>
    </div>`;
  }
  function av(id, sz) {
    const u = roleOf(id);
    return `<span class="av" style="background:${u.c};${sz ? `width:${sz}px;height:${sz}px;font-size:${sz * 0.53}px` : ''}">${u.n.slice(-1)}</span>`;
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function bindStatic() {
    root.querySelector('.undoBtn').onclick = undo;
    root.querySelector('.redoBtn').onclick = redo;
    root.querySelector('#syncDot').onclick = showSyncPanel;
    root.querySelector('#tmplBtn').onclick = showTemplates;
    root.querySelector('#trashBtn').onclick = showTrash;
    root.querySelector('#replayBtn').onclick = showReplay;
    root.querySelector('#summaryBtn').onclick = showSummary;
    const vb = root.querySelector('#viewBtn');
    if (vb) vb.onclick = () => { VIEW = VIEW === 'mine' ? 'all' : 'mine'; render(); };
    root.querySelector('#q').oninput = e => { KW = e.target.value.trim(); renderKPI(); renderBoard(); updateSel(); };
    root.querySelectorAll('.toolbar .gb[data-f]').forEach(b => b.onclick = () => {
      FILTER = b.dataset.f; renderKPI(); renderBoard(); updateSel();
      root.querySelectorAll('.toolbar .gb[data-f]').forEach(x => x.classList.toggle('on', x.dataset.f === FILTER));
    });
    root.querySelector('#newBtn').onclick = newCard;
    root.querySelector('#batchToggle').onclick = toggleBatch;
    root.querySelector('#batchClose').onclick = toggleBatch;
    root.querySelector('#bAll').onclick = () => { visible().forEach(a => SEL.add(a.id)); renderBoard(); updateSel(); };
    root.querySelector('#bNone').onclick = () => { SEL.clear(); renderBoard(); updateSel(); };
    root.querySelector('#bStatus').onchange = e => batchSet('status', e.target.value, e.target);
    root.querySelector('#bOwner').onchange = e => batchSet('owner', e.target.value, e.target);
    root.querySelector('#bPri').onchange = e => batchSet('pri', e.target.value, e.target);
    root.querySelector('#bDel').onclick = batchDelete;
  }

  function onRootClick(e) {
    const colMenu = e.target.closest('[data-colmenu]');
    if (colMenu) { e.stopPropagation(); return showColumnMenu(colMenu.dataset.colmenu); }
    const disc = e.target.closest('[data-disc]');
    if (disc) { e.stopPropagation(); return openDrawer(disc.dataset.disc, true); }
    const hist = e.target.closest('[data-hist]');
    if (hist) { e.stopPropagation(); return showHistory(hist.dataset.hist); }
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); return deleteCard(del.dataset.del); }
    const card = e.target.closest('.card');
    if (card && !e.target.closest('.chkbox')) {
      if (BATCH) { return; }
      if (LOCKED[card.dataset.id]) toast(`🔴 ${roleOf(LOCKED[card.dataset.id].by).n} 正在编辑，你暂时只能看`, 'warn');
      openDrawer(card.dataset.id);
    }
  }
  function onRootChange(e) {
    if (e.target.dataset && e.target.dataset.chk) {
      const id = e.target.dataset.chk;
      e.target.checked ? SEL.add(id) : SEL.delete(id);
      updateSel();
    }
  }

  /* ---------- 拖拽（06 + 24 真锁） ---------- */
  let dragId = null;
  function bindDnD() {
    root.querySelectorAll('.card').forEach(c => {
      if (c.classList.contains('locked')) return;
      c.ondragstart = ev => { dragId = c.dataset.id; c.classList.add('dragging'); try { ev.dataTransfer.effectAllowed = 'move'; } catch (x) {} };
      c.ondragend = () => c.classList.remove('dragging');
    });
    root.querySelectorAll('.cb').forEach(cb => {
      cb.ondragover = ev => { ev.preventDefault(); const col = cb.closest('.col'); if (col) col.classList.add('over'); };
      cb.ondragleave = () => { const col = cb.closest('.col'); if (col) col.classList.remove('over'); };
      cb.ondrop = ev => {
        ev.preventDefault();
        const col = cb.closest('.col'); if (col) col.classList.remove('over');
        if (!dragId) return;
        const a = DATA.find(x => x.id === dragId); if (!a) return;
        if (LOCKED[a.id]) toast(`⚠️ ${roleOf(LOCKED[a.id].by).n} 正在编辑「${a.name}」，你的改动可能被覆盖`, 'warn');
        const old = a.status, nk = cb.dataset.k;
        if (old === nk) { dragId = null; return; }
        snapshot();
        a.status = nk; if (nk === 'done') a.prog = 100; a.updatedAt = now();
        log('move', a.id, `从「${(ST[old] || {}).l || old}」拖到「${(ST[nk] || {}).l || nk}」`);
        dragId = null; save(); render();
        toast(`已移动到「${(ST[nk] || {}).l || nk}」`, '', () => undo());
      };
    });
  }

  /* ---------- 抽屉：编辑 + 讨论（43 草稿 / 51 讨论 / 24 锁） ---------- */
  let curCard = null;
  function openDrawer(id, focusDisc) {
    const a = DATA.find(x => x.id === id); if (!a) return;
    curCard = a;
    const lock = LOCKED[a.id], draft = a.draft, dcount = (DISCUSS[a.id] || []).length;
    root.querySelector('#dTitle').innerHTML = `${esc(a.name)} ${lock ? `<span class="tiny" style="color:#ef4444">· 🔴 ${roleOf(lock.by).n}正在编辑</span>` : ''}`;
    root.querySelector('#dBody').innerHTML = `
      ${lock ? `<div class="disc" style="border-color:#ef4444;background:rgba(239,68,68,.07)">
        <b style="font-size:11.5px">🔴 ${roleOf(lock.by).n} 正在编辑这张卡</b>
        <div class="tiny mut" style="margin-top:4px">${fmtT(lock.at)} 开始 · 你的保存会与对方的改动做合并校验</div></div>` : ''}
      ${draft ? `<div class="disc" style="border-color:#8b5cf6;background:rgba(139,92,246,.07)">
        <div class="row"><b style="font-size:11.5px">📝 还有一份未提交草稿</b>
        <button class="btn" style="margin-left:auto;padding:2px 9px;font-size:10.5px" id="useDraft">恢复</button>
        <button class="btn" style="padding:2px 9px;font-size:10.5px" id="dropDraft">丢弃</button></div></div>` : ''}
      <div class="field"><div class="flabel">资产名称</div><input type="text" id="fName" value="${esc(a.name)}"></div>
      <div class="row" style="gap:9px">
        <div class="field" style="flex:1"><div class="flabel">状态</div>
          <select id="fStatus">${COLUMNS.map(c => `<option value="${c.k}" ${a.status === c.k ? 'selected' : ''}>${c.l}</option>`).join('')}
            <option value="done" ${a.status === 'done' ? 'selected' : ''}>已完成</option></select></div>
        <div class="field" style="flex:1"><div class="flabel">负责人</div>
          <select id="fOwner">${Object.entries(ROLE).map(([id2, u]) => `<option value="${id2}" ${a.owner === id2 ? 'selected' : ''}>${u.n}</option>`).join('')}</select></div>
      </div>
      <div class="row" style="gap:9px">
        <div class="field" style="flex:1"><div class="flabel">优先级</div>
          <select id="fPri">${['P0','P1','P2'].map(p => `<option ${a.pri === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        <div class="field" style="flex:1"><div class="flabel">交付日</div>
          <input type="date" id="fDue" value="${dstr(a.due)}"></div>
      </div>
      <div class="field"><div class="flabel">进度 <b id="progVal">${a.prog}%</b></div>
        <input type="range" id="fProg" min="0" max="100" value="${a.prog}"></div>
      <div class="field"><div class="flabel">备注</div><textarea id="fNote" class="noteArea">${esc(a.note)}</textarea></div>
      <div class="flabel" style="margin-top:4px">💬 讨论（${dcount}）· 讨论留在卡上，三个月后还能查到</div>
      <div class="disc" id="discList">
        ${(DISCUSS[a.id] || []).map(d => `<div class="disc-i">${av(d.u, 22)}
          <div class="disc-b"><div class="disc-h"><b>${roleOf(d.u).n}</b><span class="tm">${fmtT(d.t)}</span></div>
          <div class="disc-t">${esc(d.x).replace(/@(我|月饼|邢锦)/g, '<span class="at">@$1</span>')}</div></div></div>`).join('')
        || '<div class="tiny mut">还没有讨论 · 第一个说点什么</div>'}
      </div>
      <div class="row" style="gap:6px;margin-top:8px">
        <input type="text" id="discInput" placeholder="回复…（支持 @我 @月饼 @邢锦）" style="flex:1">
        <button class="btn pri" id="discSend">发送</button>
      </div>`;
    root.querySelector('#dFoot').innerHTML = `
      <button class="btn pri" id="saveCard">💾 提交保存</button>
      <button class="btn" id="draftCard">📝 存草稿</button>
      <div class="spacer"></div>
      <button class="btn danger" id="delCard">🗑️ 删除</button>`;
    root.querySelector('#fProg').oninput = e => { const p = root.querySelector('#progVal'); if (p) p.textContent = e.target.value + '%'; };
    root.querySelector('#saveCard').onclick = () => saveCard(a);
    root.querySelector('#draftCard').onclick = () => saveDraft(a);
    root.querySelector('#delCard').onclick = () => { deleteCard(a.id, true); };   // 确认后才关抽屉
    const ud = root.querySelector('#useDraft'); if (ud) ud.onclick = () => { a.draft = null; save(); openDrawer(a.id); toast('草稿已还原到编辑框'); };
    const dd = root.querySelector('#dropDraft'); if (dd) dd.onclick = () => { snapshot(); a.draft = null; save(); render(); closeDrawer(); toast('草稿已丢弃'); };
    root.querySelector('#discSend').onclick = () => sendDisc(a.id);
    root.querySelector('#discInput').onkeydown = e => { if (e.key === 'Enter') sendDisc(a.id); };
    root.querySelector('#drawer').classList.add('show');
    root.querySelector('#dScrim').classList.add('show');
    if (focusDisc) setTimeout(() => { const i = root.querySelector('#discInput'); if (i) i.focus(); }, 260);
  }
  function closeDrawer() {
    const d = root.querySelector('#drawer'); if (d) d.classList.remove('show');
    const s = root.querySelector('#dScrim'); if (s) s.classList.remove('show');
    curCard = null;
  }
  function sendDisc(id) {
    const inp = root.querySelector('#discInput'); if (!inp) return;
    const v = inp.value.trim(); if (!v) return;
    snapshot();
    (DISCUSS[id] = DISCUSS[id] || []).push({ u: CONFIG.me, t: now(), x: v });
    log('discuss', id, `讨论：${v.slice(0, 20)}`);
    const m = v.match(/@(我|月饼|邢锦)/g);
    if (m) toast(`📨 已在讨论里 @ ${m.join('、')}，对方会收到提醒`);   // 27 @我提醒
    save(); render(); openDrawer(id, true);
  }
  function saveDraft(a) {
    snapshot();
    a.draft = {
      name: root.querySelector('#fName').value, status: root.querySelector('#fStatus').value,
      owner: root.querySelector('#fOwner').value, pri: root.querySelector('#fPri').value,
      due: +new Date(root.querySelector('#fDue').value).setHours(18, 0, 0, 0),
      prog: +root.querySelector('#fProg').value, note: root.querySelector('#fNote').value
    };
    log('draft', a.id, '存草稿（未提交）');
    save(); closeDrawer(); render();
    toast('📝 已存为草稿 · 别人看到的还是旧值', 'warn');   // 43 草稿暂存
  }
  function saveCard(a) {
    snapshot();
    const fields = {
      name: root.querySelector('#fName').value, status: root.querySelector('#fStatus').value,
      owner: root.querySelector('#fOwner').value, pri: root.querySelector('#fPri').value,
      due: +new Date(root.querySelector('#fDue').value).setHours(18, 0, 0, 0),
      prog: +root.querySelector('#fProg').value, note: root.querySelector('#fNote').value
    };
    let conflicts = [];
    Object.entries(fields).forEach(([k, v]) => {
      if (a[k] !== v) {
        if (REMOTE_PENDING && REMOTE_PENDING.cardId === a.id && REMOTE_PENDING.field === k) conflicts.push(k);
        else a[k] = v;
      }
    });
    a.updatedAt = now(); a.draft = null;
    if (conflicts.length) { showConflict(a, conflicts[0], fields[conflicts[0]], REMOTE_PENDING); render(); return; }
    log('edit', a.id, '编辑保存');
    save(); render(); closeDrawer();
    toast('✅ 已保存' + (REMOTE_PENDING ? '（已智能合并，无冲突）' : ''), '', () => undo());
  }

  /* ---------- 删除 / 回收站（47） ---------- */
  function deleteCard(id, closeAfter) {
    const i = DATA.findIndex(x => x.id === id); if (i < 0) return;
    const a = DATA[i];
    askConfirm({
      title: '🗑️ 删除卡片',
      html: `删除「<b>${esc(a.name)}</b>」？<br><span class="tiny mut">会移入回收站，30 天内可还原。</span>`,
      ok: '删除', danger: true,
      then: yes => {
        if (!yes) return;
        const j = DATA.findIndex(x => x.id === id); if (j < 0) return;
        if (closeAfter) closeDrawer();
        doDeleteCard(j, DATA[j]);
      }
    });
  }
  function doDeleteCard(i, a) {
    snapshot();
    TRASH.unshift({ ...a, deletedAt: now(), deletedBy: CONFIG.me });
    DATA.splice(i, 1);
    log('delete', a.id, `删除「${a.name}」`);
    save(); render();
    toast(`已移入回收站：${a.name}`, '', () => restoreFromTrash(a.id));
  }
  function restoreFromTrash(id, closeAfter) {
    const i = TRASH.findIndex(x => x.id === id); if (i < 0) return;
    snapshot();
    const a = TRASH.splice(i, 1)[0]; delete a.deletedAt; delete a.deletedBy;
    DATA.push(a);
    log('restore', id, `还原「${a.name}」`);
    save(); render();
    toast(`已还原：${a.name}`, '', () => undo());
    if (closeAfter) closeModal('genericModal');
  }
  function showTrash() {
    root.querySelector('#gmTitle').innerHTML = '🗑️ 回收站';
    root.querySelector('#gmBody').innerHTML = TRASH.length
      ? TRASH.map(a => `<div class="trash-i">
          <div style="flex:1"><div style="font-weight:650;font-size:12.5px">${esc(a.name)}</div>
          <div class="tiny mut">${roleOf(a.deletedBy).n} 删除 · ${fmtT(a.deletedAt)} · 30 天内可还原</div></div>
          <button class="btn pri" data-restore="${a.id}">还原</button></div>`).join('')
        + '<div class="mut tiny" style="margin-top:9px">💡 删除只是标记，30 天后才真删</div>'
      : '<div class="mut" style="text-align:center;padding:28px 0">回收站是空的 ✅</div>';
    root.querySelector('#gmFoot').innerHTML = TRASH.length
      ? `<button class="btn danger" id="clearTrash">清空回收站</button>` : '';
    openModal('genericModal');
    root.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => restoreFromTrash(b.dataset.restore, true));
    const ct = root.querySelector('#clearTrash');
    if (ct) ct.onclick = () => { snapshot(); TRASH = []; save(); render(); closeModal('genericModal'); toast('回收站已清空', 'warn'); };
  }

  /* ---------- 模板（37 新建 + 58 字段级） ---------- */
  const TEMPLATES = [
    { n: '🎭 角色资产标准卡', d: '建模+绑定+动画+材质+蓝图+音效', c: '#667eea', steps: ['建模','绑定','动画','材质','蓝图','音效'] },
    { n: '🗺️ 场景关卡标准卡', d: '地形+植被+光照+碰撞+优化', c: '#10b981', steps: ['地形','植被','光照','碰撞','性能优化'] },
    { n: '✨ 特效标准卡', d: '粒子+材质+音效+LOD', c: '#ec4899', steps: ['粒子','材质','音效','LOD'] },
    { n: '🐛 BUG 报告标准卡', d: '复现步骤+期望+实际+UE版本+日志', c: '#ef4444', steps: ['复现步骤','期望','实际','UE版本','日志'] }
  ];
  function showTemplates() {
    root.querySelector('#gmTitle').innerHTML = '📋 新建卡片模板';
    root.querySelector('#gmBody').innerHTML =
      '<div class="mut tiny" style="margin-bottom:9px">选模板 → 自动生成整套标准格式卡片：</div>' +
      TEMPLATES.map((t, i) => `<div class="tmpl" data-tmpl="${i}" style="border-left-color:${t.c}">
        <div style="flex:1"><div class="tn">${t.n}</div><div class="td">${t.d}</div></div>
        <button class="btn pri" style="padding:3px 11px">使用</button></div>`).join('');
    root.querySelector('#gmFoot').innerHTML = '';
    openModal('genericModal');
    root.querySelectorAll('[data-tmpl]').forEach(el => el.onclick = () => useTemplate(+el.dataset.tmpl));
  }
  function useTemplate(i) {
    const t = TEMPLATES[i]; snapshot();
    const base = now();
    t.steps.forEach((s, idx) => {
      DATA.push({
        id: 'n' + now() + '_' + idx, name: '（新）' + s,
        type: t.n.includes('角色') ? '角色' : t.n.includes('场景') ? '场景' : t.n.includes('特效') ? '特效' : 'BUG',
        owner: CONFIG.me, status: 'todo', prog: 0, due: base + (14 + idx * 2) * 86400000, pri: 'P2',
        note: `由模板「${t.n}」生成 · 第 ${idx + 1}/${t.steps.length} 步`, tags: [], createdAt: now(), updatedAt: now(), draft: null
      });
    });
    log('template', null, `套用模板「${t.n}」生成 ${t.steps.length} 张卡`);
    save(); render(); closeModal('genericModal');
    toast(`✅ 已生成 ${t.steps.length} 张卡（${t.n}）`, '', () => undo());
  }
  function newCard() {
    snapshot();
    const id = 'n' + now();
    DATA.unshift({ id, name: '新卡片', type: '通用', owner: CONFIG.me, status: 'todo', prog: 0, due: now() + 7 * 86400000, pri: 'P2', note: '', tags: [], createdAt: now(), updatedAt: now(), draft: null });
    log('create', id, '新建卡片');
    save(); render(); openDrawer(id);
  }

  /* ---------- 列自定义（56） ---------- */
  function showColumnMenu(k) {
    const col = COLUMNS.find(c => c.k === k); if (!col) return;
    root.querySelector('#gmTitle').innerHTML = '⚙️ 自定义列';
    root.querySelector('#gmBody').innerHTML = `
      <div class="mut tiny" style="margin-bottom:9px">改列名/颜色 · 加列删列 · 一人改全队生效（改完自动同步）</div>
      <div class="field"><div class="flabel">列名</div><input type="text" id="colName" value="${esc(col.l)}"></div>
      <div class="field"><div class="flabel">颜色</div><input type="text" id="colColor" value="${esc(col.c)}" placeholder="#3b82f6"></div>
      <div class="field"><div class="flabel">排序</div>
        <div class="row" style="gap:6px"><button class="btn" id="colUp">↑ 上移</button><button class="btn" id="colDn">↓ 下移</button></div></div>`;
    root.querySelector('#gmFoot').innerHTML = `<button class="btn danger" id="colDel">删除此列</button><button class="btn pri" id="colSave">保存</button>`;
    openModal('genericModal');
    root.querySelector('#colSave').onclick = () => {
      snapshot();
      col.l = root.querySelector('#colName').value || col.l;
      col.c = root.querySelector('#colColor').value || col.c;
      log('column', null, `改列「${col.l}」`);
      save(); render(); closeModal('genericModal'); toast('列已更新');
    };
    root.querySelector('#colUp').onclick = () => { const i = COLUMNS.indexOf(col); if (i > 0) { COLUMNS.splice(i, 1); COLUMNS.splice(i - 1, 0, col); save(); render(); } };
    root.querySelector('#colDn').onclick = () => { const i = COLUMNS.indexOf(col); if (i < COLUMNS.length - 1) { COLUMNS.splice(i, 1); COLUMNS.splice(i + 1, 0, col); save(); render(); } };
    root.querySelector('#colDel').onclick = () => {
      if (COLUMNS.length <= 2) { toast('至少保留 2 列', 'err'); return; }
      snapshot();
      const moved = DATA.filter(a => a.status === k).length;
      COLUMNS = COLUMNS.filter(c => c.k !== k);
      save(); render(); closeModal('genericModal');
      toast(`已删除该列（${moved} 张卡需要重新分配）`, 'warn');
    };
  }

  /* ---------- 回放（44）+ 时光机（23） ---------- */
  function showReplay() {
    root.querySelector('#gmTitle').innerHTML = '⏯ 操作回放 · 今天';
    root.querySelector('#gmBody').innerHTML = LOG.length
      ? `<div class="tl">${LOG.slice(0, 40).map(l => {
          const c = l.cardId && DATA.find(x => x.id === l.cardId);
          return `<div class="tl-i"><div><b>${roleOf(l.by).n}</b> <span class="mut">${actLabel(l.act)}</span>
            ${c ? `<b style="color:var(--accent)">${esc(c.name)}</b>` : ''}
            <div class="tm">${fmtT(l.t)} ${esc(l.detail || '')}</div></div></div>`;
        }).join('')}</div><div class="mut tiny" style="margin-top:9px">💡 像回放录像一样看团队今天做了什么</div>`
      : '<div class="mut" style="text-align:center;padding:28px 0">还没有操作记录 · 试着拖一张卡看看</div>';
    root.querySelector('#gmFoot').innerHTML = '';
    openModal('genericModal');
  }
  function showHistory(id) {
    const c = DATA.find(x => x.id === id); if (!c) return;
    const logs = LOG.filter(l => l.cardId === id);
    root.querySelector('#gmTitle').innerHTML = `🕘 变更时光机 · ${esc(c.name)}`;
    root.querySelector('#gmBody').innerHTML = logs.length
      ? `<div class="tl">${logs.map(l => `<div class="tl-i"><div><b>${roleOf(l.by).n}</b> ${esc(l.detail || actLabel(l.act))}<div class="tm">${fmtT(l.t)}</div></div></div>`).join('')}</div>
         <div class="mut tiny" style="margin-top:9px">💡 谁在什么时候改了什么，一目了然</div>`
      : '<div class="mut" style="text-align:center;padding:24px 0">这张卡还没有变更记录</div>';
    root.querySelector('#gmFoot').innerHTML = '';
    openModal('genericModal');
  }

  /* ---------- 每日变更摘要（30）+ 今日待办（26）+ 阻塞升级（28） ---------- */
  function showSummary() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const t0 = +today;
    const todayLog = LOG.filter(l => l.t >= t0);
    const bugCnt = DATA.filter(a => a.status === 'bug').length;
    const urgent = DATA.filter(a => a.status !== 'done' && daysLeft(a.due) <= 2);
    const mineToday = DATA.filter(a => a.owner === CONFIG.me && a.status !== 'done');
    const blocked = DATA.filter(a => a.status === 'bug' || LOCKED[a.id]);
    root.querySelector('#gmTitle').innerHTML = '📊 今日变更摘要 · ' + dstr(now());
    root.querySelector('#gmBody').innerHTML = `
      <div class="trash-i"><div style="flex:1"><b>📌 团队今日操作</b>
        <div class="tiny mut">共 ${todayLog.length} 次变更 · ${LOG.length} 次历史记录</div></div></div>
      <div class="trash-i"><div style="flex:1"><b>⏰ 2 天内到期（含超期）</b>
        <div class="tiny mut">${urgent.length ? urgent.slice(0, 6).map(a => esc(a.name) + '（' + (daysLeft(a.due) < 0 ? '超期' : daysLeft(a.due) + '天') + '）').join(' · ') : '暂无，节奏健康 ✅'}</div></div>
        <span style="color:#ef4444;font-weight:700">${urgent.length}</span></div>
      <div class="trash-i"><div style="flex:1"><b>👤 我的在手资产</b>
        <div class="tiny mut">${mineToday.length ? mineToday.slice(0, 6).map(a => esc(a.name)).join(' · ') : '全部完成 ✅'}</div></div>
        <span style="color:#667eea;font-weight:700">${mineToday.length}</span></div>
      <div class="trash-i"><div style="flex:1"><b>🚧 阻塞 / BUG 升级</b>
        <div class="tiny mut">${blocked.length ? blocked.slice(0, 6).map(a => esc(a.name)).join(' · ') : '无阻塞 ✅'}</div></div>
        <span style="color:#ef4444;font-weight:700">${bugCnt}</span></div>
      <div class="mut tiny" style="margin-top:10px">💡 每天开场扫一眼这条摘要，三人不用再互相问进度。</div>`;
    root.querySelector('#gmFoot').innerHTML = '';
    openModal('genericModal');
  }

  /* ---------- 同步 / 备份牌（48） ---------- */
  function showSyncPanel() {
    const ch = CONFIG.channel;
    root.querySelector('#gmTitle').innerHTML = '☁️ 数据同步 · 备份牌';
    root.querySelector('#gmBody').innerHTML = `
      <div class="trash-i"><div style="flex:1"><b>☁️ GitHub 通道</b>
        <div class="tiny mut">仓库 <b>${esc(ch.repo)}</b> · 文件 ${esc(ch.file)} · 分支 ${esc(ch.branch || 'main')}</div></div>
        <span style="color:${ch.type === 'local' ? '#888' : '#10b981'};font-weight:700">${ch.type === 'local' ? '⏸ 未接' : '✅ 已接'}</span></div>
      <div class="trash-i"><div style="flex:1"><b>🔑 写入 token</b>
        <div class="tiny mut">${ch.token ? '已配置 · ' + esc(String(ch.token).slice(0, 7)) + '…' : '未配置（只能公开读）'}</div></div>
        <span style="color:${ch.token ? '#10b981' : '#f59e0b'};font-weight:700">${ch.token ? '✅ 可用' : '⚠️ 缺失'}</span></div>
      <div class="trash-i"><div style="flex:1"><b>🏠 本地缓存</b>
        <div class="tiny mut">localStorage['${SYNC_PREFIX}data'] · 离线也能用</div></div>
        <span style="color:#10b981;font-weight:700">✅ 正常</span></div>
      <div class="mut tiny" style="margin-top:10px">💡 数据是<b>卡片级合并</b>：你改 A 字段、同事改 B 字段，互不覆盖；撞同一字段才弹冲突窗。</div>`;
    root.querySelector('#gmFoot').innerHTML =
      `<button class="btn pri" id="syncNow">🔄 立即同步</button>`;
    openModal('genericModal');
    root.querySelector('#syncNow').onclick = () => { doSyncChannel('github'); toast('☁️ 正在同步…'); };
  }

  /* ---------- 批量（33） ---------- */
  function toggleBatch() {
    BATCH = !BATCH; SEL.clear();
    const t = root.querySelector('#batchToggle');
    if (t) t.classList.toggle('on', BATCH);
    const bar = root.querySelector('#batchbar');
    if (bar) bar.classList.toggle('show', BATCH);
    render(); updateSel();
  }
  function updateSel() {
    const c = root.querySelector('#selCnt'); if (c) c.textContent = SEL.size;
    const bar = root.querySelector('#batchbar'); if (bar) bar.classList.toggle('show', BATCH);
  }
  function batchSet(field, val, el) {
    if (!val || !SEL.size) { el.value = ''; return; }
    snapshot();
    SEL.forEach(id => { const a = DATA.find(x => x.id === id); if (a) { a[field] = val; if (field === 'status' && val === 'done') a.prog = 100; a.updatedAt = now(); } });
    log('edit', null, `批量改${fieldLabel(field)}为「${fieldVal(field, val)}」· ${SEL.size} 张`);
    el.value = ''; save(); render();
    toast(`已批量改${fieldLabel(field)}（${SEL.size} 张）`, '', () => undo());
  }
  function batchDelete() {
    if (!SEL.size) return;
    const n = SEL.size;
    askConfirm({
      title: '🗑️ 批量删除',
      html: `确定删除选中的 <b>${n}</b> 张卡？<br><span class="tiny mut">会移入回收站，可还原。</span>`,
      ok: '删除', danger: true,
      then: yes => { if (!yes) return; doBatchDelete(); }
    });
  }
  function doBatchDelete() {
    const n = SEL.size;
    snapshot();
    [...SEL].forEach(id => {
      const i = DATA.findIndex(x => x.id === id);
      if (i >= 0) { TRASH.unshift({ ...DATA[i], deletedAt: now(), deletedBy: CONFIG.me }); DATA.splice(i, 1); }
    });
    log('delete', null, `批量删除 ${n} 张`);
    SEL.clear(); save(); render();
    toast('已批量删除，可在回收站还原', '', () => undo());
  }

  /* ---------- Toast / Modal ---------- */
  function toast(msg, type, undoFn) {
    if (!root) return;
    const t = root.querySelector('.toast'); if (!t) return;
    t.className = 'toast show' + (type ? ' ' + type : '');
    t.innerHTML = esc(msg) + (undoFn ? ' <button class="undoBtn">撤销</button>' : '');
    if (undoFn) { const b = t.querySelector('.undoBtn'); if (b) b.onclick = () => { undoFn(); t.classList.remove('show'); }; }
    clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('show'), undoFn ? 4200 : 2400);
  }
  function openModal(cls) { const m = root.querySelector('.' + cls); if (m) m.classList.add('show'); }
  function closeModal(cls) { const m = root.querySelector('.' + cls); if (m) m.classList.remove('show'); }
  /* 页面内确认框（2026-10-13 替代原生 confirm —— 原生弹窗又丑、手机端还容易被拦）
     ⚠️ 原生 confirm 是同步的，这里换成异步 ⇒ 调用方必须把「确认后要做的事」写成 then 回调 */
  function askConfirm(opt) {
    if (!root) return;
    root.querySelector('#gmTitle').innerHTML = opt.title || '确认';
    root.querySelector('#gmBody').innerHTML =
      `<div style="font-size:13.5px;line-height:1.75">${opt.html || esc(opt.msg || '')}</div>`;
    root.querySelector('#gmFoot').innerHTML =
      `<button class="btn" id="gmCancel">${esc(opt.cancel || '取消')}</button>` +
      `<button class="btn ${opt.danger ? 'danger' : 'pri'}" id="gmOk">${esc(opt.ok || '确定')}</button>`;
    const done = v => { closeModal('genericModal'); if (typeof opt.then === 'function') opt.then(v); };
    root.querySelector('#gmCancel').onclick = () => done(false);
    root.querySelector('#gmOk').onclick = () => done(true);
    openModal('genericModal');
  }

  /* ---------- 键盘（35 撤销重做） ---------- */
  function onKeydown(e) {
    if (!mounted) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'y') { e.preventDefault(); redo(); }
    if (e.key === 'Escape') { closeDrawer(); closeModal('genericModal'); closeModal('conflictModal'); }
  }

  /* ============================================================
     事件总线
     ============================================================ */
  const listeners = {};
  function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return api; }
  function emit(ev, payload) { (listeners[ev] || []).forEach(fn => { try { fn(payload); } catch (e) {} }); }

  /* ============================================================
     公开 API
     ============================================================ */
  const api = {
    version: VERSION,
    config(opt) {
      if (!opt) return api;
      const { channel, ...rest } = opt;
      CONFIG = { ...CONFIG, ...rest, channel: { ...CONFIG.channel, ...(channel || {}) } };
      VIEW = CONFIG.defaultView;
      if (CONFIG.channel.token) { try { localStorage.setItem(SYNC_PREFIX + 'token', CONFIG.channel.token); } catch (e) {} }
      return api;
    },
    get data() { return DATA.slice(); },
    set data(list) { DATA = list || []; render(); save(); },
    get columns() { return COLUMNS.slice(); },
    get trash() { return TRASH.slice(); },
    get log() { return LOG.slice(); },
    pull, push: () => doSyncChannel('github'),
    setMembers(roles) { Object.assign(ROLE, roles); render(); return api; },
    /* 21/42 外部注入「远端改动」（对方工作站推送后，本地探测到）
       改不同字段 → 自动静默合并；同字段 → 弹冲突窗 */
    applyRemoteChange(cardId, field, val, by) {
      const c = DATA.find(x => x.id === cardId); if (!c) return api;
      const other = by || 'a';
      if (c[field] === val) return api;                       // 无差异
      REMOTE_PENDING = { cardId, field, val, by: other, at: now() - 3000, base: c[field] };
      // 若本地当前也没在编辑该卡 → 直接静默合并（42）
      if (!curCard || curCard.id !== cardId) { c[field] = val; c.updatedAt = now(); REMOTE_PENDING = null; save(); render(); }
      return api;
    },
    /* 模拟「别人正在编辑」锁（24） */
    setLock(cardId, by) { if (by) LOCKED[cardId] = { by, at: now() }; else delete LOCKED[cardId]; render(); return api; },
    on,
    mount(sel) {
      hostEl = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!hostEl) return api;
      root = hostEl.attachShadow ? hostEl.attachShadow({ mode: 'open' }) : hostEl;
      if (!root.querySelector) root = hostEl;   // 极端兜底
      VIEW = CONFIG.defaultView;
      // 首次：本地 → 无则种子
      const local = loadLocal();
      if (local) applyState(local);
      if (!DATA.length) DATA = seed();
      if (!mounted) { mounted = true; document.addEventListener('keydown', onKeydown); }
      buildChrome();
      render();
      pull();
      emit('mount', { count: DATA.length, view: VIEW });
      return api;
    },
    destroy() {
      if (pollTimer) clearInterval(pollTimer);
      if (hostEl && hostEl.shadowRoot) hostEl.shadowRoot.innerHTML = '';
      mounted = false;
      document.removeEventListener('keydown', onKeydown);
    }
  };
  global.NikoTeam = api;

  /* ============================================================
     自动挂载（宿主页只需 <div id="niko-team"> + script）
     ============================================================ */
  function autoMount() {
    const el = document.getElementById('niko-team') || document.querySelector('[data-niko-team]');
    if (!el) return;
    const ds = el.dataset || {};
    const opt = {};
    if (ds.me) opt.me = ds.me;
    if (ds.theme) opt.theme = ds.theme;
    if (ds.view) opt.defaultView = ds.view;
    const chOpt = {};
    if (ds.repo) chOpt.repo = ds.repo;
    if (ds.file) chOpt.file = ds.file;
    if (ds.branch) chOpt.branch = ds.branch;
    const tokenFromAttr = ds.token || null;
    let tokenFromStore = null;
    try { tokenFromStore = localStorage.getItem(SYNC_PREFIX + 'token'); } catch (e) {}
    if (tokenFromAttr || tokenFromStore) chOpt.token = tokenFromAttr || tokenFromStore;
    if (Object.keys(chOpt).length) opt.channel = chOpt;
    if (Object.keys(opt).length) api.config(opt);
    api.mount(el);
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount);
    else autoMount();
  }

})(typeof window !== 'undefined' ? window : this);
