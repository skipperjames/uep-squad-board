/* ============================================================
   team.js —— UE 团队看板「植入工具」  v2.15.0-20261021
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
     · ★ 按记录/字段三方合并；同字段冲突暂停上传，由用户选择
     · SHA 冲突自动重试（409/422 → 重拉+重合并+重推）
     · 800ms 节流推送（拖拽高频写入不触发 SHA 风暴）
     · 全量走白名单键 niko_team_*，绝不外泄个人数据
   ============================================================ */
(function (global) {
  'use strict';

  const VERSION = 'v2.15.0-20261021'; // 移除空的里程碑、工时统计、资产流程模块，保留任务/BUG/日志

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
    tone: 'soft',                          // v3-20 语气档：soft 陈述事实 | standard 报进度 | strict 催办（设备本地偏好，不同步）
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
    b:  { n: '邢锦', c: '#e879f9', r: '美术TA' }
  };
  /* v2.4.4：成员名字只准活在这里 —— 全代码其余地方一律用派生变量，改名字只动这一行 */
  /* ---------- v3-19 · 成员 / 多人负责人 公共件 ---------- */
  /* 一条记录可以有多个负责人：存储用「逗号串」（'me,a'），全代码统一走 ownerIds 解析，
     这样老数据（单值）不用迁移、新数据天然兼容。 */
  function ownerIds(v) { return String(v == null ? '' : v).split(/[,，;；\s]+/).filter(Boolean); }
  function ownerFirst(v) { return ownerIds(v)[0] || ''; }
  /* v3-20 · 排期语气档（设备本地偏好，不进团队数据）
     soft     = 只陈述事实：「1 天前 / 今天 / 3 天后」，逾期不上红
     standard = 报进度：「逾期 1 天 / 今天到期 / 剩 3 天」（旧行为）
     strict   = 催办：逾期标红加粗 */
  function toneMode() { return (CONFIG.tone === 'strict' || CONFIG.tone === 'standard') ? CONFIG.tone : 'soft'; }
  function overWord() { return toneMode() === 'soft' ? '待跟进' : '逾期'; }
  function overColor() { return toneMode() === 'soft' ? '#f5a524' : '#ef4444'; }
  /* 讨论 / 提醒里的人：色点 + 人色名字 */
  function whoName(id) {
    const r = roleOf(id);
    return '<b class="tb-who" style="color:' + esc(r.c) + '"><i style="background:' + esc(r.c) + '"></i>' + esc(r.n) + '</b>';
  }
  /* 成员名以「团队数据」为真相源（以前只存本机 localStorage → 换台机器又叫回默认名） */
  function applyCloudMemberNames() {
    const m = EXTRA && EXTRA.members;
    if (!m) return;
    Object.keys(m).forEach(function (k) { if (ROLE[k] && m[k]) ROLE[k].n = String(m[k]); });
  }
  /* 一次性迁移：云端还没存过名字、但本机改过名（NIKO 的 niko_team_roles）→ 搬进团队数据。
     只搬「和默认名不一样」的那几条，之后云端就是唯一真相源。 */
  let memberMigrated = false;
  function migrateMemberNames() {
    if (memberMigrated) return;
    memberMigrated = true;
    if (EXTRA && EXTRA.members && Object.keys(EXTRA.members).length) return;
    let local = {};
    try { local = JSON.parse(localStorage.getItem('niko_team_roles') || '{}') || {}; } catch (e) { return; }
    const names = {}; let dirty = false;
    Object.keys(ROLE).forEach(function (k) {
      const v = local[k] && local[k].n;
      if (v && String(v) !== String(ROLE[k].n)) { names[k] = String(v); dirty = true; }
    });
    if (!dirty) return;
    EXTRA.members = names;
    try { save(); } catch (e) {}
  }
  /* @ 提示文案与高亮正则必须是「算出来的」，不能启动时固化 —— 否则改名后提示还是旧名字 */
  function mentionHint() { return '@' + Object.values(ROLE).map(function (r) { return r.n; }).join(' @'); }
  function mentionRe() {
    return new RegExp('@(' + Object.values(ROLE).map(function (r) {
      return String(r.n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('|') + ')', 'g');
  }
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
  let mounted=false,themeObserver=null,themeMedia=null;

  const now = () => Date.now();
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  // v2.3.2：把已转义文本里的 URL 变成可点链接（先 esc 再包 <a>，天然防注入）
  const linkify = s => String(s == null ? '' : s).replace(/(https?:\/\/[^\s<]+)/g, '<a class="gd-a" href="$1" target="_blank" rel="noopener noreferrer" title="点击打开链接">$1</a>');
  // v2.3.2：项目资源区折叠状态（设备本地 localStorage，不进任何同步通道）
  const resFoldMap = () => { try { return JSON.parse(localStorage.getItem('niko_team_resfold') || '{}'); } catch (e) { return {}; } };
  const resFolded = pid => resFoldMap()[pid] !== 0; // 没动过 = 默认收起
  const toggleResFold = pid => { const m = resFoldMap(); m[pid] = (m[pid] === 0 ? 1 : 0); try { localStorage.setItem('niko_team_resfold', JSON.stringify(m)); } catch (e) {} };
  // v2.7.0（v3-17）：公告从资源区抽出，独立成底部渐变大字条 —— 单独位置、显眼、不随资源折叠
  const noticeBar = p => {
    if (!p || !p.notice) return '';
    return '<div class="tk-ann"><div class="tk-ann-t">📢 公告</div><div class="tk-ann-c">' + linkify(esc(p.notice)) + '</div></div>';
  };
  // v2.3.2：复制到剪贴板（Shadow DOM / 非 https 环境兜底走 execCommand）
  const copyText = (txt, ok) => {
    const done = () => { if (ok) ok(); };
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(done, () => { legacyCopy(txt); done(); }); }
    else { legacyCopy(txt); done(); }
  };
  const legacyCopy = txt => {
    const ta = document.createElement('textarea');
    ta.value = txt; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  };
  const fmtT = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
  const daysLeft = ms => Math.round((ms - now()) / 86400000);
  const dstr = ms => { const d = new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
  const fieldLabel = f => ({ prog:'进度', note:'任务说明', owner:'负责人', status:'状态', pri:'优先级', due:'交付日', name:'名称',__timeResult:'计时结束与耗时',title:'标题',description:'说明',acceptance:'验收标准',dependsOn:'前置任务',category:'工作分类' }[f] || f);
  const fieldVal = (f, v) => {
    if (f === 'status') return ST[v] ? ST[v].l : v;
    if (f === 'owner') return ownerIds(v).map(function(id){return (ROLE[id]||{}).n||id;}).join('、') || '未指派';
    if (f === 'prog') return v + '%';
    if (f === 'due') return dstr(v);
    return String(v);
  };
  const roleOf = id => ROLE[id] || { n: id ? String(id) : '未指派', c: '#888', r: '' };

  /* v2.2: shared development records. Preferences/drafts are local only. */
  const DEV_KEYS = {devProject:'devProjects',devTask:'devTasks',devBug:'devBugs',devLog:'devLogs'};
  const RETIRED_DEV_KEYS = ['devMilestones','devTimes','devAssets'];
  const STAGE_LIST = ['资产制作','UV 拆分','材质制作','UI 制作','美术场景搭建','玩法程序','系统功能','工具脚本','优化调优','联调测试','策划','评审','文档'];
  const DEV_SCHEMA = {
    devProjects:{choices:{status:['active','paused','released','archived']}},
    devTasks:{choices:{status:['backlog','doing','review','done'],category:['玩法','程序','美术','技术美术','音频','测试','其他'],priority:['critical','high','mid','low']}},
    devBugs:{choices:{status:['open','fixing','verify','closed'],severity:['critical','high','medium','low']}},
    devLogs:{choices:{}}
  };
  const clone = x => JSON.parse(JSON.stringify(x));
  const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const uid = () => global.crypto?.randomUUID?.() || now().toString(36)+'-'+Math.random().toString(36).slice(2);
  let DEV = Object.fromEntries(Object.values(DEV_KEYS).map(k=>[k,[]]));
  const totalRecords=()=>DATA.length+Object.values(DEV).reduce((n,rows)=>n+rows.length,0);
  let DELETED = {}, EXTRA = {}, BASE = null, SAVED = null, CONFLICTS = [];
  let MODE = 'dev', syncStatus = ['warn','本地模式'], localDrafts = {}, modalOptions = null, modalReturn = null;
  let EDIT_DIRTY = false;   // v2.5：编辑弹窗脏数据标记
  let monotonic = 0;
  const tick = () => monotonic = Math.max(now(),monotonic+1);
  const sharedKeys = ['DATA',...Object.values(DEV_KEYS)];
  const timerFields=['startedAt','endedAt','minutes','sessionStartedAt','sessionEndedAt'];
  const isTimer=r=>r&&Object.hasOwn(r,'startedAt')&&r.category&&r.date;
  const fields = r => Object.keys(r||{}).filter(k=>!['id','createdAt','updatedAt','_ut','_fields','draft','_restoredAt',...(isTimer(r)?timerFields:[])].includes(k)).flatMap(k=>k==='checks'?Object.keys(r.checks||{}).map(s=>'checks.'+s):[k]).concat(isTimer(r)?['__timeResult']:[]);
  const getField = (r,k) => k==='__timeResult'?(isTimer(r)?Object.fromEntries(timerFields.map(k=>[k,r[k]||0])):undefined):k.startsWith('checks.') ? r?.checks?.[k.slice(7)] : r?.[k];
  function putField(r,k,v) {if(k==='__timeResult'){Object.assign(r,v);return;}if(k.startsWith('checks.'))(r.checks=r.checks||{})[k.slice(7)]=v;else if(v===undefined)delete r[k];else r[k]=clone(v);}
  function stamp(r, previous) {
    r._fields = {...r._fields};
    let changed = false;
    new Set([...fields(r),...fields(previous)]).forEach(k=>{
      if(!equal(getField(r,k),getField(previous,k))) {r._fields[k]={t:tick(),by:CONFIG.me};changed=true;}
    });
    if(changed) r.updatedAt=r._ut=tick();
    return r;
  }
  function stampAll(state) {
    sharedKeys.forEach(k=>(state[k]||[]).forEach(r=>stamp(r,(SAVED?.[k]||[]).find(p=>p.id===r.id))));
    (state.TRASH||[]).forEach(r=>{
      const key=(r.kind||'DATA')+'|'+r.id;
      if(!state.DELETED[key] || state.DELETED[key].at<r.deletedAt) state.DELETED[key]={at:r.deletedAt,by:r.deletedBy};
    });
    return state;
  }
  function mergeRecords(a,b,base,kind,tombs) {
    const map=new Map((b||[]).map(r=>[r.id,clone(r)]));
    (a||[]).forEach(l=>{
      const r=map.get(l.id), ancestor=(base||[]).find(x=>x.id===l.id);
      if(!r){map.set(l.id,clone(l));return;}
      const out=clone(r);out._fields={...r._fields};
      new Set([...fields(l),...fields(r)]).forEach(k=>{
        const lv=getField(l,k),rv=getField(r,k),bv=getField(ancestor,k);
        const lm=l._fields?.[k]||{t:l.updatedAt||0,by:l.updatedBy},rm=r._fields?.[k]||{t:r.updatedAt||0,by:r.updatedBy};
        const lc=ancestor&&!equal(lv,bv),rc=ancestor&&!equal(rv,bv);
        if(lc&&rc&&!equal(lv,rv)) {
          const key=kind+'|'+l.id+'|'+k;
          const pending=CONFLICTS.find(c=>c.key===key),conflict={key,kind,id:l.id,field:k,mine:lv,theirs:rv,by:rm.by,title:l.title||l.name||l.date||l.id};
          if(pending)Object.assign(pending,conflict);else CONFLICTS.push(conflict);
          putField(out,k,lv);out._fields[k]=lm;
        } else if(equal(lv,rv) ? lm.t>rm.t : ancestor ? lc&&!rc : lm.t>rm.t) {
          putField(out,k,lv);out._fields[k]=lm;
        }
      });
      out.updatedAt=out._ut=Math.max(l.updatedAt||0,r.updatedAt||0);
      out._restoredAt=Math.max(l._restoredAt||0,r._restoredAt||0);
      if(kind==='DATA') out.draft=null;
      map.set(l.id,out);
    });
    return [...map.values()].filter(r=>!tombs[kind+'|'+r.id] || (r._restoredAt||0)>tombs[kind+'|'+r.id].at);
  }
  function mergeShared(local,remote) {
    local=local||{};remote=remote||{};
    const tombs={...remote.DELETED};
    Object.entries(local.DELETED||{}).forEach(([k,v])=>{if(!tombs[k]||v.at>tombs[k].at)tombs[k]=v;});
    [...local.TRASH||[],...remote.TRASH||[]].forEach(r=>{const k=(r.kind||'DATA')+'|'+r.id;if(!tombs[k]||r.deletedAt>tombs[k].at)tombs[k]={at:r.deletedAt,by:r.deletedBy};});
    const merged={...remote,...local,DELETED:tombs,_schema:2,_v:VERSION,_ts:Math.max(local._ts||0,remote._ts||0),_by:CONFIG.me};
    sharedKeys.forEach(k=>merged[k]=mergeRecords(local[k],remote[k],BASE?.[k],k,tombs));
    merged.TRASH=mergeList(local.TRASH,remote.TRASH,r=>(r.kind||'DATA')+'|'+r.id+'|'+r.deletedAt).filter(r=>!(merged[r.kind||'DATA']||[]).some(x=>x.id===r.id&&(x._restoredAt||0)>r.deletedAt));
    merged.devTasks.forEach(t=>{if(Object.hasOwn(t,'milestoneId')){delete t.milestoneId;if(t._fields)delete t._fields.milestoneId;}const k='dependsOn',kind='devTasks',tomb=tombs[kind+'|'+t[k]];if(t[k]&&tomb&&!merged[kind].some(r=>r.id===t[k])){t._fields={...t._fields,[k]:{t:tomb.at,by:tomb.by}};t[k]='';}});
    RETIRED_DEV_KEYS.forEach(k=>delete merged[k]);
    merged.TRASH=(merged.TRASH||[]).filter(r=>!RETIRED_DEV_KEYS.includes(r.kind));
    merged.DELETED=Object.fromEntries(Object.entries(merged.DELETED||{}).filter(([k])=>!RETIRED_DEV_KEYS.some(x=>k.startsWith(x+'|'))));
    merged.LOG=mergeList(local.LOG,remote.LOG,r=>r.t+'|'+r.by+'|'+r.act+'|'+r.cardId).slice(0,200);
    merged.DISCUSS=mergeDiscuss(local.DISCUSS,remote.DISCUSS);
    merged.COLUMNS=(remote.COLUMNS?.length>=2)?remote.COLUMNS:local.COLUMNS;
    CONFLICTS=CONFLICTS.filter(c=>(merged[c.kind]||[]).some(r=>r.id===c.id));
    return normalizeSessions(merged);
  }
  function cacheBase(remote) {
    BASE=clone(remote||{});
    try { localStorage.setItem(SYNC_PREFIX+'base',JSON.stringify({repo:CONFIG.channel.repo,file:CONFIG.channel.file,branch:CONFIG.channel.branch,state:BASE})); } catch(e) {toast('同步基线缓存失败，下次打开请先拉取。','warn');}
  }
  function conflictBanner() {return CONFLICTS.length?'<div class="gd-running-notice"><span>有 '+CONFLICTS.length+' 个字段冲突，处理后才能上云。</span><button class="btn" id="resolveDev">处理冲突</button></div>':'';}
  function resolveConflict() {
    const c=CONFLICTS[0];if(!c)return;
    DevModal.openModal({title:'选择保留的字段',html:'<p>'+esc(c.title)+' · '+esc(fieldLabel(c.field))+'</p><div class="fielddiff"><div class="fd"><h4>本机</h4><p>'+esc(JSON.stringify(c.mine)??'空')+'</p></div><div class="fd"><h4>'+esc(roleOf(c.by).n)+'</h4><p>'+esc(JSON.stringify(c.theirs)??'空')+'</p></div></div><div class="gd-form-actions"><button class="btn" id="devMine">保留本机</button><button class="btn pri" id="devTheirs">保留对方</button></div>',mount:body=>{
      const pick=v=>{const r=(c.kind==='DATA'?DATA:DEV[c.kind]||[]).find(r=>r.id===c.id);if(r){putField(r,c.field,v);r._fields={...r._fields,[c.field]:{t:tick(),by:CONFIG.me}};r.updatedAt=tick();}CONFLICTS.shift();save();DevModal.closeModal();render();if(CONFLICTS.length)resolveConflict();};
      body.querySelector('#devMine').onclick=()=>pick(c.mine);body.querySelector('#devTheirs').onclick=()=>pick(c.theirs);
    }});
  }
  function devRows(kind,projectId) {const k=DEV_KEYS[kind];if(!k)throw Error('未知记录类型');return DEV[k].filter(r=>!projectId||r.projectId===projectId);}
  function validateTask(r,rows=DEV.devTasks) {
    const dep=rows.find(t=>t.id===r.dependsOn);
    if(r.dependsOn&&(!dep||dep.projectId!==r.projectId))throw Error('请选择同项目的前置任务');
    const seen=new Set([r.id]);let cur=dep;
    while(cur){if(seen.has(cur.id))throw Error('前置任务不能形成循环');seen.add(cur.id);cur=rows.find(t=>t.id===cur.dependsOn);}
    if(r.status==='done'&&dep?.status!=='done'&&r.dependsOn)throw Error('前置任务未完成，不能完成验收');
  }
  function validateShared() { DEV.devTasks.forEach(r=>validateTask(r)); }
  function devSave(kind,patch,id) {
    const key=DEV_KEYS[kind];if(!key)throw Error('未知记录类型');
    const old=id?DEV[key].find(r=>r.id===id):null;
    if(id&&!old)throw Error('记录已删除，请关闭编辑器后重新查看');
    const r={...(old||{}),...clone(patch),id:old?.id||uid(),createdAt:old?.createdAt||now(),updatedBy:CONFIG.me};
    if(kind!=='devProject'&&!DEV.devProjects.some(p=>p.id===r.projectId))throw Error('项目不存在');
    // 新任务表单只提交分区；补齐旧 schema 所需的工作分类，不覆盖已有分类。
    if(kind==='devTask'&&(r.category==null||r.category===''))r.category=r.area==='art'?'美术':r.area==='prog'?'程序':'其他';
    Object.entries(DEV_SCHEMA[key].choices).forEach(([k,opts])=>{if(!opts.includes(r[k]))throw Error('请选择有效的 '+fieldLabel(k));});
    if(kind==='devProject'?!String(r.name||'').trim():['devTask','devBug'].includes(kind)&&!String(r.title||'').trim())throw Error('\u8bf7\u586b\u5199\u540d\u79f0');
    if(kind==='devLog'&&!r.done&&!r.blockers&&!r.next)throw Error('至少填写一项进展、阻碍或下一步');
    ['date','dueDate','targetDate'].forEach(k=>{if(r[k]&&!/^\d{4}-\d{2}-\d{2}$/.test(r[k]))throw Error('日期格式无效');});
    if(kind==='devLog'&&!r.date)throw Error('\u8bf7\u586b\u5199\u65e5\u671f');
    if(kind==='devTask')validateTask(r);
    if(kind==='devBug'&&((r.images||[]).length>2||(r.images||[]).some(x=>!validAttachment(x))))throw Error('截图附件格式无效');
    const before=clone(collectLocal());
    if(kind==='devTask'&&Object.hasOwn(r,'milestoneId')){delete r.milestoneId;if(r._fields)delete r._fields.milestoneId;}
    r.owner=r.owner||CONFIG.me;r.recorder=old?.recorder||CONFIG.me;r.checks=r.checks||{};
    stamp(r,old);if(kind==='devTask'&&r._fields)delete r._fields.milestoneId;DEV[key]=old?DEV[key].map(x=>x.id===id?r:x):[...DEV[key],r];
    // v2.4.1：历史细节带「更新了哪些字段」（lockedBy 是锁标记，不算内容更新）
    const changed=old?Object.keys(patch||{}).filter(k=>k!=='lockedBy'&&!equal((old||{})[k],r[k])):[];
    log(old?'edit':'create',r.id,(kind==='devProject'?'项目':'开发记录')+' · '+(r.name||r.title||r.date)+(old&&changed.length?'（更新 '+changed.map(k=>fieldLabel(k)).join('、')+'）':''));
    try { save(); } catch(e){applyState(before);throw e;}
    return r;
  }
  // v2.4.1：编辑锁 —— 只写 lockedBy，不进历史、不触发校验；open/close 各一次，4 分钟续期
  function devLock(id,on) {
    const key='devTasks',i=DEV[key].findIndex(r=>r.id===id);if(i<0)return;
    const before=clone(collectLocal());
    const r=clone(DEV[key][i]);
    if(on)r.lockedBy={by:CONFIG.me,at:now()};else delete r.lockedBy;
    DEV[key]=DEV[key].map((x,xi)=>xi===i?r:x);
    try{save();}catch(e){applyState(before);}
  }
  /* ---------- v2.4.3 @提醒：讨论里 @到谁，谁顶栏 🔔 出红点，被拉取时 toast ---------- */
  function readSeen(){try{return Number(localStorage.getItem(SYNC_PREFIX+'mseen_'+CONFIG.me))||0;}catch(e){return 0;}}
  function writeSeen(v){try{localStorage.setItem(SYNC_PREFIX+'mseen_'+CONFIG.me,String(v));}catch(e){}}
  function myMentions(){const M=EXTRA.mentions||{};return M[CONFIG.me]||[];}
  function unreadMentions(){return myMentions().filter(m=>(m.t||0)>readSeen());}
  function findDevTitle(cid){for(const k of Object.values(DEV_KEYS)){const r=(DEV[k]||[]).find(x=>x.id===cid);if(r)return r.title||r.name||r.date||'';}return '';}
  // 发送讨论时调用：解析 @名字 → 写进对方提醒列表；返回被提醒的名字数组
  function notifyMentions(text,cardId){
    const ms=String(text||'').match(/@([^\s@，。,、]+)/g)||[];
    const hit=new Set();
    ms.forEach(function(m){const name=m.slice(1);Object.entries(ROLE).forEach(function(kv){if(kv[1].n===name&&kv[0]!==CONFIG.me)hit.add(kv[0]);});});
    if(!hit.size)return [];
    const M=(EXTRA.mentions=EXTRA.mentions||{});
    const added=[];
    hit.forEach(function(k){M[k]=M[k]||[];M[k].push({t:now(),by:CONFIG.me,cid:cardId||'',x:String(text).slice(0,140)});if(M[k].length>30)M[k].shift();added.push(ROLE[k].n);});
    return added;
  }
  /* ---------- v3-22 · 卡片就地编辑三件事 ----------
     22 双击标题就地改 / 30 卡上直接回讨论 / 32 卡内子任务勾选
     原则：能在这张卡上做完的，就别让人离开这张卡。 */
  function taskProg(t) {
    const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
    if (subs.length) return Math.round(subs.filter(function (x) { return x.done; }).length / subs.length * 100);
    if (t.prog == null) return null;
    return Math.max(0, Math.min(100, Number(t.prog)));
  }
  function repaintLater() { try { GameDev.repaint(); } catch (e) {} }

  /* 双击标题 → 就地输入框（Enter 存，Esc 放弃，失焦也存） */
  function inlineTitle(el) {
    const card = el.closest('[data-tk-card]');
    if (!card) return;
    const id = card.dataset.tkCard;
    const t = D.devAll('devTask').filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    const old = String(t.title || '');
    const inp = document.createElement('input');
    inp.className = 'tk-title-edit';
    inp.value = old;
    el.replaceWith(inp);
    inp.focus();
    try { inp.select(); } catch (e) {}
    let done = false;
    function commit(save) {
      if (done) return;
      done = true;
      const v = String(inp.value || '').trim();
      if (save && v && v !== old) {
        try { D.devSave('devTask', { title: v }, id); App.toast('标题已改'); }
        catch (err) { App.toast(err.message, 7000); }
      }
      repaintLater();
    }
    inp.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    inp.addEventListener('blur', function () { setTimeout(function () { commit(true); }, 160); });
  }

  /* 卡上回讨论：点那一行 → 变成输入框 */
  function startReply(node) {
    if (node.querySelector('.tk-reply-in')) return;
    const id = node.dataset.tkReply;
    const tx = node.querySelector('.tx');
    if (tx) tx.style.display = 'none';
    const inp = document.createElement('input');
    inp.className = 'tk-reply-in';
    inp.placeholder = '回复…（@ 可点名）';
    node.appendChild(inp);
    inp.focus();
    let done = false;
    function commit(send) {
      if (done) return;
      done = true;
      const v = String(inp.value || '').trim();
      if (send && v) replyToTask(id, v);
      else repaintLater();
    }
    inp.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    inp.addEventListener('blur', function () { setTimeout(function () { commit(true); }, 180); });
  }
  function replyToTask(id, text) {
    const v = String(text || '').trim();
    if (!v) return;
    const before = clone(collectLocal());
    (DISCUSS[id] = DISCUSS[id] || []).push({ u: CONFIG.me, t: tick(), x: v });
    log('discuss', id, '开发记录讨论');
    let at = [];
    try { at = notifyMentions(v, id); } catch (e) {}
    try {
      save();
      repaintLater();
      try { App.toast(at.length ? ('已发送 · 提醒了 ' + at.join('、')) : '已发送到讨论'); } catch (e) {}
    } catch (err) {
      applyState(before);
      try { App.toast(err.message, 'warn'); } catch (e) {}
    }
  }

  /* 子任务：加一步 / 删一步 / 勾选 */
  function addSub(id, text) {
    const t = D.devAll('devTask').filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    const subs = (Array.isArray(t.subtasks) ? t.subtasks : []).slice();
    subs.push({ id: 's' + Date.now().toString(36), text: String(text).slice(0, 80), done: false });
    D.devSave('devTask', { subtasks: subs }, id);
    repaintLater();
  }
  function delSub(id, idx) {
    const t = D.devAll('devTask').filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    const subs = (Array.isArray(t.subtasks) ? t.subtasks : []).slice();
    subs.splice(Number(idx), 1);
    try { D.devSave('devTask', { subtasks: subs }, id); }
    catch (e) { try { App.toast('删除失败：' + e.message, 7000); } catch (x) {} }
    repaintLater();
  }
  function startSubAdd(btn) {
    const card = btn.closest('[data-tk-card]');
    if (!card || card.querySelector('.tk-sub-add')) return;
    const id = btn.dataset.tkSubadd;
    let host = card.querySelector('.tk-subs');
    if (!host) {
      host = document.createElement('div');
      host.className = 'tk-subs';
      host.innerHTML = '<div class="tk-subs-hd"><b>0/0</b><span class="bar"><i style="width:0%"></i></span></div>';
      const rp = card.querySelector('.tk-reply');
      if (rp) card.insertBefore(host, rp); else card.appendChild(host);
    }
    const row = document.createElement('label');
    row.className = 'tk-sub tk-sub-add';
    row.innerHTML = '<input type="checkbox" disabled><input class="tk-reply-in" placeholder="加一步…">';
    const list = host.querySelector('.tk-sub-more');
    if (list) host.insertBefore(row, list); else host.appendChild(row);
    const inp = row.querySelector('.tk-reply-in');
    inp.focus();
    let done = false;
    function commit(send) {
      if (done) return;
      done = true;
      const v = String(inp.value || '').trim();
      if (send && v) addSub(id, v);
      else repaintLater();
    }
    inp.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    inp.addEventListener('blur', function () { setTimeout(function () { commit(true); }, 180); });
  }
  /* ---------- v3-21 · 通用小菜单（状态点 / 右键共用） ----------
     挂进 .t-root 才拿得到主题变量（挂 shadowRoot 会透明，v3-19 踩过）。
     定位：默认贴 anchor 下方，出界就翻到上方 / 左移。 */
  let MM = null;
  function closeMenu() { if (MM) { try { MM.remove(); } catch (e) {} MM = null; } }
  function openMenu(anchor, items, opt) {
    closeMenu();
    opt = opt || {};
    const host = root.querySelector('.t-root') || root;
    const m = document.createElement('div');
    m.className = 'tb-menu';
    m.innerHTML = (opt.title ? '<div class="tb-menu-hd">' + esc(opt.title) + '</div>' : '')
      + items.map(function (it, i) {
        if (it.sep) return '<div class="sp"></div>';
        return '<button type="button" class="tb-menu-i' + (it.tone ? ' ' + it.tone : '') + '" data-mi="' + i + '">'
          + '<span class="ic">' + (it.icon || '') + '</span><span>' + esc(it.label) + '</span>'
          + (it.on ? '<span class="ck">✓</span>' : '') + '</button>';
      }).join('');
    host.appendChild(m);
    const rc = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 0, bottom: 0, height: 0 };
    const mw = m.offsetWidth || 170, mh = m.offsetHeight || 190;
    let x = (opt.x != null ? opt.x : rc.left);
    let y = (opt.y != null ? opt.y : rc.bottom + 4);
    if (x + mw > window.innerWidth - 8) x = Math.max(8, window.innerWidth - mw - 8);
    if (y + mh > window.innerHeight - 8) y = Math.max(8, (opt.y != null ? y - mh : rc.top - mh - 6));
    m.style.left = Math.round(x) + 'px';
    m.style.top = Math.round(y) + 'px';
    m.addEventListener('mousedown', function (e) {
      const b = e.target.closest('[data-mi]');
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const it = items[+b.dataset.mi];
      closeMenu();
      try { it.fn && it.fn(); } catch (err) { try { App.toast(err.message, 7000); } catch (x) {} }
    });
    MM = m;
  }
  /* 点别处 / Esc 收起（shadow DOM 里 e.target 会被 retarget，必须用 composedPath 判断） */
  document.addEventListener('mousedown', function (e) {
    if (!MM) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.some(function (n) { return n === MM; })) return;
    closeMenu();
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && MM) closeMenu(); }, true);
  /* ---------- v3-19 · @ 成员选择器 ----------
     原来只能在框里手打「@邢锦」，错一个字就提醒不到（notifyMentions 按名字精确匹配）。
     现在输入 @ 直接弹全组成员：↑↓ 选、Enter 或点击确认，插进去的是「当前的显示名」。 */
  let MP = null, MPctx = null;
  function closeMention() { if (MP) { try { MP.remove(); } catch (e) {} MP = null; } MPctx = null; }
  function mentionToken(el) {
    const pos = el.selectionStart == null ? String(el.value || '').length : el.selectionStart;
    const before = String(el.value || '').slice(0, pos);
    const at = before.lastIndexOf('@');
    if (at < 0) return null;
    const seg = before.slice(at + 1);
    if (/[\s@]/.test(seg)) return null;            /* @ 后面已经有空格 → 这个 @ 写完了 */
    return { start: at, end: pos, q: seg };
  }
  function bindMentionPicker(scope) {
    (scope || root).querySelectorAll('[data-mention]').forEach(function (el) {
      if (el.__mpBound) return;
      el.__mpBound = 1;
      function paint() {
        if (!MP || !MPctx || MPctx.el !== el) return;
        const items = [].slice.call(MP.querySelectorAll('.tb-ment-i'));
        items.forEach(function (b, i) { b.classList.toggle('on', i === MPctx.idx); });
        const cur = items[MPctx.idx];
        if (cur) { try { cur.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
      }
      function pick(id) {
        const c = (MPctx && MPctx.el === el) ? MPctx : null;
        if (!c) return;
        const name = String(roleOf(id).n);
        const v = String(el.value || '');
        el.value = v.slice(0, c.start) + '@' + name + ' ' + v.slice(c.end);
        const caret = c.start + name.length + 2;
        closeMention();
        try { el.focus(); el.setSelectionRange(caret, caret); } catch (e) {}
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      function show() {
        const c = mentionToken(el);
        if (!c) { if (MPctx && MPctx.el === el) closeMention(); return; }
        const q = c.q.toLowerCase();
        const html = Object.keys(ROLE).map(function (k) {
          const r = ROLE[k];
          const hit = !q || String(r.n).toLowerCase().indexOf(q) >= 0 || String(r.r || '').toLowerCase().indexOf(q) >= 0;
          if (!hit) return '';
          return '<button type="button" class="tb-ment-i" data-ment-pick="' + esc(k) + '">'
            + '<i style="background:' + esc(r.c) + '"></i><b>' + esc(r.n) + '</b><em>' + esc(r.r || '') + '</em></button>';
        }).join('');
        if (!html) { closeMention(); return; }
        if (!MP) {
          /* 必须挂在 .t-root 里：6 套主题的 CSS 变量都定义在它的 data-th 上，
             挂到 shadowRoot 会拿不到 --card-bg → 浮层变成透明的 */
          const host = root.querySelector('.t-root') || root;
          MP = document.createElement('div'); MP.className = 'tb-ment'; host.appendChild(MP);
        }
        MP.innerHTML = '<div class="tb-ment-hd">选择成员 · ↑↓ 选，Enter 确认</div>' + html;
        MPctx = { el: el, start: c.start, end: c.end, idx: 0 };
        const rc = el.getBoundingClientRect();
        MP.style.left = Math.round(Math.max(8, Math.min(rc.left, window.innerWidth - 300))) + 'px';
        MP.style.width = Math.round(Math.max(184, Math.min(280, rc.width))) + 'px';
        { /* 输入框在屏幕下半区（弹窗底部的讨论框就是）→ 往上弹，别盖住发送按钮 */
          const mh = MP.offsetHeight || 150;
          const up = (rc.top + 44 > window.innerHeight / 2) || (window.innerHeight - rc.bottom < mh + 16);
          MP.style.top = Math.round(up ? Math.max(8, rc.top - mh - 6) : rc.bottom + 4) + 'px'; }
        [].slice.call(MP.querySelectorAll('[data-ment-pick]')).forEach(function (b) {
          b.addEventListener('mousedown', function (e) { e.preventDefault(); pick(b.dataset.mentPick); });
        });
        paint();
      }
      el.addEventListener('input', show);
      el.addEventListener('click', show);
      el.addEventListener('keydown', function (e) {
        if (!MP || !MPctx || MPctx.el !== el) return;
        const items = [].slice.call(MP.querySelectorAll('.tb-ment-i'));
        if (!items.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); MPctx.idx = (MPctx.idx + 1) % items.length; paint(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); MPctx.idx = (MPctx.idx - 1 + items.length) % items.length; paint(); }
        else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pick(items[MPctx.idx].dataset.mentPick); }
        else if (e.key === 'Escape') { e.preventDefault(); closeMention(); }
      });
      el.addEventListener('blur', function () { setTimeout(closeMention, 200); });
    });
  }
  // 拉取后检查新到提醒（每人每次会话只 toast 增量）
  let lastMentToast=0;
  function pingMentions(){
    const fresh=myMentions().filter(m=>(m.t||0)>readSeen()&&(m.t||0)>lastMentToast&&m.by&&m.by!==CONFIG.me);
    if(!fresh.length)return;
    lastMentToast=Math.max.apply(null,fresh.map(m=>m.t||0));
    const last=fresh[fresh.length-1];
    toast('💬 '+roleOf(last.by).n+' @了你'+(fresh.length>1?'（'+fresh.length+' 条新提醒）':''),8000);
    updateBell();
  }
  function updateBell(){
    const btn=root&&root.querySelector('#devMentions');if(!btn)return;
    const n=unreadMentions().length;
    const txt=btn.querySelector('.stxt');
    if(txt)txt.textContent=n?'🔔 '+n:'🔔';
    btn.classList.toggle('has-unread',n>0);
  }
  function showMentions(){
    const list=myMentions().slice().reverse();
    writeSeen(now());updateBell();
    const cardBtn=list.length?'<button class="btn" id="mentClearAll">全部标为已读</button>':'';
    DevModal.openModal({title:'🔔 @我的提醒',html:(list.length?'<div class="ment-list">'+list.map(function(m){
      const title=findDevTitle(m.cid);
      return '<div class="ment-i"><p>'+whoName(m.by)+' 在「'+esc(title||'已删除的卡片')+'」@了你 · <span class="tm">'+esc(dstr(m.t))+' '+fmtT(m.t)+'</span></p><p class="ment-x">'+esc(m.x)+'</p>'+(m.cid?'<button type="button" class="btn btn-sm" data-ment-jump="'+esc(m.cid)+'">跳到那张卡 →</button>':'')+'</div>';
    }).join('')+'</div>'+cardBtn:'<div class="mut" style="text-align:center;padding:24px 0">还没有人 @你 · 在讨论里输入 '+esc(mentionHint())+' 就能提醒对方</div>'),mount:function(body){
      body.onclick=function(e){
        const j=e.target.closest('[data-ment-jump]');
        if(j){const cid=j.dataset.mentJump;let t=null,isTask=false;Object.values(DEV_KEYS).forEach(function(k){const r=(DEV[k]||[]).find(x=>x.id===cid);if(r){t=r;isTask=(k==='devTasks');}});writeSeen(now());updateBell();App.closeModal();
          if(t&&isTask){if(!GameDev.project()||(t.projectId&&GameDev.project().id!==t.projectId)){GameDev._project=t.projectId;GameDev.resetFilters();}GameDev.chooseTab('devTask');GameDev.openEditor('devTask',cid);}
          return;}
        if(e.target.closest('#mentClearAll')){writeSeen(now());updateBell();App.closeModal();toast('已全部标为已读');}
      };
    }});
  }
  function devRemove(kind,id) {
    if(kind==='devProject')throw Error('项目请改为归档，以保留关联历史');
    const key=DEV_KEYS[kind],r=DEV[key]?.find(x=>x.id===id);if(!r)return;
    const before=clone(collectLocal()),at=tick();
    DELETED[key+'|'+id]={at,by:CONFIG.me};TRASH.unshift({...clone(r),kind:key,deletedAt:at,deletedBy:CONFIG.me});
    DEV[key]=DEV[key].filter(x=>x.id!==id);
    if(kind==='devTask')DEV.devTasks.forEach(t=>{if(t.dependsOn===id){const prev=clone(t);t.dependsOn='';stamp(t,prev);}});
    log('delete',id,'删除开发记录');
    try {save();}catch(e){applyState(before);throw e;}
  }
  function devRestore(kind,id) {
    const at=TRASH.findIndex(r=>r.kind===kind&&r.id===id);if(at<0)return;
    const before=clone(collectLocal()),r=clone(TRASH[at]);
    delete r.kind;delete r.deletedAt;delete r.deletedBy;
    r._restoredAt=Math.max(tick(),(DELETED[kind+'|'+id]?.at||0)+1);r.updatedAt=r._ut=r._restoredAt;
    if(kind==='devTasks'){if(!DEV.devTasks.some(x=>x.id===r.dependsOn))r.dependsOn='';validateTask(r);}
    DEV[kind].push(r);TRASH.splice(at,1);log('restore',id,'恢复开发记录');
    try {save();}catch(e){applyState(before);throw e;}
  }
  const DevData={KEYS:DEV_KEYS,DEV_SCHEMA,devAll:devRows,devSave,devRemove,today:()=>dstr(now()),shift:(s,n)=>{const d=new Date(s+'T12:00:00');d.setDate(d.getDate()+n);return dstr(+d);},weekCn:s=>'\u65e5\u4e00\u4e8c\u4e09\u56db\u4e94\u516d'[new Date(s+'T12:00:00').getDay()]};
  function saveDrafts(){localStorage.setItem(SYNC_PREFIX+'drafts',JSON.stringify(localDrafts));}
  function validAttachment(x){return x&&typeof x.path==='string'&&/^attachments\/[a-zA-Z0-9@._-]+\.(png|jpg|webp|gif)$/.test(x.path)&&/^image\/(png|jpeg|webp|gif)$/.test(x.type)&&x.size<=1024*1024;}
  const imageCache=new Map(),imageMemory=new Map();
  const ghAttachmentURL=path=>'https://api.github.com/repos/'+CONFIG.channel.repo+'/contents/'+path;
  async function uploadImage(file) {
    if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type)||file.size>1024*1024)throw Error('截图仅支持 PNG/JPEG/WebP/GIF，每张最多 1 MB');
    const bytes=new Uint8Array(await file.arrayBuffer()),head=[...bytes.slice(0,12)];
    const signatures={ 'image/png':head.slice(0,8).join(',')==='137,80,78,71,13,10,26,10','image/jpeg':head[0]===255&&head[1]===216&&head[2]===255,'image/webp':String.fromCharCode(...head.slice(0,4))==='RIFF'&&String.fromCharCode(...head.slice(8,12))==='WEBP','image/gif':String.fromCharCode(...head.slice(0,6)).match(/^GIF8[79]a$/)};
    if(!signatures[file.type])throw Error('截图内容与类型不符');
    const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[file.type];
    const item={path:'attachments/'+uid()+'.'+ext,type:file.type,size:file.size,name:file.name};
    let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.slice(i,i+8192));
    const content=btoa(binary);
    if(CONFIG.channel.type==='local'){imageMemory.set(item.path,content);return item;}
    if(!CONFIG.channel.token)throw Error('请先配置同步，再上传团队截图');
    const res=await fetch(ghAttachmentURL(item.path),{method:'PUT',headers:{Authorization:'token '+CONFIG.channel.token,'Content-Type':'application/json'},body:JSON.stringify({message:'team attachment',content,branch:CONFIG.channel.branch})});
    if(!res.ok)throw Error('截图上传失败（'+res.status+'），记录未提交');
    imageMemory.set(item.path,content);return item;
  }
  async function imageURL(item) {
    if(!validAttachment(item))throw Error('附件路径无效');
    if(imageCache.has(item.path))return imageCache.get(item.path);
    let content=imageMemory.get(item.path);
    if(!content){if(CONFIG.channel.type==='local')throw Error('本地模拟截图在刷新后重置');if(!CONFIG.channel.token)throw Error('请先配置同步以查看私仓截图');const res=await fetch(ghAttachmentURL(item.path)+'?ref='+encodeURIComponent(CONFIG.channel.branch),{headers:{Authorization:'token '+CONFIG.channel.token},cache:'no-store'});if(!res.ok)throw Error('截图读取失败（'+res.status+'）');const j=await res.json();content=j.content;
      if(!content){const raw=await fetch(ghAttachmentURL(item.path)+'?ref='+encodeURIComponent(CONFIG.channel.branch),{headers:{Authorization:'token '+CONFIG.channel.token,Accept:'application/vnd.github.raw+json'},cache:'no-store'});if(!raw.ok)throw Error('截图读取失败');const url=URL.createObjectURL(new Blob([await raw.arrayBuffer()],{type:item.type}));imageCache.set(item.path,url);return url;}}
    const bytes=Uint8Array.from(atob(content.replace(/\s/g,'')),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:item.type}));imageCache.set(item.path,url);return url;
  }
  function hydrateImages(scope=root){scope?.querySelectorAll('[data-team-image]').forEach(el=>{let item;try{item=JSON.parse(el.dataset.teamImage);}catch(e){return;}imageURL(item).then(url=>{if(el.isConnected)el.src=url;}).catch(e=>{el.alt=e.message;});});}
  function thumb(item,alt){return '<img data-team-image="'+esc(JSON.stringify(item))+'" alt="'+esc(alt)+'">';}
  function showDevTrash(){DevModal.openModal({title:'开发记录回收站',html:TRASH.filter(r=>r.kind).map(r=>'<div class="trash-i"><span>'+esc(r.name||r.title||r.date)+' · '+esc(roleOf(r.deletedBy).n)+'</span><button class="btn" data-dev-restore="'+esc(r.id)+'" data-kind="'+esc(r.kind)+'">恢复</button></div>').join('')||'<p>回收站为空。旧卡片回收站在兼容看板中。</p>',mount:body=>{body.onclick=e=>{const b=e.target.closest('[data-dev-restore]');if(b)try{devRestore(b.dataset.kind,b.dataset.devRestore);DevModal.closeModal();render();toast('已恢复');}catch(err){toast(err.message,'warn');}};}});}
  function openDevDiscussion(kind,id){
    const record=devRows(kind).find(r=>r.id===id);if(!record)return;
    const key='discussion|'+id;
    DevModal.openModal({title:'团队讨论 · '+(record.title||record.name||record.date),html:'<div class="disc">'+(DISCUSS[id]||[]).map(m=>'<p>'+whoName(m.u)+' · '+esc(dstr(m.t))+' '+fmtT(m.t)+'</p><p style="white-space:pre-wrap">'+esc(m.x)+'</p>').join('')+'</div><form id="dev-disc-form" class="gd-form"><label class="gd-field gd-full"><span>发送给团队</span><textarea name="discussion" data-mention maxlength="20000">'+esc(localDrafts[key]||'')+'</textarea></label><button class="btn pri" type="submit">发送</button></form>',mount:body=>{
      const form=body.querySelector('form'),input=form.querySelector('textarea');input.oninput=()=>{try{localDrafts[key]=input.value;saveDrafts();}catch(e){toast('草稿保存失败','warn');}};
      form.onsubmit=e=>{e.preventDefault();if(!input.value.trim())return;const before=clone(collectLocal());(DISCUSS[id]=DISCUSS[id]||[]).push({u:CONFIG.me,t:tick(),x:input.value.trim()});log('discuss',id,'开发记录讨论');const at=notifyMentions(input.value.trim(),id);try{save();delete localDrafts[key];try{saveDrafts();}catch(e){}DevModal.closeModal();render();updateBell();toast(at.length?'📨 已提醒 '+at.join('、'):'已发送到本机，等待同步');}catch(e){applyState(before);toast(e.message,'warn');}};
    }});
  }
  const DevModal={toast:msg=>toast(msg,'warn'),closeModal:()=>closeModal('genericModal'),openModal(opt){
    if(modalOptions?.beforeClose&&!modalOptions.beforeClose())return;
    const modalBody=root.querySelector('#gmBody');modalBody.onclick=null;modalBody.oninput=null;modalOptions=opt;root.querySelector('#gmTitle').textContent=opt.title;root.querySelector('#gmBody').innerHTML=(opt.sub?'<p class="gd-note">'+opt.sub+'</p>':'')+opt.html;root.querySelector('#gmFoot').innerHTML='';openModal('genericModal');opt.mount?.(root.querySelector('#gmBody'));bindMentionPicker(root.querySelector('#gmBody'));hydrateImages(root.querySelector('#gmBody'));
  }};

const D = DevData;
const I={get:k=>'<span aria-hidden="true">'+({gamepad:'🎮',plus:'＋',target:'◎',grid:'▦',shield:'◇',edit:'✎',clock:'◷',inbox:'▣',search:'⌕',todo:'☷'}[k]||'')+'</span>'};
const App=DevModal;
const SOFTS = ['Houdini','UE','Blender','AI 制作'];
const SOFT_ABBR = {Houdini:'H',UE:'U',Blender:'B','AI 制作':'AI'};
const TABS = [
  ['devTask','\u4efb\u52a1\u770b\u677f','grid'],['devBug','BUG \u8ffd\u8e2a','shield'],['devLog','\u5f00\u53d1\u65e5\u5fd7','edit']
];
const LABELS = {
  active:'进行中',paused:'暂停',released:'已发布',archived:'已归档',planned:'未开始',done:'已完成',
  backlog:'待开发',doing:'开发中',review:'待验收',open:'待处理',fixing:'修复中',verify:'待验证',closed:'已关闭',
  high:'高',mid:'中',low:'低',critical:'阻断',medium:'一般'
};
const NEW_LABELS = {devTask:'\u65b0\u5efa\u4efb\u52a1',devBug:'\u8bb0\u5f55 BUG',devLog:'\u5199\u5f00\u53d1\u65e5\u5fd7'};
const EDIT_LABELS = {devTask:'\u7f16\u8f91\u4efb\u52a1',devBug:'\u7f16\u8f91 BUG',devLog:'\u7f16\u8f91\u5f00\u53d1\u65e5\u5fd7'};
function optionList(values,value,empty) {
  return (empty?'<option value="">'+esc(empty)+'</option>':'')+values.map(function(v){
    const pair=Array.isArray(v)?v:[v,LABELS[v] || v];
    return '<option value="'+esc(pair[0])+'"'+(pair[0]===value?' selected':'')+'>'+esc(pair[1])+'</option>';
  }).join('');
}
function field(name,label,value,type,extra) {
  return '<label class="gd-field" for="gd-f-'+name+'"><span>'+esc(label)+'</span><input class="input" id="gd-f-'+name+'" name="'+name+'" type="'+(type || 'text')+'" value="'+esc(value || '')+'" '+(extra || '')+'></label>';
}
function area(name,label,value,placeholder) {
  return '<label class="gd-field gd-full" for="gd-f-'+name+'"><span>'+esc(label)+'</span><textarea class="input" rows="3" id="gd-f-'+name+'" name="'+name+'" placeholder="'+esc(placeholder || '')+'" maxlength="20000">'+esc(value || '')+'</textarea></label>';
}
function select(name,label,values,value,empty) {
  return '<label class="gd-field" for="gd-f-'+name+'"><span>'+esc(label)+'</span><select class="input" id="gd-f-'+name+'" name="'+name+'">'+optionList(values,value,empty)+'</select></label>';
}
// v2.4.0：进度滑条（带 % 实时值）
function slider(name,label,val) {
  return '<div class="gd-field gd-sliderfield"><span>'+esc(label)+' <b class="gd-slideval">'+(val==null?0:val)+'%</b></span><input type="range" name="'+name+'" min="0" max="100" step="5" value="'+(val==null?0:val)+'" aria-label="'+esc(label)+'"></div>';
}
// v2.4.0：芯片选择组（multi=false 单选；selected 为空 = 未选）
function chipGroup(name,label,opts,selected,multi) {
  const cur=multi?(selected||[]):[selected];
  return '<div class="gd-field gd-chipfield"><span>'+esc(label)+'</span><div class="gd-chiprow" data-chip-name="'+esc(name)+'"'+(multi?' data-multi="1"':'')+'>'
    +opts.map(function(o){return '<button type="button" class="gd-pick'+(cur.indexOf(String(o[0]))>=0?' on':'')+'" data-val="'+esc(o[0])+'">'+esc(o[1])+'</button>';}).join('')
    +'<input type="hidden" name="'+esc(name)+'" value="'+esc(multi?(cur||[]).join(','):(selected==null?'':selected))+'">'
    +'</div></div>';
}
function badge(value) {return '<span class="gd-badge gd-badge--'+esc(value)+'">'+esc(LABELS[value] || value)+'</span>';}
function dateHint(date,done) {
  if(!date)return '';
  return '<span class="gd-due'+(!done&&date<D.today()?' is-overdue':'')+'">'+esc(date)+(!done&&date<D.today()?' · 已逾期':'')+'</span>';
}
/* 卡片用：交付日 + 剩 N 天 / 今天交 / 逾期 N 天 */
function dueChip(date,done) {
  if(!date)return '';
  const md=date.slice(5);
  if(done)return '<span class="gd-due">'+esc(md)+' 交</span>';
  const diff=Math.round((new Date(date+'T00:00:00')-new Date(D.today()+'T00:00:00'))/86400000);
  if(diff<0)return '<span class="gd-due is-overdue">'+esc(md)+' · 逾期 '+(-diff)+' 天</span>';
  if(diff===0)return '<span class="gd-due is-today">'+esc(md)+' · 今天交</span>';
  return '<span class="gd-due">'+esc(md)+' · 剩 '+diff+' 天</span>';
}
function details(label,text) {
  return text?'<div class="gd-detail"><span>'+esc(label)+'</span><p>'+esc(text)+'</p></div>':'';
}
function actions(kind,id,extra) {
  return '<div class="gd-actions">'+(extra || '')+'<button class="btn btn-sm" data-gd-disc="'+kind+'" data-id="'+esc(id)+'">讨论</button><button class="btn btn-sm" data-gd-history="'+esc(id)+'">历史</button><span class="gd-meta">'+esc(roleOf(D.devAll(kind).find(r=>r.id===id)?.owner).n)+' · 记录人 '+esc(roleOf(D.devAll(kind).find(r=>r.id===id)?.recorder).n)+'</span><button class="btn btn-sm" data-gd-edit="'+kind+'" data-id="'+esc(id)+'">编辑</button><button class="btn btn-ghost btn-sm" data-gd-delete="'+kind+'" data-id="'+esc(id)+'">删除</button></div>';
}

  /* ============================================================
     UB（v3-18）—— 统一看板层
     ------------------------------------------------------------
     BUG 追踪 / 开发日志两个辅助面板，
     统一成「任务看板」的同一套语言：
       · 同一个 KPI 条（.tk-kpibar，按面板换指标）
       · 同一个泳道 + 状态列（.tk-lane / .tk-cell，可四列可三列）
       · 同一张紧凑卡（.tk-card 的 r1..r4：P 级 pill + 标题 + 分区/软件 + 头像 + 剩余天数）
       · 同一组右上角图标动作（💬 🕘 ✏️ 🗑，hover 显形；手机上常显）
     只做渲染，不碰存储与写入（写入仍全走 D.devSave / D.devRemove）。
     ============================================================ */
  const UB = {
    /* 卡片右上角动作组 —— 与任务卡完全同款 */
    ico: function (kind, id, nDisc, noDel) {
      return '<span class="tk-ico">'
        + '<button type="button" class="tk-ib" data-gd-disc="' + kind + '" data-id="' + esc(id) + '" title="团队讨论">💬' + (nDisc ? '<b>' + nDisc + '</b>' : '') + '</button>'
        + '<button type="button" class="tk-ib" data-gd-history="' + esc(id) + '" title="历史操作记录">🕘</button>'
        + '<button type="button" class="tk-ib" data-gd-edit="' + kind + '" data-id="' + esc(id) + '" title="编辑">✏️</button>'
        + (noDel ? '' : '<button type="button" class="tk-ib" data-gd-delete="' + kind + '" data-id="' + esc(id) + '" title="删除">🗑</button>')
        + '</span>';
    },
    /* 头像 + 名字（只读；改负责人目前只对任务卡开口，别在这挂 data-gd-owner） */
    who: function (v) {
      const ids = ownerIds(v);
      if (!ids.length) return '<span class="tk-own tk-own-ro"><span class="tb-k">未指派</span></span>';
      return '<span class="tk-own tk-own-ro">' + TBoard.av(v) + '<b>' + esc(TBoard.ownerName(v)) + '</b></span>';
    },
    /* 卡头：pill（P 级色）+ 标题 + 动作组 */
    head: function (pillCls, pillTxt, title, kind, id, nDisc, noDel) {
      return '<div class="tk-r1"><span class="tk-pri ' + pillCls + '">' + esc(pillTxt) + '</span>'
        + '<span class="tt">' + esc(title) + '</span>' + this.ico(kind, id, nDisc, noDel) + '</div>';
    },
    /* 剩余天数 —— 与任务卡同一套说法（逾期 N 天 / 今天到期 / 剩 N 天 / 未排期） */
    left: function (date, done) {
      if (!date) return '<span class="tk-nodue">未排期</span>';
      return TBoard.due({ dueDate: date, status: done ? 'done' : '' });
    },
    /* 泳道外壳：cols=[[key,label]...]；cell(key) 出该列卡片；count(key) 出数量 */
    lane: function (opt) {
      const body = opt.cols.map(function (c) {
        const n = opt.count(c[0]);
        return '<div class="tk-cell" data-tb-cell="' + esc(c[0]) + '">'
          + '<div class="ct">' + esc(c[1]) + ' ' + n + '</div>'
          + (n ? opt.cell(c[0]) : '<div class="tk-dim" style="font-size:11px;padding:3px 2px">—</div>')
          + '</div>';
      }).join('');
      return '<div class="tk-lane"><div class="tk-lane-hd" style="border-left-color:' + (opt.color || 'var(--accent)') + ';cursor:default">'
        + '<span>' + opt.icon + ' ' + esc(opt.title) + '</span>'
        + '<span class="cnt">' + esc(opt.sub || '') + '</span>'
        + (opt.hint ? '<span class="hint">' + esc(opt.hint) + '</span>' : '')
        + '<span class="tri" style="margin-left:' + (opt.hint ? '8px' : 'auto') + '">' + esc(opt.tail || '') + '</span>'
        + '</div><div class="tk-lane-bd ' + (opt.cls || '') + '">' + body + '</div></div>';
    },
    /* KPI 条内容（包在 .tk-kpibar 里用，视觉与任务看板一模一样） */
    kpi: function (items, opt) {
      opt = opt || {};
      let s = items.map(function (x, i) {
        return '<span class="it' + (x[2] ? ' ' + x[2] : '') + '"><b>' + x[0] + '</b>' + x[1] + '</span>'
          + (i === 0 ? '<i class="sep"></i>' : '');
      }).join('');
      if (opt.pct != null) {
        s += (items.length > 1 ? '<i class="sep"></i>' : '')
          + '<span class="pw">' + TBoard.bar(opt.pct) + '<span class="pct">' + opt.pct + '% ' + esc(opt.pctLabel || '') + '</span></span>';
      }
      if (opt.right) s += '<i class="sep"></i><span class="lds">' + opt.right + '</span>';
      return s;
    }
  };

  /* ============================================================
     TBoard（v2.5）—— 任务看板重设计层
     只读 D（DevData）的公开方法；写入一律走 D.devSave / D.devRemove
     ============================================================ */
  const TB_ST = { backlog:'#94a3b8', doing:'var(--accent)', review:'#f5a524', done:'#10b981' };
  const TB_AREAS = [['art','🎨 美术开发','#e879f9'],['prog','💻 程序开发','#34d399'],['misc','🧩 通用 / 策划','#94a3b8']];
  const TBoard = {
    view:'lane', rail:true, rmode:'today', rsel:'', den:'1', projOpen:false, cd:'auto', cellOpen:{},
    grp:{}, laneMin:{}, sel:new Set(), sort:{k:'dueDate',dir:1}, trash:[], kw:'',
    /* ---- 基础 ---- */
    stOrder(){ return D.DEV_SCHEMA.devTasks.choices.status.slice(); },
    stName(s){ return LABELS[s] || s; },
    /* ============================================================
       v2.14.0 · 卡片密度（86/87/90）
       ------------------------------------------------------------
       comfy 舒适 · tight 紧凑（元信息并进负责人行）· row 列表（一行）
       auto（默认）：按「主区宽度 / 4」估列宽自适应 —— 不监听 resize，
       每次渲染现算，不会和用户手选打架。
       ============================================================ */
    cdEff(){
      if(this.cd && this.cd !== 'auto') return this.cd;
      const win = (typeof window !== 'undefined' ? window.innerWidth : 1440) || 1440;
      const railW = this.rail ? 330 : 60;
      const colW = Math.max(120, (win - railW - 96) / 4);
      if(colW < 210) return 'row';
      if(colW < 275) return 'tight';
      return 'comfy';
    },
    cellOpenKey(area, st){ return String(area || 'misc') + '|' + st; },
    stack(tasks, projectId, member){
      let list = tasks;
      if(member) list = list.filter(t => ownerIds(t.owner).indexOf(member) >= 0);
      if(this.kw) list = list.filter(t => JSON.stringify(t).toLowerCase().indexOf(this.kw.toLowerCase()) >= 0);
      return list;
    },
    daysTo(d){ return Math.round((new Date(d+'T00:00:00') - new Date(D.today()+'T00:00:00')) / 86400000); },
    due(t){
      if(!t.dueDate) return '';
      const dd = this.daysTo(t.dueDate), tone = toneMode();
      if(t.status === 'done') return '<span class="tk-due done">已完成</span>';
      if(tone === 'soft'){
        if(dd < 0)   return '<span class="tk-due calm-over">'+(-dd)+' 天前</span>';
        if(dd === 0) return '<span class="tk-due calm-today">今天</span>';
        return '<span class="tk-due calm">'+dd+' 天后</span>';
      }
      if(tone === 'strict'){
        if(dd < 0)   return '<span class="tk-due over is-loud">⚠️ 逾期 '+(-dd)+' 天</span>';
        if(dd === 0) return '<span class="tk-due over is-loud">今天到期</span>';
        return '<span class="tk-due'+(dd <= 2 ? ' soon' : ' ok')+'">剩 '+dd+' 天</span>';
      }
      if(dd < 0) return '<span class="tk-due over">逾期 '+(-dd)+' 天</span>';
      if(dd === 0) return '<span class="tk-due over">今天到期</span>';
      if(dd <= 2) return '<span class="tk-due soon">'+dd+' 天后</span>';
      return '<span class="tk-due ok">'+dd+' 天后</span>';
    },
    /* v2.6.0：优先级统一成 P0–P3 四级（critical/high/mid/low），板/表/详情/编辑器用同一套说法 */
    pri(t){ return {critical:'P0',high:'P1',mid:'P2',low:'P3'}[t.priority] || 'P2'; },
    PRI4: [['critical','P0 阻断'],['high','P1 高'],['mid','P2 中'],['low','P3 低']],
    av(v){
      const ids = ownerIds(v);
      if(!ids.length) return '<i class="tk-av" title="未指派" style="background:#94a3b8">?</i>';
      let h = '';
      ids.slice(0,2).forEach(function(id){ const r = ROLE[id]; if(!r) return; h += '<i class="tk-av" title="'+esc(r.n)+'" style="background:'+esc(r.c)+'">'+esc(String(r.n).slice(0,1))+'</i>'; });
      if(ids.length > 2) h += '<i class="tk-av tk-av-more" title="'+esc(ids.length)+' 人">+'+(ids.length-2)+'</i>';
      return h;
    },
    ownerName(v){
      const ids = ownerIds(v);
      if(!ids.length) return '未指派';
      return ids.map(function(id){ return (ROLE[id]||{n:id}).n; }).join('、');
    },
    bar(v,c){ return '<div style="flex:1 1 auto;height:5px;border-radius:3px;background:var(--card-border);overflow:hidden"><i style="display:block;height:100%;border-radius:3px;width:'+Math.max(0,Math.min(100,v||0))+'%;background:'+(c||'var(--accent)')+'"></i></div>'; },
    find(tasks,id){ return tasks.filter(t=>t.id===id)[0]; },
    /* ---- v3-21 · 三个一步到位的卡片操作（不用拖、也不用进弹窗） ---- */
    statusMenu(anchor, id, g) {
      const self = this;
      const t = D.devAll('devTask').filter(function (x) { return x.id === id; })[0];
      if (!t) return;
      openMenu(anchor, this.stOrder().map(function (k) {
        return {
          icon: '<i class="d" style="background:' + (TB_ST[k] || '#888') + '"></i>',
          label: self.stName(k), on: t.status === k,
          fn: function () {
            if (t.status === k) return;
            D.devSave('devTask', { status: k }, id);
            g.repaint(); App.toast('已移到「' + self.stName(k) + '」');
          }
        };
      }), { title: '移到哪一列？' });
    },
    claimTask(id, g) {
      const t = D.devAll('devTask').filter(function (x) { return x.id === id; })[0];
      if (!t) return;
      const ids = ownerIds(t.owner);
      if (ids.indexOf(CONFIG.me) >= 0) { App.toast('你已经是这张卡的负责人了'); return; }
      ids.push(CONFIG.me);
      D.devSave('devTask', { owner: ids.join(',') }, id);
      g.repaint();
      App.toast(ids.length > 1 ? '已加入 · 现在 ' + ids.length + ' 个负责人' : '已认领 · 这张卡归你了');
    },
    dupTask(id, g) {
      const t = D.devAll('devTask').filter(function (x) { return x.id === id; })[0];
      if (!t) return;
      const KEEP = ['projectId', 'title', 'description', 'acceptance', 'note', 'status', 'priority', 'area', 'stage', 'soft', 'owner', 'dueDate', 'path', 'dependsOn'];
      const p = {};
      KEEP.forEach(function (k) { if (t[k] !== undefined && t[k] !== null && t[k] !== '') p[k] = t[k]; });
      p.title = String(t.title || '').slice(0, 190) + '（副本）';
      p.prog = 0;
      D.devSave('devTask', p);
      g.repaint();
      App.toast('已复制一张');
    },
    cardMenu(anchor, id, x, y, g) {
      const self = this;
      const t = D.devAll('devTask').filter(function (r) { return r.id === id; })[0];
      if (!t) return;
      const st = this.stOrder();
      const next = st[Math.min(st.length - 1, st.indexOf(t.status) + 1)];
      openMenu(anchor, [
        { icon: '✏️', label: '编辑这张卡', fn: function () { g.openEditor('devTask', id); } },
        { icon: '💬', label: '团队讨论', fn: function () { openDevDiscussion('devTask', id); } },
        { icon: '🕘', label: '历史记录', fn: function () { showHistory(id); } },
        { sep: true },
        { icon: '🔀', label: '移到「' + self.stName(next) + '」', fn: function () {
            if (next === t.status) return;
            D.devSave('devTask', { status: next }, id); g.repaint(); App.toast('已移到「' + self.stName(next) + '」');
          } },
        { icon: '⧉', label: '复制一张', fn: function () { self.dupTask(id, g); } },
        { icon: '＋', label: '我来做 / 加入', fn: function () { self.claimTask(id, g); } },
        { sep: true },
        { icon: '🗑', label: '删除', tone: 'danger', fn: function () { g.remove('devTask', id); } }
      ], { x: x, y: y });
    },
    /* ---- KPI（5 个数 + 总进度 + 成员负载） ---- */
    kpi(tasks, bugs){
      const live = tasks.filter(t=>t.status!=='done');
      const done = tasks.filter(t=>t.status==='done').length;
      const over = live.filter(t=>t.dueDate && this.daysTo(t.dueDate)<0).length;
      const today = live.filter(t=>t.dueDate && this.daysTo(t.dueDate)===0).length;
      const pct = tasks.length ? Math.round(done/tasks.length*100) : 0;
      const it = (n,l,cls)=>'<span class="it'+(cls?' '+cls:'')+'"><b>'+n+'</b>'+l+'</span>';
      let s = it(tasks.length,'任务') + '<i class="sep"></i>'
        + it(tasks.filter(t=>t.status==='doing').length,'在做')
        + it(tasks.filter(t=>t.status==='review').length,'待验收')
        + it(today,'今天到期','warn')
        + it(over, overWord(), toneMode()==='soft' ? '' : 'hot')
        + '<i class="sep"></i><span class="pw">'+this.bar(pct)+'<span class="pct">'+pct+'% 完成（'+done+'/'+tasks.length+'）</span></span>'
        + '<i class="sep"></i><span class="lds">';
      Object.keys(ROLE).forEach(id=>{
        const mine = live.filter(t=>ownerIds(t.owner).indexOf(id)>=0);
        const o2 = mine.filter(t=>t.dueDate && this.daysTo(t.dueDate)<0).length;
        s += '<span class="ld'+(o2?' over':'')+'">'+this.av(id)+esc(ROLE[id].n)+' '+mine.length+(o2?' ⚠️'+o2:'')+'</span>';
      });
      return s + '</span>';
    },
    /* ---- v3-18：KPI 条按面板换指标 ----
       原来不管切到哪个面板，顶上都只报「任务 / 在做 / 待验收」—— 站在 BUG 页看任务数没有意义。
       这里按 tab 分派，但仍然是同一个 .tk-kpibar 外壳，观感与任务看板一致。 */
    kpiFor(tab, o) {
      o = o || {};
      const tasks = o.tasks || [], bugs = o.bugs || [], list = o.list || [];
      if (tab === 'devBug') {
        const live = list.filter(r => r.status !== 'closed');
        const block = live.filter(r => r.severity === 'critical').length;
        return UB.kpi([
          [list.length, 'BUG'],
          [list.filter(r => r.status === 'open').length, '待处理'],
          [list.filter(r => r.status === 'fixing').length, '修复中'],
          [list.filter(r => r.status === 'verify').length, '待验证'],
          [block, '阻断未关', block ? 'hot' : '']
        ], { pct: list.length ? Math.round((list.length - live.length) / list.length * 100) : 0, pctLabel: '已关闭' });
      }
      if (tab === 'devLog') {
        const week = list.filter(r => r.date >= D.shift(D.today(), -6));
        const days = {}; week.forEach(r => { days[r.date] = 1; });
        const last = list.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
        return UB.kpi([
          [list.length, '日志'],
          [week.length, '近 7 天'],
          [Object.keys(days).length, '有记录天数'],
          [last ? String(last.date).slice(5) : '—', '最近一篇']
        ], { pct: Math.round(Object.keys(days).length / 7 * 100), pctLabel: '七天覆盖' });
      }
      /* 任务看板：沿用原来的任务 KPI（5 个数 + 总进度 + 成员负载） */
      return this.kpi(tasks, bugs);
    },
    /* ---- 项目详情条（可展开；原来 resourcePanel 的内容整块搬进来） ---- */
    proj(g, p, tasks){
      if(!p) return '';
      const done = tasks.filter(t=>t.status==='done').length;
      const pct = tasks.length ? Math.round(done/tasks.length*100) : 0;
      const live = tasks.filter(t=>t.status!=='done');
      let sum = esc(p.name) + ' · ' + esc(p.engine || '未设置工具')
        + ' · 任务 ' + done + '/' + tasks.length;
      let s = '<div class="tk-proj"><div class="tk-proj-hd" data-tk-proj>'
        + '<b>📁 项目详情</b><span class="sum">'+sum+'</span>'
        + '<span class="tri">'+(this.projOpen?'收起 ▴':'展开 ▾')+'</span></div>';
      if(this.projOpen){
        s += '<div class="tk-pgrid">'
          + '<div class="tk-pf"><i>项目</i><b>'+esc(p.name)+'</b></div>'
          + '<div class="tk-pf"><i>状态</i><b>'+esc(LABELS[p.status] || p.status || '—')+'</b></div>'
          + '<div class="tk-pf"><i>工具</i><b>'+esc(p.engine || '—')+'</b></div>'
          + '<div class="tk-pf" style="grid-column:1/-1"><i>任务分布</i><b>'
            + this.stOrder().map(s2=>this.stName(s2)+' '+tasks.filter(t=>t.status===s2).length).join(' · ')
            + ' · '+overWord()+' '+live.filter(t=>t.dueDate && this.daysTo(t.dueDate)<0).length
            + ' · 完成率 '+pct+'%</b></div>';
        if(p.description) s += '<div class="tk-pf" style="grid-column:1/-1"><i>项目说明</i><b style="font-weight:500">'+esc(p.description)+'</b></div>';
        /* 原「项目资源区」整块搬进来（保持同一份数据与复制行为） */
        const res = g.resourcePanel(p);
        if(res) s += '<div style="grid-column:1/-1">'+res+'</div>';
        s += '</div>';
      }
      /* v3-17：公告沉底但做成大字渐变 footer，收尾即高光（详情收起也照常显示） */
      return s + noticeBar(p) + '</div>';
    },
    /* ---- 视图 1 · 泳道 ---- */
    lane(tasks, all){
      let s = '';
      TB_AREAS.forEach(A=>{
        const list = tasks.filter(t => (t.area || 'misc') === A[0]);
        const doing = list.filter(t=>t.status==='doing'||t.status==='review').length;
        const over = list.filter(t=>t.status!=='done' && t.dueDate && this.daysTo(t.dueDate)<0).length;
        let worst = null;
        this.stOrder().forEach(k=>{
          const sub = list.filter(t=>t.status===k);
          if(sub.length < 2) return;
          const avg = Math.round(sub.reduce((a,t)=>a+(t.touch||0),0)/sub.length);
          if(!worst || avg > worst.avg) worst = { k:k, avg:avg };
        });
        const min = !!this.laneMin[A[0]];
        s += '<div class="tk-lane'+(min?' min':'')+'">'
          + '<div class="tk-lane-hd" data-tk-lane="'+A[0]+'" style="border-left-color:'+A[2]+'">'
          +   '<span>'+A[1]+'</span>'
          +   '<span class="cnt">'+list.length+' 条 · 在做 '+doing+(over?' · <span style="color:'+overColor()+'">'+over+' '+overWord()+'</span>':'')+'</span>'
          +   '<span class="tk-minichips">'+this.stOrder().map(k=>{const n=list.filter(t=>t.status===k).length;return n?'<span>'+this.stName(k)+' '+n+'</span>':'';}).join('')+'</span>'
          +   ((worst && toneMode()!=='soft')?'<span class="hint">⚠️ 「'+this.stName(worst.k)+'」堆积最多 —— 卡点在这</span>':'')
          +   '<span class="tri" style="margin-left:'+(worst?'8px':'auto')+'">'+(min?'展开 ▾':'收起 ▴')+'</span>'
          + '</div><div class="tk-lane-bd">';
        this.stOrder().forEach(k=>{
          const sub = list.filter(t=>t.status===k);
          const cd = this.cdEff();
          const openKey = this.cellOpenKey(A[0], k);
          const cellOpen = !!this.cellOpen[openKey];
          const shown = cellOpen ? sub : sub.slice(0, 3);
          s += '<div class="tk-cell' + (cd === 'row' ? ' tk-cell-row' : '') + '" data-tk-cell="'+esc(k)+'" data-tk-area="'+esc(A[0])+'"><div class="ct">'+this.stName(k)+' '+sub.length+'</div>';
          shown.forEach(t=>{
            const dep = t.dependsOn ? this.find(all, t.dependsOn) : null;
            const blocked = dep && dep.status !== 'done';
            const softs = String(t.soft||'').split(/[,，;；\s]+/).filter(Boolean);
            const mins = t._ut ? Math.max(1, Math.round((Date.now()-t._ut)/60000)) : null;
            const fresh = !!(t.updatedBy && t.updatedBy!==CONFIG.me && mins && mins < 180);
            const lk = t.lockedBy;
            const locked = !!(lk && lk.by && lk.by!==CONFIG.me && (now()-(lk.at||0)) < 15*60000);
            const nD = (DISCUSS[t.id]||[]).length;
            const subsA = Array.isArray(t.subtasks) ? t.subtasks : [];
            const subDone = subsA.filter(function (x) { return x.done; }).length;
            const dList = DISCUSS[t.id] || [];
            const dLast = dList[dList.length-1];

            const head = '<button type="button" class="tk-stbtn" data-tk-st="'+esc(t.id)+'" title="点一下换列（现在：'+esc(this.stName(t.status))+'）" style="background:'+(TB_ST[t.status]||'#888')+'"></button>'
              + '<span class="tk-pri '+this.pri(t)+'">'+this.pri(t)+'</span><span class="tt">'+esc(t.title)+'</span>';
            const ico = '<span class="tk-ico">'
              + '<button type="button" class="tk-ib" data-gd-disc="devTask" data-id="'+esc(t.id)+'" title="团队讨论">💬'+(nD?'<b>'+nD+'</b>':'')+'</button>'
              + '<button type="button" class="tk-ib" data-gd-history="'+esc(t.id)+'" title="历史操作记录">🕘</button>'
              + '<button type="button" class="tk-ib" data-gd-edit="devTask" data-id="'+esc(t.id)+'" title="编辑任务">✏️</button>'
              + '<button type="button" class="tk-ib hoveronly" data-tk-subadd="'+esc(t.id)+'" title="加一步子任务">＋</button>'
              + '</span>';
            const dueHtml = t.dueDate ? this.due(t)+'<span class="tk-mut2">'+esc(String(t.dueDate).slice(5))+'</span>' : '<span class="tk-nodue">未排期</span>';
            const ownBtn = '<button type="button" class="tk-own" data-gd-owner="'+esc(t.id)+'" title="点击更换负责人">'+this.av(t.owner)+'<b>'+esc(this.ownerName(t.owner))+'</b></button>';

            let body = '';
            if(cd === 'row'){
              /* 列表档（88 的落地）：一行 —— P2 · 标题 · 头像 · 到期 */
              body = '<div class="tk-r1">'+head+'</div>'
                + '<span class="tk-rowmeta">'+this.av(t.owner)+'<em>'+dueHtml+'</em></span>';
            } else if(cd === 'tight'){
              /* 紧凑档（87）：标题一行，元信息并进负责人行 */
              const bits = [];
              if(t.stage) bits.push('<span>'+esc(t.stage)+'</span>');
              softs.forEach(function(x){ bits.push('<span class="tk-sw">'+esc(x)+'</span>'); });
              if(t.path) bits.push('<span class="tk-sw" title="'+esc(t.path)+'">UE</span>');
              body = '<div class="tk-r1">'+head+ico+'</div>'
                + '<div class="tk-r3 tk-r23">'+ownBtn+'<span class="tk-sp"></span>'
                +   (bits.length ? '<span class="tk-r23m">'+bits.join(' · ')+'</span>' : '')
                +   (dList.length ? '<span class="tk-cico" title="有 '+dList.length+' 条讨论">💬'+dList.length+'</span>' : '')
                +   (subsA.length ? '<span class="tk-cbar" title="子任务 '+subDone+'/'+subsA.length+'"><i style="width:'+Math.round(subDone/subsA.length*100)+'%"></i></span>' : '')
                +   dueHtml
                + '</div>';
            } else {
              /* 舒适档：分区名不显示（82）、空值不占位（83） */
              const r2 = [];
              if(t.stage) r2.push('<span>'+esc(t.stage)+'</span>');
              softs.forEach(function(x){ r2.push('<span class="tk-sw">'+esc(x)+'</span>'); });
              if(t.path) r2.push('<span class="tk-sw" title="'+esc(t.path)+'">UE 路径</span>');
              body = '<div class="tk-r1">'+head+ico+'</div>'
                + (r2.length ? '<div class="tk-r2">'+r2.join('<i>·</i>')+'</div>' : '')
                + '<div class="tk-r3">'+ownBtn+'<span class="tk-sp"></span>'+dueHtml+'</div>'
                + ((locked||dep||fresh) ? '<div class="tk-r4">'
                      + (locked?'<span class="tk-lk">🔒 '+esc(this.ownerName(lk.by))+' 正在编辑</span>':'')
                      + (dep?'<span class="tk-wait2'+(blocked?' blocked':'')+'">⛓ '+esc(dep.title)+'</span>':'')
                      + (fresh?'<span class="tk-tag">'+(mins<=1?'刚刚更新':mins+' 分钟前更新')+'</span>':'')
                    + '</div>' : '')
                + (subsA.length ? '<div class="tk-subs">'
                    + '<div class="tk-subs-hd"><b>'+subDone+'/'+subsA.length+'</b>'
                    + '<span class="bar"><i style="width:'+Math.round(subDone/subsA.length*100)+'%"></i></span>'
                    + '</div>'
                    + subsA.slice(0,3).map(function (sb, si) {
                        return '<label class="tk-sub'+(sb.done?' done':'')+'"><input type="checkbox" data-tk-sub="'+esc(t.id)+'|'+si+'"'+(sb.done?' checked':'')+' data-no-draft><span>'+esc(sb.text)+'</span>'
                          + '<button type="button" class="del" data-tk-subdel="'+esc(t.id)+'|'+si+'" title="删掉这步">×</button></label>';
                      }).join('')
                    + (subsA.length>3 ? '<div class="tk-sub-more">还有 '+(subsA.length-3)+' 步</div>' : '')
                    + '</div>' : '');
            }

            /* 84：有讨论才占一行；没讨论时「＋」并入 r1 图标组，hover 才浮出 */
            const replyRow = dList.length ? '<div class="tk-reply" data-tk-reply="'+esc(t.id)+'" title="点一下就地回复">'
              + '<span class="ic">💬</span>'
              + '<span class="tx"><b style="color:'+esc(roleOf(dLast.u).c)+'">'+esc(roleOf(dLast.u).n)+'</b>：'+esc(String(dLast.x).slice(0,28))+'</span>'
              + (dList.length>1 ? '<span class="tk-mut2">'+dList.length+'</span>' : '')
              + '</div>' : '';

            s += '<div class="tk-card tk-cd-'+cd+(blocked?' blocked':'')+(this.rsel===t.id?' sel':'')+(locked?' locked':'')+'" draggable="true" data-tk-card="'+esc(t.id)+'" data-tk-open="'+esc(t.id)+'">'
              + body + replyRow
              + '</div>';
          });
          if(!sub.length) s += '<div class="tk-dim" style="font-size:11px;padding:3px 2px">—</div>';
          else if(sub.length > 3){
            s += '<button type="button" class="tk-more" data-tk-more="'+esc(openKey)+'">'+(cellOpen ? '收起' : '还有 '+(sub.length-3)+' 张')+'</button>';
          }
          s += '</div>';
        });
        s += '</div></div>';
      });
      const nb = tasks.filter(t=>{const d=t.dependsOn&&this.find(all,t.dependsOn);return d&&d.status!=='done'&&t.status!=='done';}).length;
      return s + '<div style="font-size:11px;color:var(--muted);line-height:1.75">'
        + '左缘红条 = 前置没完成，现在做也推不动（'+nb+' 条）。泳道头的橙字是「本泳道堆积最多的那一格」。'
        + '<b>卡片可以直接拖</b>（拖到别的状态格 = 改状态，拖到别的泳道 = 换分区，同一格内拖动 = 调顺序）；'
        + '点卡片看右栏详情，双击才进编辑。</div>';
    },
    /* ---- 视图 2 · 总表 ---- */
    sorted(list){
      const k = this.sort.k, dir = this.sort.dir;
      return list.slice().sort((a,b)=>{
        let x = a[k], y = b[k];
        if(k==='owner'){ x = this.ownerName(a.owner); y = this.ownerName(b.owner); }
        if(k==='status'){ x = this.stOrder().indexOf(a.status); y = this.stOrder().indexOf(b.status); }
        if(k==='priority'){ x = ['critical','high','mid','low'].indexOf(a.priority); y = ['critical','high','mid','low'].indexOf(b.priority); }
        if(x==null) x=''; if(y==null) y='';
        if(x<y) return -1*dir; if(x>y) return 1*dir; return 0;
      });
    },
    th(k, label, extra){
      const on = this.sort.k === k;
      return '<th data-tk-sort="'+k+'"'+(extra||'')+'>'+label+(on?(this.sort.dir>0?' ▲':' ▼'):'')+'</th>';
    },
    table(list, all){
      const cols = [['title','任务'],['status','状态'],['stage','阶段'],['owner','负责人'],['priority','优先级'],['dueDate','交期'],['dueDate','剩余'],['soft','主要软件']];
      let s = '<div class="tk-tw"><table class="tk-tbl tk-den'+this.den+'"><thead><tr>'
        + '<th class="nos frz" style="width:32px"></th>' + this.th('title','任务',' class="frz" style="width:240px"')
        + this.th('status','状态') + '<th class="nos">阶段</th>' + this.th('owner','负责人')
        + this.th('priority','优先级') + this.th('dueDate','交期') + '<th class="nos">剩余</th>' + '<th class="nos">主要软件</th>'
        + '</tr></thead><tbody>';
      this.stOrder().forEach(k=>{
        const list2 = this.sorted(list.filter(t=>t.status===k));
        const over = list2.filter(t=>k!=='done' && t.dueDate && this.daysTo(t.dueDate)<0).length;
        const open = !this.grp['s_'+k];
        s += '<tr class="grp" data-tk-grp="s_'+k+'"><td class="frz"></td><td colspan="8">'
          + '<span class="tri">'+(open?'▾':'▸')+'</span> '
          + '<span class="tk-st"><i class="d" style="background:'+TB_ST[k]+'"></i>'+this.stName(k)+'</span> '
          + '<span class="gc">'+list2.length+' 条'+(over?' · <span style="color:'+overColor()+'">'+over+' '+overWord()+'</span>':'')+'</span></td></tr>';
        if(!list2.length) s += '<tr class="'+(open?'':'hide')+'"><td class="frz"></td><td colspan="8" class="tk-dim" style="font-size:11px;padding:9px">— 这一组是空的</td></tr>';
        list2.forEach(t=>{
          const dd = t.dueDate ? this.daysTo(t.dueDate) : null;
          const over2 = t.status!=='done' && dd!==null && dd<0;
          const soon = t.status!=='done' && dd!==null && dd>=0 && dd<=2;
          const op = (k,vals,cur)=>'<td class="tk-ie"><select data-tk-ief="'+k+'" data-tk-id="'+esc(t.id)+'">'
            + vals.map(v=>'<option value="'+esc(v[0])+'"'+(String(v[0])===String(cur==null?'':cur)?' selected':'')+'>'+esc(v[1])+'</option>').join('')+'</select></td>';
          s += '<tr class="r'+(over2?' over':'')+(soon?' soon':'')+(open?'':' hide')+(this.rsel===t.id?' sel':'')+'" data-tk-open="'+esc(t.id)+'">'
            + '<td class="frz"><input type="checkbox" class="tk-chk" data-tk-sel="'+esc(t.id)+'"'+(this.sel.has(t.id)?' checked':'')+'></td>'
            + '<td class="tt frz"><span class="tk-pri '+this.pri(t)+'" style="margin-right:6px">'+this.pri(t)+'</span>'+esc(t.title)+'</td>'
            + op('status', this.stOrder().map(x=>[x,this.stName(x)]), t.status)
            + '<td class="num">'+esc(t.stage || '—')+'</td>'
            + (ownerIds(t.owner).length > 1
                ? '<td class="num" title="多人负责人 —— 点任务名进卡片改">'+esc(this.ownerName(t.owner))+'</td>'
                : op('owner', Object.keys(ROLE).map(x=>[x,ROLE[x].n]), t.owner))
            + op('priority', this.PRI4, t.priority)
            + '<td class="tk-ie"><input type="date" data-tk-ief="dueDate" data-tk-id="'+esc(t.id)+'" value="'+esc(t.dueDate||'')+'"></td>'
            + '<td style="white-space:nowrap">'+this.due(t)+'<span class="tk-saved" data-tk-saved="'+esc(t.id)+'">已存 ✓</span></td>'
            + '<td class="num">'+esc(String(t.soft||'').split(/[,，;；\s]+/).filter(Boolean)[0] || '—')+'</td></tr>';
        });
      });
      s += '</tbody></table></div>';
      s += '<div class="tk-bat'+(this.sel.size?' live':'')+'">'
        + '<span>已选 <b>'+this.sel.size+'</b> 条</span>'
        + '<select data-tk-batf'+(this.sel.size?'':' disabled')+'><option value="">改状态…</option>'+this.stOrder().map(k=>'<option value="'+k+'">'+this.stName(k)+'</option>').join('')+'</select>'
        + '<select data-tk-batm'+(this.sel.size?'':' disabled')+'><option value="">换负责人…</option>'+Object.keys(ROLE).map(k=>'<option value="'+k+'">'+ROLE[k].n+'</option>').join('')+'</select>'
        + '<input type="date" data-tk-batd'+(this.sel.size?'':' disabled')+'>'
        + '<button class="tk-btn" data-tk-batgo'+(this.sel.size?'':' disabled')+'>应用到选中</button>'
        + '<button class="tk-btn" data-tk-batdel'+(this.sel.size?'':' disabled')+'>删除</button>'
        + '<span class="tk-dim" style="font-size:11px;margin-left:auto">状态 / 负责人 / 优先级 / 交期 直接在格子里改；任务名列冻结在左</span></div>';
      return s;
    },
    /* ---- 视图 3 · 时间 ---- */
    time(list){
      const rows = this.sorted(list.filter(t=>t.status!=='done'));
      const days = [];
      for(let i=-2;i<12;i++){ const d = new Date(D.today()+'T00:00:00'); d.setDate(d.getDate()+i); days.push((d.getMonth()+1)+'/'+d.getDate()); }
      const tp = 2/14*100;
      let s = '<table class="tk-gt"><thead><tr><th style="width:240px">任务</th><th style="width:88px">状态</th><th style="width:54px">负责人</th><th style="width:76px">剩余</th>'
        + '<th>交付节奏（最左 2 格 = 已逾期区）<div class="tk-gaxis">'+days.map((x,ix)=>'<span'+(ix===2?' style="color:var(--accent);font-weight:800"':'')+'>'+x+'</span>').join('')+'</div></th></tr></thead><tbody>';
      rows.forEach(t=>{
        const dd = t.dueDate ? this.daysTo(t.dueDate) : 0;
        const over = dd < 0;
        const left = over ? Math.max(0,(dd+2)/14*100) : tp;
        const w = over ? Math.max(3, tp-left) : Math.min(100-tp, dd/14*100);
        s += '<tr data-tk-open="'+esc(t.id)+'">'
          + '<td class="n"><span class="tk-pri '+this.pri(t)+'" style="margin-right:6px">'+this.pri(t)+'</span>'+esc(t.title)+'</td>'
          + '<td class="n"><span class="tk-st"><i class="d" style="background:'+TB_ST[t.status]+'"></i>'+this.stName(t.status)+'</span></td>'
          + '<td class="n">'+this.av(t.owner)+'</td>'
          + '<td class="n tk-dim" style="font-size:11px">'+(t.dueDate?this.due(t):'未排')+'</td>'
          + '<td><div class="tk-track"><div class="gb2'+(over?' over':'')+'" style="left:'+left+'%;width:'+Math.max(w,2)+'%;background:'+(over?'#ef4444':TB_ST[t.status])+'"></div><div class="tv" style="left:'+tp+'%"></div></div></td></tr>';
      });
      s += '</tbody></table>';
      if(!rows.length) s += '<div class="tk-emptyst">没有未完成的任务</div>';
      return s + '<div style="font-size:11px;color:var(--muted);margin-top:8px">已完成的不占位置。蓝线 = 今天，条往左溢出成红 = 已经逾期。</div>';
    },
    /* ---- 右栏 ---- */
    railHtml(g, list, all){
      if(this.rmode === 'task'){
        const t = this.find(all, this.rsel) || list[0];
        if(!t) return '<h3>✎ 任务详情</h3><div class="tk-emptyst">没有任务</div>';
        const ds = DISCUSS[t.id] || [];
        const st = this.stOrder(), nx = st[Math.min(st.length-1, st.indexOf(t.status)+1)];
        const dep = t.dependsOn ? this.find(all, t.dependsOn) : null;
        let s = '<h3>✎ 任务详情 <span class="bx" data-tk-rail="today">← 返回今日</span></h3><div class="tk-det">'
          + '<h4>'+esc(t.title)+'</h4>'
          + '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:5px">'
          +   '<span class="tk-pri '+this.pri(t)+'">'+this.pri(t)+'</span>'
          +   '<span class="tk-st"><i class="d" style="background:'+TB_ST[t.status]+'"></i>'+this.stName(t.status)+'</span>'+this.due(t)+'</div>'
          + '<div class="kv">'
          +   '<i>负责人</i><span style="display:flex;align-items:center;gap:6px">'+this.av(t.owner)+esc(this.ownerName(t.owner))+'</span>'
          +   '<i>阶段</i><span>'+esc(t.stage || '未分区')+'</span>'
          +   '<i>主要软件</i><span>'+esc(t.soft || '—')+'</span>'
          +   '<i>交付日</i><span>'+esc(t.dueDate || '未排期')+'</span>'
          +   (dep?'<i>前置</i><span style="color:'+(dep.status==='done'?'#10b981':'#f5a524')+'">'+esc(dep.title)+'（'+(dep.status==='done'?'已完成':'未完成')+'）</span>':'')
          +   (t.path?'<i>UE 路径</i><span style="word-break:break-all"><code>'+esc(t.path)+'</code></span>':'')
          + '</div>';
        /* 所属项目 */
        const p = g.project();
        if(p){
          const ptasks = D.devAll('devTask', p.id) || [];
          const pdone = ptasks.filter(x=>x.status==='done').length;
          s += '<div class="tk-rsec">所属项目</div><div class="tk-projmini">'
            + '<div class="pn">'+esc(p.name)+'<span style="font-size:10px;padding:0 5px;border-radius:4px;border:1px solid var(--card-border);color:var(--muted)">'+esc(p.engine||'—')+'</span></div>'
            + '<div class="pm">状态 '+esc(LABELS[p.status]||p.status||'—')+(p.targetDate?' · 目标 '+esc(p.targetDate):'')+'</div>'
            + '<div class="pm">负责人 '+esc(this.ownerName(CONFIG.me))+' · 成员 '+Object.keys(ROLE).map(k=>esc(ROLE[k].n)).join(' / ')+'</div>'
             + '<div class="pm">\u4efb\u52a1 '+pdone+'/'+ptasks.length+' \u5b8c\u6210</div>'
            + '</div>';
        }
        s += '<div class="tk-rsec">讨论 '+ds.length+'</div>';
        s += ds.length ? ds.map(m=>'<div class="tk-msg">'+this.av(m.u)+'<div class="b"><div class="tb-disc-n">'+whoName(m.u)+'<span style="opacity:.75">'+esc(fmtT(m.t))+'</span></div>'+esc(m.x)+'</div></div>').join('')
          : '<div class="tk-emptyst">还没有讨论</div>';
        s += '<div class="tk-rbtns"><button class="tk-btn" data-tk-adv="'+esc(t.id)+'">推进到 '+this.stName(nx)+'</button>'
          + '<button class="tk-btn" data-tk-disc="'+esc(t.id)+'">讨论</button></div>'
          + '<div class="tk-rbtns"><button class="tk-btn pri" style="width:100%" data-tk-edit="'+esc(t.id)+'">完整编辑</button></div>';
        return s + '</div>';
      }
      /* 今日更新（v2.13.0 · 61/70/71/73/76/79） */
      return this.todayUpdate(g, all);
    },
    /* ============================================================
       v2.13.0 · 今日更新
       ------------------------------------------------------------
       数据源：stamp() 给每条记录写的 _fields{字段:{t,by}}，跟着记录
       走、跨设备同步，不依赖会话内 LOG —— 所以「今天谁动了哪个字段」
       是可靠的，换台机器打开也对得上。
         61 一条任务一行（同任务多次改动聚合成一条，标次数）
         70 只显示今天的（更早的收进折叠，默认不占屏）
         71 一键复制今日摘要（纯文本，直接粘微信）
         73 摘要卡（360px 一屏一张，深浅两版，专门截图）
         76 变更类型图标化（新建/换列/子任务/讨论/编辑）
         79 新建与改动分开（「今天新建 N 个」独立一组）
       ============================================================ */
    uTime(ms){ const d=new Date(ms||0); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); },
    uDay(ms){ const d=new Date(ms||0); return (d.getMonth()+1)+'-'+('0'+d.getDate()).slice(-2); },
    uWho(id){ const r=roleOf(id); return r?r.n:'有人'; },
    uType(keys, disc, isNew){
      if(isNew)                       return {k:'new', n:'新建',   c:'#10b981', i:'＋'};
      if(keys.indexOf('status')>=0)   return {k:'move',  n:'换列',   c:'#f5a524', i:'→'};
      if(keys.indexOf('subtasks')>=0) return {k:'sub',  n:'子任务', c:'#e879f9', i:'☑'};
      if(keys.length)                 return {k:'edit', n:'编辑', c:'#667eea', i:'✎'};
      if(disc)                        return {k:'discuss',n:'讨论', c:'#60a5fa', i:'💬'};
      return {k:'edit', n:'编辑', c:'#667eea', i:'✎'};
    },
    uReadMap(){
      if(this._uRead) return this._uRead;
      try { return JSON.parse(localStorage.getItem(SYNC_PREFIX+'tread_'+CONFIG.me)||'{}')||{}; } catch(e) { return {}; }
    },
    uMarkRead(id){
      const r=(this._uRows||[]).filter(function(x){return x.t.id===id;})[0];
      if(!r) return;
      const m=this.uReadMap(); m[id]=r.last; this._uRead=m;
      try { localStorage.setItem(SYNC_PREFIX+'tread_'+CONFIG.me, JSON.stringify(m)); } catch(e) {}
    },
    /* 扫今天的更新 —— 一条任务一行 */
    uScan(all){
      const mid = new Date(D.today()+'T00:00:00').getTime();
      const rows = [];
      (all||[]).forEach(function(t){
        const f = t._fields || {};
        let last = 0, by = '', keys = [];
        Object.keys(f).forEach(function(k){
          const ft = f[k] && f[k].t;
          if(!ft) return;
          if(ft >= mid){ keys.push(k); if(ft > last){ last = ft; by = f[k].by || ''; } }
        });
        const ut = t._ut || t.updatedAt || 0;
        if(!keys.length && ut >= mid){ last = ut; by = t.updatedBy || ''; }
        const ds = DISCUSS[t.id] || [];
        const dl = ds[ds.length-1];
        const disc = (dl && (dl.t||0) >= mid) ? dl : null;
        if(disc) keys = keys.filter(function(k){ return k !== '__disc'; });
        /* 只回了讨论、字段没动，也算今天有更新 */
        if(!last && disc){ last = disc.t; by = disc.u || ''; }
        if(!last) return;
        if(disc && (disc.t||0) > last){ last = disc.t; by = disc.u || by; }
        /* 新建的记录没有 updatedBy，by 要兜底到 recorder，否则会被当成「自己改的」 */
        rows.push({ t:t, last:last, by:(by || t.updatedBy || t.recorder || CONFIG.me), keys:keys, disc:disc, isNew:(t.createdAt||0) >= mid });
      });
      rows.sort(function(a,b){ return b.last-a.last; });
      return rows;
    },
    /* 更早的（昨天及以前），方案 70 */
    uOlder(all){
      const mid = new Date(D.today()+'T00:00:00').getTime();
      const out = [];
      (all||[]).forEach(function(t){
        const ut = t._ut || t.updatedAt || 0;
        if(ut && ut < mid && t.status !== 'done') out.push({ t:t, last:ut });
      });
      out.sort(function(a,b){ return b.last-a.last; });
      return out.slice(0,6);
    },
    /* 字段 → 当前值（摘要里用） */
    uVal(t,k){
      if(k==='status')   return this.stName(t.status);
      if(k==='owner')    return this.ownerName(t.owner);
      if(k==='priority') return ({critical:'P0',high:'P1',mid:'P2',low:'P3'})[t.priority] || t.priority || '';
      if(k==='dueDate')  return t.dueDate || '未排期';
      if(k==='title')    return t.title || '';
      if(k==='subtasks'){
        const a = Array.isArray(t.subtasks) ? t.subtasks : [];
        return a.filter(function(x){return x.done;}).length + '/' + a.length + ' 步';
      }
      if(k==='dependsOn') return t.dependsOn ? '有前置' : '';
      return '';
    },
    uLabels(keys){
      return (keys||[]).map(function(k){ return TBoard.uFieldCn(k); }).filter(Boolean);
    },
    /* fieldLabel 只认部分字段，这里补齐今日更新会用到的全部 */
    uFieldCn(k){
      var FL = { title:'标题', status:'状态', owner:'负责人', priority:'优先级', dueDate:'交期',
                 subtasks:'子任务', stage:'阶段', soft:'主要软件', path:'UE 路径', dependsOn:'前置',
                 area:'分区', category:'分类', description:'说明' };
      if (FL[k]) return FL[k];
      var v = (typeof fieldLabel === 'function') ? fieldLabel(k) : '';
      return (v && v !== k) ? v : k;
    },
    /* 摘要卡里的「一条时间线」 */
    uTimeline(r){
      const f = r.t._fields || {};
      const mid = new Date(D.today()+'T00:00:00').getTime();
      const items = [];
      Object.keys(f).forEach(function(k){
        const ft = f[k] && f[k].t;
        if(ft && ft >= mid) items.push({ t:ft, k:k, by:f[k].by });
      });
      items.sort(function(a,b){ return a.t-b.t; });
      const self = this;
      let h = items.map(function(x){
        const v = self.uVal(r.t, x.k);
        return '<div class="tk-uli"><span class="tm">'+self.uTime(x.t)+'</span>'+esc(self.uWho(x.by))+' 改了 '+esc(self.uFieldCn(x.k))+(v?' → '+esc(String(v).slice(0,18)):'')+'</div>';
      }).join('');
      if(r.disc) h += '<div class="tk-uli"><span class="tm">'+this.uTime(r.disc.t)+'</span>'+esc(this.uWho(r.disc.u))+'：'+esc(String(r.disc.x).slice(0,46))+'</div>';
      return h || '<div class="tk-uli">没有字段级记录</div>';
    },
    /* 面板主体 */
    todayUpdate(g, all){
      this._uAll = all || [];
      const rows = this.uScan(this._uAll);
      this._uRows = rows;
      const rd = this.uReadMap();
      const self = this;
      const isUnread = function(r){ return r.last > (rd[r.t.id]||0) && r.by !== CONFIG.me; };
      const unread = rows.filter(isUnread).length;
      const news = rows.filter(function(r){ return r.isNew; });
      const chgs = rows.filter(function(r){ return !r.isNew; });
      const seenIds = {};
      rows.forEach(function(r){ seenIds[r.t.id] = 1; });
      const older = this.uOlder(this._uAll).filter(function(o){ return !seenIds[o.t.id]; });

      const rowHtml = function(r){
        const T = self.uType(r.keys, r.disc, r.isNew);
        const n = r.keys.length + (r.disc?1:0);
        const labs = self.uLabels(r.keys).slice(0,2);
        const mt = self.uTime(r.last)+' · '+self.uWho(r.by)+(labs.length?' · '+labs.join('、'):'');
        return '<div class="tk-urow'+(isUnread(r)?' unread':'')+'" data-tk-uid="'+esc(r.t.id)+'">'
          + '<div class="tk-uhd">'
          +   '<span class="tk-utype" style="color:'+T.c+';border-color:'+T.c+'66">'+T.i+' '+T.n+'</span>'
          +   '<span class="tk-utt">'+esc(r.t.title)+'</span>'
          +   (n>1?'<span class="tk-un">'+n+'</span>':'')
          + '</div>'
          + '<div class="tk-umt">'+esc(mt)+'</div>'
          + '<div class="tk-utl">'+self.uTimeline(r)+'</div>'
          + '</div>';
      };

      let s = '<h3>🔔 今日更新'+(rows.length?'<span class="tk-ubadge">'+rows.length+'</span>':'')+'</h3>';
      if(!rows.length){
        s += '<div class="tk-emptyst">今天还没有人动过任务。改一次状态、加一步子任务，这里就会出现。</div>';
      } else {
        s += '<div class="tk-ucnt">今天 <b>'+rows.length+'</b> 条改动'+(unread?' · <b class="hl">'+unread+'</b> 条你没看过':' · 你都看过了')+'</div>';
        if(news.length) s += '<div class="tk-rsec">今天新建 · '+news.length+'</div>' + news.map(rowHtml).join('');
        if(chgs.length) s += '<div class="tk-rsec">今天改动 · '+chgs.length+'</div>' + chgs.map(rowHtml).join('');
      }
      if(older.length){
        s += '<details class="tk-uolder"><summary>更早的更新 · '+older.length+'</summary>'
          + older.map(function(o){
              return '<div class="tk-uold" data-tk-open="'+esc(o.t.id)+'">'+esc(o.t.title)+'<span>'+self.uDay(o.last)+'</span></div>';
            }).join('')
          + '</details>';
      }
      s += '<div class="tk-uact">'
        + '<button type="button" class="tk-btn" data-tk-ucopy title="复制成一段能直接粘给同事的话">⧉ 复制摘要</button>'
        + '<button type="button" class="tk-btn" data-tk-ucard title="生成一张适合截图的卡片">▣ 摘要卡</button>'
        + '<button type="button" class="tk-btn tk-uhelp" data-tk-uhelp title="怎么用">?</button>'
        + '</div>';
      return s;
    },
    /* 71 · 纯文本摘要 */
    digestText(all){
      const rows = this.uScan(all || D.devAll('devTask'));
      const self = this;
      const lines = ['【团队看板 · '+D.today().slice(5)+' 更新】'];
      if(!rows.length) lines.push('（今天没有更新）');
      rows.forEach(function(r){
        const T = self.uType(r.keys, r.disc, r.isNew);
        let tail = r.keys.map(function(k){
          const label = self.uFieldCn(k);
          const v = self.uVal(r.t, k);
          return label+(v?' → '+v:'');
        }).join('、');
        if(!tail && r.disc) tail = '讨论：'+String(r.disc.x).slice(0,32);
        if(!tail) tail = T.n;
        lines.push('· '+r.t.title+'（'+self.uWho(r.by)+' '+self.uTime(r.last)+'）'+tail);
      });
      if(rows.length) lines.push('— 共 '+rows.length+' 条，其中新建 '+rows.filter(function(r){return r.isNew;}).length+' 条 · 来自 NIKO 团队看板');
      return lines.join('\n');
    },
    /* 73 · 摘要卡浮层 */
    openDigestCard(all){
      const self = this;
      const old = root.querySelector('.tk-dgm');
      if(old) old.remove();
      const rows = this.uScan(all || D.devAll('devTask'));
      const body = rows.length ? rows.map(function(r){
        const T = self.uType(r.keys, r.disc, r.isNew);
        const labs = self.uLabels(r.keys);
        const tail = labs.length ? labs.join('、') : (r.disc ? '讨论' : T.n);
        return '<div class="tk-dgi"><i style="background:'+T.c+'"></i><span><b>'+esc(r.t.title)+'</b> · '
          + esc(self.uWho(r.by))+' '+self.uTime(r.last)+' · '+esc(tail)+'</span></div>';
      }).join('') : '<div class="tk-dgi" style="opacity:.6">今天没有更新</div>';
      const m = document.createElement('div');
      m.className = 'tk-dgm';
      m.innerHTML = '<div class="tk-dg" data-dg="dark">'
        + '<div class="tk-dgh"><b>'+D.today().slice(5)+' 团队更新</b><span>'+rows.length+' 条</span></div>'
        + body
        + '<div class="tk-dgf">NIKO 团队看板 · '+self.uTime(now())+'</div>'
        + '</div>'
        + '<div class="tk-dgb">'
        +   '<button type="button" class="tk-btn" data-dg-theme>切换深浅</button>'
        +   '<button type="button" class="tk-btn" data-dg-copy>复制文字</button>'
        +   '<button type="button" class="tk-btn" data-dg-close>关闭</button>'
        + '</div>';
      root.appendChild(m);
      m.addEventListener('click', function(e){
        if(e.target === m || e.target.closest('[data-dg-close]')){ m.remove(); return; }
        if(e.target.closest('[data-dg-theme]')){
          const card = m.querySelector('.tk-dg');
          card.dataset.dg = card.dataset.dg === 'dark' ? 'light' : 'dark';
          return;
        }
        if(e.target.closest('[data-dg-copy]')){
          const txt = self.digestText(all || D.devAll('devTask'));
          if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt);
          else { const ta=document.createElement('textarea'); ta.value=txt; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy');}catch(x){} document.body.removeChild(ta); }
          toast('摘要已复制','ok');
        }
      });
      return m;
    },

    /* ---- 主渲染 ---- */
    html(g, tasks, all, p){
      if(this.view === 'table'){
        return this.toolbar(g) + '<div class="tk-wrap'+(this.rail?'':' norail')+'"><div class="tk-main">'+this.table(tasks, all)+'</div>'
          + (this.rail?'<aside class="tk-rail">'+this.railHtml(g, tasks, all)+'</aside>':'')+'</div>';
      }
      if(this.view === 'time'){
        return this.toolbar(g) + '<div class="tk-wrap'+(this.rail?'':' norail')+'"><div class="tk-main">'+this.time(tasks)+'</div>'
          + (this.rail?'<aside class="tk-rail">'+this.railHtml(g, tasks, all)+'</aside>':'')+'</div>';
      }
      return this.toolbar(g) + '<div class="tk-wrap'+(this.rail?'':' norail')+'"><div class="tk-main">'+this.lane(tasks, all)+'</div>'
        + (this.rail?'<aside class="tk-rail">'+this.railHtml(g, tasks, all)+'</aside>':'')+'</div>';
    },
    toolbar(g){
      const V = [['lane','▦','泳道'],['table','☷','总表'],['time','◷','时间']];
      return '<div class="tk-bar">'
        + '<div class="tk-seg">'+V.map(v=>'<button type="button" data-tk-view="'+v[0]+'"'+(this.view===v[0]?' class="on"':'')+'><span>'+v[1]+'</span>'+v[2]+'</button>').join('')+'</div>'
        + '<span class="tk-srch">'+I.get('search')+'<input data-tk-kw placeholder="搜任务…" value="'+esc(this.kw)+'"></span>'
        + '<button type="button" class="tk-btn'+(this.den==='2'?' on':'')+'" data-tk-den title="表格行高">▤ '+(this.den==='2'?'宽松':'紧凑')+'</button>'
        + '<div class="tk-seg tk-cdseg">'+[['auto','◐','自适应'],['comfy','▤','舒适'],['tight','▥','紧凑'],['row','☰','列表']].map(function(v){
            return '<button type="button" data-tk-cd="'+v[0]+'"'+(this.cd===v[0]?' class="on"':'')+' title="卡片密度：'+v[2]+'（现在是 '+({auto:'自适应',comfy:'舒适',tight:'紧凑',row:'列表'})[this.cdEff()]+'）">'+v[1]+'</button>';
          }, this).join('')+'</div>'
        + '<button type="button" class="tk-btn'+(this.rail?' on':'')+'" data-tk-railbtn title="右侧栏">▥ 右栏</button>'
        + '<select class="input" data-tk-member aria-label="筛选成员" style="width:auto">'+optionList(Object.entries(ROLE).map(([id,r])=>[id,r.n]),g._member,'全部成员')+'</select>'
        + '<button type="button" class="tk-btn pri" style="margin-left:auto" data-tk-new>'+I.get('plus')+'新建任务</button>'
        + '</div>';
    },
    /* ---- 事件 ---- */
    bind(box, g, App){
      const self = this;
      /* v2.14.0 · 卡片密度切换 / 每列展开收起 */
      box.addEventListener('click', function(e){
        var cdb = e.target.closest('[data-tk-cd]');
        if(cdb){
          e.stopPropagation();
          self.cd = cdb.dataset.tkCd;
          try { localStorage.setItem(SYNC_PREFIX+'cden', self.cd); } catch(x) {}
          render();
          return;
        }
        var mb = e.target.closest('[data-tk-more]');
        if(mb){
          e.stopPropagation();
          var key = mb.dataset.tkMore;
          if(self.cellOpen[key]) delete self.cellOpen[key]; else self.cellOpen[key] = 1;
          render();
          return;
        }
      });
      /* v2.13.0 · 今日更新：点条目展开时间线 + 标已读 / 复制摘要 / 摘要卡 / 帮助 */
      box.addEventListener('click', function(e){
        const u = e.target.closest('[data-tk-uid]');
        if(u){
          e.stopPropagation();
          u.classList.toggle('open');
          u.classList.remove('unread');
          self.uMarkRead(u.dataset.tkUid);
          return;
        }
        if(e.target.closest('[data-tk-ucopy]')){
          e.stopPropagation();
          const txt = self.digestText(self._uAll);
          if(navigator.clipboard && navigator.clipboard.writeText){
            navigator.clipboard.writeText(txt).then(function(){ toast('摘要已复制，可以直接粘给同事','ok'); }, function(){ self._fbCopy(txt); });
          } else self._fbCopy(txt);
          return;
        }
        if(e.target.closest('[data-tk-ucard]')){
          e.stopPropagation();
          self.openDigestCard(self._uAll);
          return;
        }
        if(e.target.closest('[data-tk-uhelp]')){
          e.stopPropagation();
          toast('点一条看它今天被改了什么；左侧蓝线 = 你还没看过。单击卡片切任务详情，双击标题就地改名。','ok');
          return;
        }
      });
      self._fbCopy = self._fbCopy || function(t){
        const ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta); ta.select();
        try{ document.execCommand('copy'); toast('摘要已复制','ok'); }catch(x){ toast('复制失败，手动选一下','warn'); }
        document.body.removeChild(ta);
      };
      /* v3-22：删子任务按钮单独挂一个更早的 capture 监听 —— 它长在 <label> 里，
         主委托链容易被上层分支先吃掉，这里第一顺位拦，命中就停。 */
      box.addEventListener('click', function(e){
        const d = e.target.closest('[data-tk-subdel]');
        if(!d) return;
        e.preventDefault(); e.stopPropagation();
        const p = String(d.dataset.tkSubdel||'').split('|');
        delSub(p[0], p[1]);
      }, true);
      box.addEventListener('click', function(e){
        const el = e.target;
        const v = el.closest('[data-tk-view]');
        if(v){ self.view = v.dataset.tkView; g.repaint(); return; }
        if(el.closest('[data-tk-proj]')){ self.projOpen = !self.projOpen; g.repaint(); return; }
        if(el.closest('[data-tk-den]')){ self.den = self.den==='1'?'2':'1'; g.repaint(); return; }
        if(el.closest('[data-tk-railbtn]')){ self.rail = !self.rail; g.repaint(); return; }
        if(el.closest('[data-tk-rail]')){ self.rmode = el.closest('[data-tk-rail]').dataset.tkRail; g.repaint(); return; }
        const lane = el.closest('[data-tk-lane]');
        if(lane){ self.laneMin[lane.dataset.tkLane] = !self.laneMin[lane.dataset.tkLane]; g.repaint(); return; }
        const grp = el.closest('[data-tk-grp]');
        if(grp){ self.grp[grp.dataset.tkGrp] = !self.grp[grp.dataset.tkGrp]; g.repaint(); return; }
        const sort = el.closest('[data-tk-sort]');
        if(sort){ const k = sort.dataset.tkSort; self.sort.dir = (self.sort.k===k) ? -self.sort.dir : 1; self.sort.k = k; g.repaint(); return; }
        if(el.closest('[data-tk-new]')){ g.openEditor('devTask'); return; }
        const ed = el.closest('[data-tk-edit]');
        if(ed){ g.openEditor('devTask', ed.dataset.tkEdit); return; }
        const adv = el.closest('[data-tk-adv]');
        if(adv){
          const t = D.devAll('devTask').filter(x=>x.id===adv.dataset.tkAdv)[0];
          if(t){ const st = self.stOrder(); try{ D.devSave('devTask',{status:st[Math.min(st.length-1, st.indexOf(t.status)+1)]}, t.id); g.repaint(); App.toast('状态已更新'); }catch(err){ App.toast(err.message,7000); } }
          return;
        }
        const dis = el.closest('[data-tk-disc]');
        if(dis){ openDevDiscussion('devTask', dis.dataset.tkDisc); return; }
        /* 批量 */
        if(el.closest('[data-tk-batgo]')){
          const f = box.querySelector('[data-tk-batf]'), m = box.querySelector('[data-tk-batm]'), d = box.querySelector('[data-tk-batd]');
          let n = 0;
          D.devAll('devTask').forEach(t=>{
            if(!self.sel.has(t.id)) return;
            const patch = {};
            if(f && f.value){ patch.status = f.value; n++; }
            if(m && m.value){ patch.owner = m.value; n++; }
            if(d && d.value){ patch.dueDate = d.value; n++; }
            if(Object.keys(patch).length){ try{ D.devSave('devTask', patch, t.id); }catch(err){} }
          });
          self.sel.clear(); g.repaint();
          App.toast(n ? ('已应用 '+n+' 处改动') : '先在下拉里选一个要改的值', n ? '' : 7000);
          return;
        }
        if(el.closest('[data-tk-batdel]')){
          const dels = D.devAll('devTask').filter(t=>self.sel.has(t.id));
          if(!dels.length) return;
          dels.forEach(t=>{ try{ D.devRemove('devTask', t.id); }catch(err){} });
          self.sel.clear(); g.repaint();
          App.toast('已删除 '+dels.length+' 条（可在开发记录回收站恢复）', 7000);
          return;
        }
        if(el.closest('input,select,textarea')) return;
        if(el.closest('.tk-sub,.tk-subs')) return;   /* v3-22：子任务区不算「点卡片开详情」 */
        /* v3-21：卡片里的快捷按钮，必须抢在「打开详情」之前拦掉 */
        const stb = el.closest('[data-tk-st]');
        if(stb){ e.stopPropagation(); self.statusMenu(stb, stb.dataset.tkSt, g); return; }
        /* v3-22：卡内就地编辑，一律拦在「打开详情」之前 */
        const sba = el.closest('[data-tk-subadd]');
        if(sba){ e.stopPropagation(); startSubAdd(sba); return; }
        const rpl = el.closest('[data-tk-reply]');
        if(rpl){ e.stopPropagation(); startReply(rpl); return; }
        const sbd = el.closest('[data-tk-subdel]');
        if(sbd){ e.stopPropagation(); e.preventDefault(); const pp=String(sbd.dataset.tkSubdel||'').split('|'); delSub(pp[0], pp[1]); return; }
        /* 子任务勾选必须放行到 target（capture 阶段 stopPropagation 会让 checkbox 根本不切换），
           只在这里 return；后面的「打开详情」由 GameDev 侧排除 .tk-sub/.tk-subs 兜住 */
        if(el.closest('.tk-sub,.tk-subs')) return;
        /* 卡片上的 💬/🕘/✏️/换负责人 走原有 data-gd-* 处理器，别再顺带选中卡片 */
        if(el.closest('[data-gd-disc],[data-gd-history],[data-gd-edit],[data-gd-owner]')) return;
        const op = el.closest('[data-tk-open]');
        if(op){ self.rsel = op.dataset.tkOpen; self.rmode = 'task'; g.repaint(); return; }
      }, true);
      box.addEventListener('dblclick', function(e){
        if(e.target.closest('input,textarea,.tk-reply,.tk-subs')) return;
        const tt = e.target.closest('[data-tk-card] .tt');
        if(tt){ e.preventDefault(); e.stopPropagation(); inlineTitle(tt); return; }
        const op = e.target.closest('[data-tk-open]');
        if(op){ e.preventDefault(); g.openEditor('devTask', op.dataset.tkOpen); }
      });
      /* v3-21：右键卡片 = 一个菜单解决 编辑/讨论/历史/换列/复制/加入/删除 */
      box.addEventListener('contextmenu', function(e){
        const card = e.target.closest('[data-tk-card]');
        if(!card) return;
        e.preventDefault();
        self.cardMenu(card, card.dataset.tkCard, e.clientX, e.clientY, g);
      });
      box.addEventListener('change', function(e){
        const el = e.target;
        const sb = el.closest('[data-tk-sub]');
        if(sb){
          const pr = String(sb.dataset.tkSub||'').split('|'), id = pr[0], idx = Number(pr[1]);
          const t = D.devAll('devTask').filter(function(x){return x.id===id;})[0];
          if(t){
            const subs = (Array.isArray(t.subtasks)?t.subtasks:[]).slice();
            if(subs[idx]) subs[idx] = Object.assign({}, subs[idx], {done: !!sb.checked});
            try{ D.devSave('devTask',{subtasks:subs},id); g.repaint(); }
            catch(err){ sb.checked = !sb.checked; App.toast(err.message,7000); }
          }
          return;
        }
        const ck = el.closest('[data-tk-sel]');
        if(ck){
          const id = ck.dataset.tkSel;
          if(ck.checked) self.sel.add(id); else self.sel.delete(id);
          const bat = box.querySelector('.tk-bat');
          if(bat){
            bat.querySelector('b').textContent = self.sel.size;
            bat.classList.toggle('live', self.sel.size > 0);
            bat.querySelectorAll('select,input,button').forEach(x=>{ x.disabled = self.sel.size === 0; });
          }
          return;
        }
        const ie = el.closest('[data-tk-ief]');
        if(ie){
          const id = ie.dataset.tkId, f = ie.dataset.tkIef;
          const patch = {}; patch[f] = ie.value;
          try{ D.devSave('devTask', patch, id); }catch(err){ App.toast(err.message,7000); return; }
          const sv = box.querySelector('[data-tk-saved="'+id+'"]');
          if(sv){ sv.classList.add('on'); setTimeout(()=>{ sv.classList.remove('on'); }, 1400); }
          if(f === 'status' || f === 'owner') setTimeout(()=>g.repaint(), 900);
          return;
        }
        const mem = el.closest('[data-tk-member]');
        if(mem){ g._member = mem.value; g.repaint(); return; }
      });
      let tm = null;
      box.addEventListener('input', function(e){
        if(!e.target.matches('[data-tk-kw]')) return;
        const v = e.target.value.trim();
        clearTimeout(tm);
        tm = setTimeout(()=>{ self.kw = v; g.repaint(); }, 220);
      });
      /* ---- 拖拽（v2.5.1）：卡片直接拖到别的状态 / 别的泳道，并记住顺序 ---- */
      let dragId = null;
      box.addEventListener('dragstart', function(e){
        const c = e.target.closest('[data-tk-card]'); if(!c) return;
        dragId = c.dataset.tkCard; c.classList.add('tk-dragging');
        try { e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', dragId); } catch(x){}
      });
      box.addEventListener('dragend', function(){
        box.querySelectorAll('.tk-dragging').forEach(c=>c.classList.remove('tk-dragging'));
        box.querySelectorAll('.tk-cell.over').forEach(c=>c.classList.remove('over'));
        dragId = null;
      });
      box.addEventListener('dragover', function(e){
        const cell = e.target.closest('[data-tk-cell]');
        if(!cell || !dragId) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect='move'; } catch(x){}
        box.querySelectorAll('.tk-cell.over').forEach(c=>{ if(c!==cell) c.classList.remove('over'); });
        cell.classList.add('over');
      });
      box.addEventListener('drop', function(e){
        const cell = e.target.closest('[data-tk-cell]');
        if(!cell || !dragId) return;
        e.preventDefault();
        box.querySelectorAll('.tk-cell.over').forEach(c=>c.classList.remove('over'));
        const id = dragId; dragId = null;
        const rec = D.devAll('devTask').filter(x=>x.id===id)[0]; if(!rec) return;
        const status = cell.dataset.tkCell, area = cell.dataset.tkArea;
        if(!status) return;
        const cards = [].slice.call(cell.querySelectorAll('[data-tk-card]')).filter(c=>c.dataset.tkCard!==id);
        let index = cards.length;
        for(let i=0;i<cards.length;i++){ const r=cards[i].getBoundingClientRect(); if(e.clientY < r.top + r.height/2){ index=i; break; } }
        const moved = status !== rec.status || (area && area !== (rec.area || 'misc'));
        try {
          const patch = { status: status }; if(area) patch.area = area;
          D.devSave('devTask', patch, id);
          const list = D.devAll('devTask').filter(function(x){
            return x.projectId===rec.projectId && x.status===status && (x.area||'misc')===(area||x.area||'misc');
          }).sort(function(a,b){ const ao=(a.order==null?9999:a.order), bo=(b.order==null?9999:b.order); return ao-bo; });
          const at = list.findIndex(function(x){ return x.id===id; }); if(at>=0) list.splice(at,1);
          list.splice(Math.max(0, Math.min(index, list.length)), 0, rec);
          list.forEach(function(x,i){ if(x.order!==i) D.devSave('devTask',{order:i},x.id); });
          g.repaint();
          App.toast(moved ? ('已移到「'+LABELS[status]+'」') : ('已调整顺序（第 '+(index+1)+' 位）'));
        } catch(err){ App.toast(err.message, 7000); }
      });
    },
    /* 键盘（由 onKeydown 转发） */
    key(e){
      if(e.key === '1'){ this.view='lane'; return true; }
      if(e.key === '2'){ this.view='table'; return true; }
      if(e.key === '3'){ this.view='time'; return true; }
      if(e.key === 't'){ this.rail = !this.rail; return true; }
      if(e.key === 'j' || e.key === 'k'){
        const ids = D.devAll('devTask').map(t=>t.id);
        let i = ids.indexOf(this.rsel);
        i = (i < 0 ? 0 : i) + (e.key==='j' ? 1 : -1);
        i = Math.max(0, Math.min(ids.length-1, i));
        this.rsel = ids[i] || ''; this.rmode = 'task';
        return true;
      }
      return false;
    },
    reset(){ this.view='lane'; this.rail=true; this.rmode='today'; this.rsel=''; this.den='1'; this.projOpen=false;
      this.grp={}; this.laneMin={}; this.sel=new Set(); this.sort={k:'dueDate',dir:1}; this.kw=''; }
  };

const GameDev = {
  key:'gamedev',title:'游戏开发',icon:'gamepad',_tab:'devTask',_project:'',_query:'',_filter:'',_area:'',_stage:'',_soft:'',_box:null,_clock:null,_member:'',
  repaint(){render();return Promise.resolve();},
  project:function() {
    const projects=D.devAll('devProject');
    let p=projects.find(r=>r.id===this._project);
    if(!p){p=projects.find(r=>r.status!=='archived') || projects[0];this._project=p?p.id:'';}
    return p || null;
  },
  body:function() {
    const p=this.project(),id=p?p.id:'',tab=this._tab;
    const projects=D.devAll('devProject');
    const all=function(kind){return id?D.devAll(kind,id):[];};
    const tasks=all('devTask'),bugs=all('devBug');
    // v2.3.3：表头一比一对齐目标设计 —— 口号区砍掉，左=项目元信息（名/状态/引擎·日期），右=紧凑操作组
    const title='<div class="gd-heading">'
      + '<div class="gd-proj-meta">'+(p?'<h3>'+esc(p.name)+'</h3>'+badge(p.status)+'<span class="gd-proj-line">'+esc(p.engine || '未设置工具')+(p.targetDate?' · '+esc(p.targetDate):'')+'</span>':'<span class="gd-noproj">未选择项目</span>')+'</div>'
      + '<div class="gd-project-bar"><select class="input" id="gd-project" data-no-draft aria-label="当前项目">'+optionList(projects.map(r=>[r.id,r.name+(r.status==='archived'?'（已归档）':'')]),id,projects.length?'':'还没有项目')+'</select>'
      + '<button class="btn btn-sm" data-gd-projects>'+I.get('gamepad')+'项目管理</button>'
      + '<button class="btn btn-primary btn-sm" data-gd-new-project>'+I.get('plus')+'新建项目</button></div>'
      + '</div>';
    const picker='';
    const kpiItems=[['\u4efb\u52a1\u603b\u6570',tasks.length],['\u8fdb\u884c\u4e2d',tasks.filter(r=>r.status==='doing').length],['\u5f85\u9a8c\u6536',tasks.filter(r=>r.status==='review').length],['\u5f85\u5f00\u53d1',tasks.filter(r=>r.status==='backlog').length],['\u672a\u5173\u95ed BUG',bugs.filter(r=>r.status!=='closed').length]];
    const kpibar='<div class="tk-kpibar">'+TBoard.kpiFor(tab,{tasks:tasks,bugs:bugs,list:all(tab),projectId:id})+'</div>';
    const tkProj=TBoard.proj(this,p,tasks);
    const info=p?'<section class="gd-project-card">'+(p.description?'<p class="gd-project-desc">'+esc(p.description)+'</p>':'')+this.resourcePanel(p)+noticeBar(p)+'</section>':'';
    const tabs='<div class="gd-tabs" role="tablist" aria-label="开发功能">'+TABS.map(function(t){return '<button role="tab" tabindex="'+(tab===t[0]?'0':'-1')+'" aria-selected="'+(tab===t[0])+'" class="gd-tab'+(tab===t[0]?' on':'')+'" data-gd-tab="'+t[0]+'">'+I.get(t[2])+'<span>'+t[1]+'</span><small>'+all(t[0]).length+'</small></button>';}).join('')+'</div>';
    if(!p)return title+picker+tabs+'<div class="gd-empty gd-welcome"><span class="gd-empty-icon">'+I.get('gamepad')+'</span><h3>先给你的作品建一个项目</h3><p>填写名称和目标，就能开始安排任务、记录 BUG 和沉淀开发日志。</p><button class="btn btn-primary" data-gd-new-project>创建第一个项目</button></div>';
    const toolbar='<div class="gd-toolbar"><div class="gd-search"><span>'+I.get('search')+'</span><input id="gd-search" class="input" aria-label="搜索当前功能" placeholder="搜索'+TABS.find(t=>t[0]===tab)[1]+'…" value="'+esc(this._query)+'"></div>'+this.filterSelect()+'<select id="gd-member" class="input" aria-label="筛选成员">'+optionList(Object.entries(ROLE).map(([id,r])=>[id,r.n]),this._member,'全部成员')+'</select><button class="btn btn-primary" data-gd-new="'+tab+'">'+I.get('plus')+NEW_LABELS[tab]+'</button></div>';
    const rows=all(tab).filter(r=>this.matches(r));
    let body='';
    if(tab==='devTask')body=TBoard.html(this, TBoard.stack(tasks,id,this._member), tasks, p);
    if(tab==='devBug')body=this.bugs(rows);
    if(tab==='devLog')body=this.logs(rows);
    const isTB=(tab==='devTask');
    return title+picker+(isTB?tkProj:info)+kpibar+tabs+(isTB?'':this.filterBar(tab,tasks))+(isTB?'':toolbar)+'<section class="gd-content" role="tabpanel" aria-label="'+TABS.find(t=>t[0]===tab)[1]+'">'+body+'</section>';
  },
  filterBar:function(tab,tasks) {
    if(tab!=='devTask')return '';
    const area=this._area,stage=this._stage,soft=this._soft;
    const AREA=[['','全部'],['art','🎨 美术开发'],['prog','💻 程序开发'],['misc','🧩 通用 / 策划']];
    const RAIL=[['art','美术开发',['资产制作','UV 拆分','材质制作','UI 制作','美术场景搭建']],['prog','程序开发',['玩法程序','系统功能','工具脚本','优化调优','联调测试']],['misc','通用 / 策划',['策划','评审','文档']]];
    const head=AREA.map(function(a){return '<button type="button" class="gd-areabtn'+(area===a[0]?' on':'')+'" data-gd-area="'+a[0]+'">'+esc(a[1])+'</button>';}).join('');
    const rail=RAIL.filter(function(g){return !area||area===g[0];}).map(function(g){
      const items=g[2].map(function(s){
        const n=tasks.filter(function(x){return (x.stage || '')===s;}).length;
        return '<button type="button" class="gd-step'+(stage===s?' on':'')+'" data-gd-stage="'+esc(s)+'"><i></i>'+esc(s)+' <em>'+n+'</em></button>';
      }).join('<span class="gd-railarr">›</span>');
      return '<span class="gd-railgrp"><b>'+esc(g[1])+'</b>'+items+'</span>';
    }).join('');
    const softs=SOFTS.map(function(s){return '<button type="button" class="gd-softbtn'+(soft===s?' on':'')+'" data-gd-soft="'+s+'">'+s+'</button>';}).join('');
    const dirty=!!(area||stage||soft);
    return '<div class="gd-filterbar"><span class="gd-areaseg">'+head+'</span>'
      +'<span class="gd-softseg"><em>软件</em>'+softs+'</span>'
      +'<span class="gd-clearf'+(dirty?'':' gd-hide')+'" data-gd-clearflt>↺ 清空筛选</span></div>'
      +'<div class="gd-rail">'+rail+'</div>';
  },
  filterSelect:function() {
    const choices=(D.DEV_SCHEMA[D.KEYS[this._tab]].choices.status || []).map(v=>[v,LABELS[v]]);
    return choices.length?'<select id="gd-filter" class="input" aria-label="筛选记录" data-no-draft>'+optionList(choices,this._filter,'全部')+'</select>':'';
  },
  matches:function(r) {
    if(this._member&&ownerIds(r.owner).indexOf(this._member)<0)return false;
    if(this._tab==='devTask'){
      if(this._area&&(r.area || '')!==this._area)return false;
      if(this._stage&&(r.stage || '')!==this._stage)return false;
      if(this._soft&&String(r.soft || '').split(/[,，;；\s]+/).filter(Boolean).indexOf(this._soft)<0)return false;
    }
    if(this._query&&Object.keys(r).filter(k=>typeof r[k]==='string').map(k=>r[k]).join(' ').toLowerCase().indexOf(this._query.toLowerCase())<0)return false;
    const f=this._filter;
    if(!f)return true;
    return r.status===f;
  },
  empty:function(text) {return '<div class="gd-empty"><h3>'+esc(text || '这里还没有记录')+'</h3><p>'+(this._query||this._filter?'可以调整搜索或筛选条件。':'点击右上方按钮，开始记录这个项目。')+'</p></div>';},
  resourcePanel:function(p) {
    const lines=String(p.resources || '').split('\n').map(function(s){return s.trim();}).filter(Boolean);
    const notes=String(p.notes || '').split('\n').map(function(s){return s.trim();}).filter(Boolean);
    const items=[];
    if(p.rootPath)items.push({ic:'📁',lb:'工程总路径',vl:p.rootPath,sub:''});
    lines.forEach(function(line){
      const seg=line.split('|').map(function(s){return s.trim();});
      const head=(seg[0] || '').split(/\s+/);
      const ic=head.shift() || '🔗';
      const lb=head.join(' ') || '链接';
      items.push({ic:ic,lb:lb,vl:seg[1] || '',sub:seg[2] || ''});
    });
    if(!items.length && !notes.length && !p.notice)return '<div class="gd-res gd-res-empty"><span class="gd-res-h">📌 项目资源</span><span class="gd-res-hint">工程总路径 / 素材网盘 / 排期表 / 策划文档 / ⚠️注意事项 —— 点右上「编辑」填一次，全组都能用</span></div>';
    // v2.3.3：区头 = 标题+摘要 左，编辑/折叠 右（对齐目标设计）；默认收起，状态记本机
    const folded=resFolded(p.id);
    const nRes=items.length,nNote=notes.length;
    const summary=(nRes?nRes+' 项资源':'')+(nNote?(nRes?' · ':'')+nNote+' 条注意事项':'')||'空';
    const body='<div class="gd-res-body'+(folded?' folded':'')+'">'
      + (items.length ? '<div class="gd-res-grid">' + items.map(function(it){
            const isUrl=/^https?:\/\//i.test(it.vl);
            const val=isUrl
              ? '<a class="gd-res-vl gd-a" href="'+esc(it.vl)+'" target="_blank" rel="noopener noreferrer" title="点击打开链接">'+esc(it.vl)+'</a>'
              : '<i class="gd-res-vl">'+esc(it.vl)+'</i>';
            const act=isUrl
              ? '<button type="button" class="gd-res-copyicon" data-gd-rescopy="'+encodeURIComponent(it.vl)+'" title="一键复制链接">⧉</button><a class="gd-res-open" href="'+esc(it.vl)+'" target="_blank" rel="noopener noreferrer" title="打开链接">打开 ↗</a>'
              : '<button type="button" class="gd-res-open" data-gd-rescopy="'+encodeURIComponent(it.vl)+'" title="一键复制">复制 ↗</button>';
            return '<div class="gd-res-i"><span class="gd-res-ic">' + esc(it.ic) + '</span><span class="gd-res-tx"><b>' + esc(it.lb) + (it.sub ? '　·　' + esc(it.sub) : '') + '</b>' + val + '</span>' + act + '</div>';
          }).join('') + '</div>' : '')
      + (notes.length ? '<div class="gd-res-notes"><b>⚠️ 注意事项</b><ul>' + notes.map(function(n){return '<li>' + linkify(esc(n)) + '</li>';}).join('') + '</ul></div>' : '')
      + '</div>';
    return '<div class="gd-res">'
      + '<div class="gd-res-head"><span class="gd-res-t">📌 项目资源</span><small>'+esc(summary)+'</small>'
      + '<span class="gd-res-acts">'
      + '<button type="button" class="btn btn-sm gd-res-edit" data-gd-edit="devProject" data-id="'+esc(p.id)+'" title="编辑本项目资源与信息">✏️ 编辑</button>'
      + '<button type="button" class="gd-res-fold" data-gd-resfold="'+esc(p.id)+'" aria-expanded="'+(!folded)+'" title="'+(folded?'展开':'收起')+'项目资源">'+(folded?'展开 ▸':'收起 ▾')+'</button>'
      + '</span></div>'
      + body + '</div>';
  },
  bugs:function(rows) {
    if(!rows.length)return this.empty('让问题都有复现步骤和处理结果');
    const ST=[['open','待处理'],['fixing','修复中'],['verify','待验证'],['closed','已关闭']];
    const SEV={critical:['P0','阻断'],high:['P1','高'],medium:['P2','一般'],low:['P3','低']};
    const statuses=D.DEV_SCHEMA.devBugs.choices.status;
    const list=rows.slice().sort((a,b)=>['critical','high','medium','low'].indexOf(a.severity)-['critical','high','medium','low'].indexOf(b.severity));
    const card=function(r){
      const sev=SEV[r.severity]||SEV.medium;
      const nD=(DISCUSS[r.id]||[]).length;
      const next=statuses[statuses.indexOf(r.status)+1];
      const nImg=(r.images||[]).length;
      const env=String(r.environment||'');
      return '<div class="tk-card" data-gd-open="devBug" data-id="'+esc(r.id)+'">'
        + UB.head(sev[0],sev[1],r.title,'devBug',r.id,nD)
        + '<div class="tk-r2">'
        +   (env?'<span class="tk-sw" title="'+esc(env)+'">'+esc(env.slice(0,14))+(env.length>14?'…':'')+'</span>':'<span class="tk-dim2">未填环境</span>')
        +   (nImg?'<span class="tk-tag">📷 '+nImg+'</span>':'')
        +   (r.solution?'<span class="tk-tag">已有处理记录</span>':'')
        + '</div>'
        + '<div class="tk-r3">'+UB.who(r.owner||r.recorder)+'<span class="tk-sp"></span>'
        +   (next?'<button type="button" class="tb-adv" data-gd-advance="devBug" data-id="'+esc(r.id)+'" title="移到「'+esc(LABELS[next])+'」">→ '+esc(LABELS[next])+'</button>':'')
        + '</div></div>';
    };
    const live=list.filter(r=>r.status!=='closed'), block=live.filter(r=>r.severity==='critical').length;
    return UB.lane({icon:'◇',title:'BUG 追踪',color:'#ef4444',cls:'tb-c4',
        sub:live.length+' 条未关闭'+(block?' · '+block+' 条阻断':'')+' · 共 '+list.length+' 条',
        hint:block?'⚠️ 有 '+block+' 条阻断级没关':'',
        tail:'按严重程度排',
        cols:ST,
        count:function(k){return list.filter(r=>r.status===k).length;},
        cell:function(k){return list.filter(r=>r.status===k).map(card).join('');}})
      + '<div style="font-size:11px;color:var(--muted);line-height:1.75;margin-top:8px">P0=阻断（红）· P1=高 · P2=一般 · P3=低。卡上「→ 状态」一步推到下一格；点卡片看复现步骤与截图。</div>';
  },
  logs:function(rows) {
    if(!rows.length)return this.empty('给明天的自己留下一个明确的起点');
    const list=rows.slice().sort((a,b)=>String(b.date).localeCompare(String(a.date))||(b._ut||0)-(a._ut||0));
    return '<div class="tb-loglist">'+list.map(function(r){
      const nD=(DISCUSS[r.id]||[]).length;
      return '<div class="tb-logrow">'
        + '<div class="tb-logdate"><b>'+esc(String(r.date).slice(5))+'</b><span>星期'+esc(D.weekCn(r.date))+'</span></div>'
        + '<div class="tk-card tb-logcard" data-gd-open="devLog" data-id="'+esc(r.id)+'">'
        + '<div class="tb-loghd">'+UB.ico('devLog',r.id,nD)+'</div>'
        + (r.done?'<div class="tb-line main"><i>完成</i><span>'+esc(r.done)+'</span></div>':'')
        + (r.blockers?'<div class="tb-line warn"><i>阻碍</i><span>'+esc(r.blockers)+'</span></div>':'')
        + (r.next?'<div class="tb-line ok"><i>下次</i><span>'+esc(r.next)+'</span></div>':'')
        + '</div></div>';
    }).join('')+'</div>'
      + '<div style="font-size:11px;color:var(--muted);line-height:1.75;margin-top:8px">按日期倒序，一篇卡三段：完成 / 阻碍 / 下次。<b>「下次」是写给自己的下一步</b>，别留空。</div>';
  },
  bind:function(box) {
    const self=this;
    box.addEventListener('input',function(e){if(e.target.id==='gd-search'){self._query=e.target.value;self.repaint();}});
    box.addEventListener('keydown',function(e){
      const current=e.target.closest('[role=tab]');
      if(!current||['ArrowLeft','ArrowRight','Home','End'].indexOf(e.key)<0)return;
      e.preventDefault();const index=TABS.findIndex(t=>t[0]===current.dataset.gdTab);
      const next=e.key==='Home'?0:e.key==='End'?TABS.length-1:(index+(e.key==='ArrowRight'?1:TABS.length-1))%TABS.length;
      self.chooseTab(TABS[next][0]);
    });
    box.addEventListener('change',function(e){
      if(e.target.id==='gd-project'){self._project=e.target.value;self.resetFilters();self.repaint();}
      if(e.target.id==='gd-member'){self._member=e.target.value;self.repaint();}
      if(e.target.id==='gd-filter'){self._filter=e.target.value;self.repaint();}
    });
    let dragTask=null;
    box.addEventListener('dragstart',function(e){const t=e.target.closest('[data-gd-task]');if(!t)return;dragTask=t.dataset.gdTask;t.classList.add('gd-dragging');try{e.dataTransfer.effectAllowed='move';}catch(x){}});
    box.addEventListener('dragend',function(e){const t=e.target.closest('[data-gd-task]');if(t)t.classList.remove('gd-dragging');box.querySelectorAll('.gd-column.over').forEach(function(c){c.classList.remove('over');});});
    box.addEventListener('dragover',function(e){const col=e.target.closest('.gd-column');if(!col||!dragTask)return;e.preventDefault();box.querySelectorAll('.gd-column.over').forEach(function(c){if(c!==col)c.classList.remove('over');});col.classList.add('over');});
    box.addEventListener('drop',function(e){
      const col=e.target.closest('.gd-column');if(!col||!dragTask)return;e.preventDefault();
      box.querySelectorAll('.gd-column.over').forEach(function(c){c.classList.remove('over');});
      const id=dragTask;dragTask=null;
      const rec=D.devAll('devTask').find(function(x){return x.id===id;});if(!rec)return;
      const status=col.dataset.gdCol;if(!status)return;
      const cards=[].slice.call(col.querySelectorAll('[data-gd-task]')).filter(function(c){return c.dataset.gdTask!==id;});
      let index=cards.length;
      for(let i=0;i<cards.length;i++){const rect=cards[i].getBoundingClientRect();if(e.clientY<rect.top+rect.height/2){index=i;break;}}
      const moved=status!==rec.status;
      try{
        D.devSave('devTask',{status:status},id);
        const list=D.devAll('devTask').filter(function(x){return x.projectId===rec.projectId&&x.status===status;}).sort(function(a,b){const ao=(a.order==null?9999:a.order),bo=(b.order==null?9999:b.order);return ao-bo;});
        const at=list.findIndex(function(x){return x.id===id;});if(at>=0)list.splice(at,1);
        list.splice(Math.max(0,Math.min(index,list.length)),0,rec);
        list.forEach(function(x,i){if(x.order!==i)D.devSave('devTask',{order:i},x.id);});
        self.repaint();
        App.toast(moved?('已移到「'+LABELS[status]+'」'):('已调整顺序（第 '+(index+1)+' 位）'));
      }catch(err){App.toast(err.message,7000);}
    });
    box.addEventListener('click',function(e){
      // v2.3.2：项目资源区 —— 一键复制 / 折叠（放最前，避免被别的委托吃掉）
      const rcopy=e.target.closest('[data-gd-rescopy]');
      if(rcopy){let txt=rcopy.dataset.gdRescopy||'';try{txt=decodeURIComponent(txt);}catch(x){}copyText(txt,function(){App.toast('已复制到剪贴板');});return;}
      const rf=e.target.closest('[data-gd-resfold]');
      if(rf){toggleResFold(rf.dataset.gdResfold);self.repaint();return;}
      const ar=e.target.closest('[data-gd-area]'),st=e.target.closest('[data-gd-stage]'),so=e.target.closest('[data-gd-soft]'),cf=e.target.closest('[data-gd-clearflt]');
      if(ar){self._area=ar.dataset.gdArea;self._stage='';self.repaint();return;}
      if(st){self._stage=(self._stage===st.dataset.gdStage?'':st.dataset.gdStage);self.repaint();return;}
      if(so){self._soft=(self._soft===so.dataset.gdSoft?'':so.dataset.gdSoft);self.repaint();return;}
      if(cf){self._area='';self._stage='';self._soft='';self.repaint();return;}
      const ow=e.target.closest('[data-gd-owner]');
      if(ow){
        const oid=ow.dataset.gdOwner,cur=D.devAll('devTask').find(function(x){return x.id===oid;});
        const picked=new Set(ownerIds(cur&&cur.owner));
        App.openModal({title:'负责人（可多选）',sub:'可以选多人 —— 卡片上会并排显示头像，「筛选成员」里每个人都能看到这张卡。',width:440,
          html:'<div class="gd-owner-pick">'+Object.entries(ROLE).map(function(p){
              return '<button type="button" class="btn'+(picked.has(p[0])?' btn-primary':'')+'" data-gd-setowner="'+esc(p[0])+'">'
                + '<i class="tb-who" style="margin-right:5px"><i style="background:'+esc(p[1].c)+'"></i></i>'+esc(p[1].n)+' · '+esc(p[1].r)+'</button>';
            }).join(' ')+'</div>'
            +'<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button type="button" class="btn" data-gd-setowner-cancel>取消</button><button type="button" class="btn btn-primary" data-gd-setowner-save>保存负责人</button></div>',
          mount:function(mb){mb.onclick=function(ev){
            const btn=ev.target.closest('[data-gd-setowner]');
            if(btn){const id=btn.dataset.gdSetowner;if(picked.has(id))picked.delete(id);else picked.add(id);btn.classList.toggle('btn-primary',picked.has(id));return;}
            if(ev.target.closest('[data-gd-setowner-cancel]')){App.closeModal();return;}
            if(ev.target.closest('[data-gd-setowner-save]')){
              try{D.devSave('devTask',{owner:Array.from(picked).join(',')},oid);App.closeModal();self.repaint();App.toast(picked.size?'负责人已更新':'已清空负责人');}
              catch(err){App.toast(err.message,7000);}
            }
          };}});
        return;
      }
      const disc=e.target.closest('[data-gd-disc]'),hist=e.target.closest('[data-gd-history]');if(disc){openDevDiscussion(disc.dataset.gdDisc,disc.dataset.id);return;}if(hist){showHistory(hist.dataset.gdHistory);return;}
      const tab=e.target.closest('[data-gd-tab]');
      if(tab){self.chooseTab(tab.dataset.gdTab);return;}
      if(e.target.closest('[data-gd-new-project]')){self.openEditor('devProject');return;}
      if(e.target.closest('[data-gd-projects]')){self.openProjects();return;}
      const add=e.target.closest('[data-gd-new]'),edit=e.target.closest('[data-gd-edit]');
      if(add){self.openEditor(add.dataset.gdNew);return;}
      if(edit){self.openEditor(edit.dataset.gdEdit,edit.dataset.id);return;}
      const del=e.target.closest('[data-gd-delete]');
      if(del){self.remove(del.dataset.gdDelete,del.dataset.id);return;}
      const advance=e.target.closest('[data-gd-advance]');
      if(advance){const kind=advance.dataset.gdAdvance,r=D.devAll(kind).find(r=>r.id===advance.dataset.id),statuses=D.DEV_SCHEMA[D.KEYS[kind]].choices.status;
        if(r)try{D.devSave(kind,{status:statuses[statuses.indexOf(r.status)+1]},r.id);self.repaint();App.toast('状态已更新');}catch(err){App.toast(err.message,7000);}return;}
      const openc=e.target.closest('[data-gd-open]');
      if(openc){self.openEditor(openc.dataset.gdOpen,openc.dataset.id);return;}
      const img=e.target.closest('[data-gd-image]');
      if(img){const r=D.devAll('devBug').find(r=>r.id===img.dataset.gdImage);if(r&&r.images[+img.dataset.index])App.openModal({title:r.title,width:900,html:thumb(r.images[+img.dataset.index],'BUG 截图').replace('<img ','<img class="gd-image-full" ')});}
    });
    TBoard.bind(box, this, App);
  },
  chooseTab:function(key) {
    if(!TABS.some(t=>t[0]===key))key='devTask';
    this._tab=key;this.resetFilters();TBoard.kw='';
    this.repaint().then(()=>{const tab=this._box.querySelector('[role=tab][data-gd-tab="'+key+'"]');if(tab)tab.focus({preventScroll:true});});
  },
  resetFilters:function() {
    this._query='';this._filter='';this._area='';this._stage='';this._soft='';
    const search=this._box&&this._box.querySelector('#gd-search');
    if(search){search.value='';search.defaultValue='';}
  },
  openProjects:function() {
    const self=this,rows=D.devAll('devProject');
    App.openModal({title:'项目管理',sub:'归档项目保留全部记录，可在编辑项目中恢复。',width:640,html:'<div class="gd-project-list">'+rows.map(r=>'<div><button class="btn" data-gd-select-project="'+esc(r.id)+'">'+esc(r.name)+'</button>'+badge(r.status)+'<button class="btn btn-sm" data-gd-manage="'+esc(r.id)+'">编辑</button></div>').join('')+'</div><button class="btn btn-primary" id="gd-project-add">新建项目</button>',mount:function(body){body.onclick=function(e){const choose=e.target.closest('[data-gd-select-project]'),edit=e.target.closest('[data-gd-manage]');if(choose){self._project=choose.dataset.gdSelectProject;self.resetFilters();App.closeModal();self.repaint();}if(edit)self.openEditor('devProject',edit.dataset.gdManage);if(e.target.closest('#gd-project-add'))self.openEditor('devProject');};}});
  },
  remove:function(kind,id) {
    const self=this,r=D.devAll(kind).find(r=>r.id===id);
    if(!r){App.toast('记录已被删除');return;}
    if(kind==='devTask')DEV.devTasks.forEach(t=>{if(t.dependsOn===id){const prev=clone(t);t.dependsOn='';stamp(t,prev);}});
    askConfirm({title:'删除这条记录？',msg:'删除会同步到团队，记录可以在回收站恢复。',ok:'确认删除',danger:true,then:yes=>{if(!yes)return;try{D.devRemove(kind,id);self.repaint();App.toast('已移入回收站');}catch(err){App.toast(err.message);}}});
  },
  openEditor:function(kind,id) {
    const self=this,p=this.project(),r=id?D.devAll(kind).find(r=>r.id===id):{};
    if(!r){App.toast('记录已被删除');return;}
    if(kind!=='devProject'&&!p){App.toast('请先创建项目');return;}
    // v2.4.1：别人 15 分钟内锁着这张卡 → 不开编辑器，只提示
    if(kind==='devTask'&&id&&r.lockedBy&&r.lockedBy.by&&r.lockedBy.by!==CONFIG.me&&(now()-(r.lockedBy.at||0))<15*60000){App.toast('🔴 '+roleOf(r.lockedBy.by).n+' 正在编辑这张卡，稍后再来');return;}
    const schema=D.DEV_SCHEMA[D.KEYS[kind]];
    let html='';
    let customTask=false; // v2.4.0：devTask 用目标图四的双列大弹窗（自带底栏）
    if(kind==='devProject')html=field('name','项目名称',r.name,'text','required maxlength="200"')+field('engine','开发工具 / 版本',r.engine || 'UE / Houdini','text','maxlength="200"')+select('status','项目状态',schema.choices.status,r.status || 'active')+field('targetDate','目标交付日期',r.targetDate,'date')+area('description','项目简介 / 范围',r.description,'描述核心玩法、目标平台和当前版本范围')+field('rootPath','工程总路径',r.rootPath,'text','maxlength="300" placeholder="/Game/HuoDong/"')+area('resources','资源链接（一行一条）',r.resources,'格式：图标 名称 | 地址 | 备注　例：📊 排期表 | https://… | 日韩素材排期总表')+area('notes','注意事项（一行一条）',r.notes,'长期有效的规矩　例：Houdini 导出前先 Apply Transform、单位统一 cm')+area('notice','公告',r.notice,'会过期的短期提醒　例：本周目标——档案柜三档先跑通普通档');
    if(kind==='devTask'){
      customTask=true;
      const tasks=D.devAll('devTask',p.id).filter(t=>t.id!==id);
      const dlist=id?(DISCUSS[id]||[]):[];
      const discBlock='<div class="gd-field gd-full gd-discfield"><span>💬 讨论（'+dlist.length+'）· 讨论留在卡上</span>'
        +(dlist.length?'<div class="gd-disc-list">'+dlist.map(function(m){return '<p>'+whoName(m.u)+' · '+esc(dstr(m.t))+' '+fmtT(m.t)+'</p><p class="gd-disc-x">'+esc(m.x)+'</p>';}).join('')+'</div>':'<p class="gd-note">还没有讨论 · 第一个说什么</p>')
        +'<div class="gd-disc-row"><input class="input" id="gd-disc-input" data-mention placeholder="回复…（'+esc(mentionHint())+'）" maxlength="20000"><button type="button" class="btn btn-primary btn-sm" id="gd-disc-send">发送</button></div></div>';
      // v2.4.0：一比一对齐目标编辑弹窗 —— 左列文本，右列状态/进度/分区/阶段/软件/路径/讨论
      html='<div class="gd-ed-grid">'
        + '<div class="gd-ed-col">'
        + field('title','资产名称 / 任务名称',r.title,'text','required maxlength="200"')
        + area('description','📝 任务说明',r.description,'这块可以放开写：要做什么、美术/程序怎么配合、接口边界、注意事项、参考链接…')
        + area('acceptance','验收标准',r.acceptance,'例如：手柄与键鼠均可完成交互，没有报错')
        + area('note','备注',r.note,'随手记：临时约定、参考、提醒')
        + '</div>'
        + '<div class="gd-ed-col">'
        + '<div class="gd-ed-pair">'+select('status','状态',schema.choices.status,r.status || 'backlog')+select('priority','优先级',[['critical','P0 阻断'],['high','P1 高'],['mid','P2 中'],['low','P3 低']],r.priority || 'mid')+'</div>'
        + '<div class="gd-ed-pair">'+field('dueDate','交付日',r.dueDate,'date')+'<div></div></div>'
        + chipGroup('owner','负责人（可多选）',Object.entries(ROLE).map(function(kv){return [kv[0],kv[1].n];}),ownerIds(r.owner||CONFIG.me),true)
        + slider('prog','进度',r.prog==null?0:r.prog)
        + chipGroup('area','分区',[['art','🎨 美术开发'],['prog','💻 程序开发'],['misc','🧩 通用 / 策划']],r.area || 'art',false)
        + chipGroup('stage','流程阶段',STAGE_LIST.map(function(s){return [s,s];}),r.stage || '',false)
        + chipGroup('soft','主要软件',SOFTS.map(function(s){return [s,s];}),String(r.soft || '').split(/[,，;；\s]+/).filter(Boolean),true)
        + field('path','UE 资源路径',r.path,'text','maxlength="2000" placeholder="/Game/HuoDong/…"')
        + select('dependsOn','前置任务',tasks.map(function(t){return [t.id,t.title];}),r.dependsOn,'无前置任务')
        + discBlock
        + '</div></div>';
    }
    if(kind==='devBug')html=field('title','BUG 标题',r.title,'text','required maxlength="200"')+select('status','状态',schema.choices.status,r.status || 'open')+select('severity','严重程度',schema.choices.severity,r.severity || 'medium')+field('environment','环境 / 软件版本',r.environment,'text','maxlength="1000"')+area('steps','复现步骤',r.steps,'1. 打开关卡\n2. 执行操作\n3. 观察结果')+area('expected','预期结果',r.expected)+area('actual','实际结果',r.actual)+area('solution','修复 / 验证记录',r.solution)+'<div class="gd-field gd-full"><span>问题截图（最多 2 张，每张不超过 1 MB）</span><input id="gd-bug-files" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple><div id="gd-bug-previews" class="gd-screenshots"></div><p class="gd-note">截图上传到同一团队私有仓。移除引用保留原文件；本地模拟模式刷新后截图重置。</p></div>';
    if(kind==='devLog')html=field('date','记录日期',r.date || D.today(),'date','required')+area('done','完成 / 进展',r.done,'今天实现了什么？尝试了哪些方案？')+area('blockers','遇到的阻碍',r.blockers,'当前卡在哪里？还需要验证什么？')+area('next','下次继续',r.next,'留下下一次打开项目时的第一步');
    if(!customTask)html=chipGroup('owner','负责人（可多选）',Object.entries(ROLE).map(([id,r])=>[id,r.n]),ownerIds(r.owner||CONFIG.me),true)+html;
    const taskFoot=customTask?'<div class="gd-form-actions gd-full gd-ed-foot"><span class="gd-ed-foot-l"><button type="submit" class="btn btn-primary" id="gd-editor-save">📌 更改保存</button><button type="button" class="btn" id="gd-editor-draft" title="草稿自动存本机">📄 有草稿</button></span>'+(id?'<button type="button" class="btn btn-danger" id="gd-editor-del">🗑 删除</button>':'')+'</div>':'';
    html='<form id="gd-editor" class="gd-form'+(customTask?' gd-form-task':'')+'">'+html+(customTask?taskFoot:'<div class="gd-form-actions gd-full"><button type="button" class="btn" id="gd-editor-cancel">取消</button><button type="submit" class="btn btn-primary" id="gd-editor-save">'+(id?'保存修改':'创建记录')+'</button></div>')+'</form>';
    // v2.4.1：编辑锁 —— 打开即锁 + 4 分钟续期；任何关闭路径（X/保存/删除/Esc）都解锁
    let lockTimer=null;
    const releaseLock=()=>{if(lockTimer){clearInterval(lockTimer);lockTimer=null;}if(kind==='devTask'&&id){try{devLock(id,false);}catch(e){}}return true;}; // 必须返回 true：beforeClose 约定 false=否决，undefined 会被 !v 误判成否决
    const modalOpt={title:kind==='devProject'?(id?'编辑项目':'新建开发项目'):(customTask?(id?r.title:NEW_LABELS[kind]):(id?EDIT_LABELS[kind]:NEW_LABELS[kind])),sub:kind==='devProject'?'项目是四类开发记录的归属。':esc(p.name),width:customTask?980:940,html:html,beforeClose:releaseLock,mount:function(body){
      const form=body.querySelector('form'),draftKey=kind+'|'+(id||p?.id||'new');let images=(r.images || []).slice(),loading=false;
      const restored=localDrafts[draftKey];if(restored?.__images)images=restored.__images;if(restored){form.querySelectorAll('[name]').forEach(el=>{if(restored[el.name]!==undefined)el.value=restored[el.name];});}
      function persistDraft(){const d={__images:images};form.querySelectorAll('[name]').forEach(el=>{d[el.name]=el.value;});try{localDrafts[draftKey]=d;saveDrafts();}catch(err){App.toast('本机草稿保存失败，请保留表单');}}body.oninput=persistDraft;
      if(customTask){
        // v2.4.1：上锁 + 4 分钟续期（别人看卡 15 分钟内显示「正在编辑」胶囊）
        if(id){try{devLock(id,true);lockTimer=setInterval(function(){try{devLock(id,true);}catch(e){}},4*60000);}catch(e){}}
        // v2.4.0：草稿恢复后同步芯片选中态 + 滑条标签
        if(restored){form.querySelectorAll('.gd-chiprow').forEach(function(row){const hidden=row.querySelector('input[type=hidden]');const vals=(hidden.value||'').split(',').filter(Boolean);row.querySelectorAll('.gd-pick').forEach(function(b){b.classList.toggle('on',vals.indexOf(String(b.dataset.val))>=0);});});const rv=body.querySelector('.gd-slideval'),rg=form.querySelector('[name=prog]');if(rv&&rg)rv.textContent=rg.value+'%';}
        // 滑条实时 %
        const range=form.querySelector('[name=prog]');
        if(range)range.oninput=function(){const sv=body.querySelector('.gd-slideval');if(sv)sv.textContent=range.value+'%';persistDraft();};
        // 芯片组：单选互斥 / 多选拼接
        form.querySelectorAll('.gd-chiprow').forEach(function(row){
          row.addEventListener('click',function(e){
            const btn=e.target.closest('.gd-pick');if(!btn)return;
            const hidden=row.querySelector('input[type=hidden]');
            if(row.dataset.multi){btn.classList.toggle('on');hidden.value=[...row.querySelectorAll('.gd-pick.on')].map(function(b){return b.dataset.val;}).join(',');}
            else{row.querySelectorAll('.gd-pick').forEach(function(b){b.classList.remove('on');});btn.classList.add('on');hidden.value=btn.dataset.val;}
            persistDraft();
          });
        });
        // 任务说明字数
        const desc=form.querySelector('[name=description]');
        if(desc){const cnt=document.createElement('span');cnt.className='gd-charcount';cnt.textContent=((desc.value||'').length)+' 字';desc.closest('.gd-field').querySelector('span').appendChild(cnt);desc.addEventListener('input',function(){cnt.textContent=((desc.value||'').length)+' 字';});}
        // 底栏：有草稿 / 删除
        const draftBtn=body.querySelector('#gd-editor-draft');
        if(draftBtn)draftBtn.onclick=function(){persistDraft();App.toast('草稿已存本机，下次打开自动恢复');};
        const delBtn=body.querySelector('#gd-editor-del');
        if(delBtn)delBtn.onclick=function(){App.closeModal();self.remove('devTask',id);};
        // 讨论内置：发送即入线程（与卡片 💬 同一份 DISCUSS）+ @提醒
        const sendBtn=body.querySelector('#gd-disc-send');
        if(sendBtn)sendBtn.onclick=function(){
          const inp=body.querySelector('#gd-disc-input');const v=(inp.value||'').trim();if(!v)return;
          if(!id){App.toast('先保存任务，再发讨论');return;}
          const before=clone(collectLocal());
          (DISCUSS[id]=DISCUSS[id]||[]).push({u:CONFIG.me,t:tick(),x:v});log('discuss',id,'开发记录讨论');
          let at=[];try{at=notifyMentions(v,id);}catch(err){at=[];}
          try{save();inp.value='';
            const wrap=body.querySelector('.gd-discfield');
            const cnt=wrap.querySelector('span');cnt.textContent='💬 讨论（'+DISCUSS[id].length+'）· 讨论留在卡上';
            let list=wrap.querySelector('.gd-disc-list');
            if(!list){const note=wrap.querySelector('.gd-note');if(note)note.remove();list=document.createElement('div');list.className='gd-disc-list';wrap.insertBefore(list,wrap.querySelector('.gd-disc-row'));}
            const last=DISCUSS[id][DISCUSS[id].length-1];
            list.insertAdjacentHTML('beforeend','<p>'+whoName(last.u)+' · '+esc(dstr(last.t))+' '+fmtT(last.t)+'</p><p class="gd-disc-x">'+esc(last.x)+'</p>');
            updateBell();App.toast(at.length?'📨 已提醒 '+at.join('、'):'已发送到本机，等待同步');
          }catch(e){applyState(before);App.toast(e.message,'warn');}
        };
      }
      body.querySelector('#gd-editor-cancel')?.addEventListener('click',()=>App.closeModal());
      function imagePreview(){const node=body.querySelector('#gd-bug-previews');if(!node)return;node.innerHTML=images.map((src,i)=>'<div>'+thumb(src,'问题截图 '+(i+1))+'<button type="button" data-remove-image="'+i+'" class="btn btn-sm">移除</button></div>').join('');hydrateImages(node);}
      if(kind==='devBug'){
        imagePreview();body.querySelector('#gd-bug-previews').onclick=function(e){const b=e.target.closest('[data-remove-image]');if(b&&!loading){images.splice(+b.dataset.removeImage,1);imagePreview();persistDraft();}};
        body.querySelector('#gd-bug-files').onchange=async function(e){
          const fileInput=e.target,files=Array.from(fileInput.files);if(!files.length)return;
          if(images.length+files.length>2||files.some(f=>!/^image\/(png|jpeg|webp|gif)$/.test(f.type)||f.size>1024*1024)){App.toast('最多 2 张 PNG/JPEG/WebP/GIF 截图，每张不超过 1 MB');fileInput.value='';return;}
          loading=true;body.querySelector('#gd-editor-save').disabled=true;
          try{const result=await Promise.all(files.map(uploadImage));images=images.concat(result);imagePreview();persistDraft();}
          catch(err){App.toast(err.message,7000);}finally{loading=false;const saveButton=body.querySelector('#gd-editor-save');if(saveButton)saveButton.disabled=false;fileInput.value='';}
        };
      }
      form.onsubmit=function(e){
        e.preventDefault();if(loading)return;
        const payload={};form.querySelectorAll('[name]').forEach(el=>{if(el.name.indexOf('check-')!==0)payload[el.name]=el.value.trim();});
        if(kind!=='devProject')payload.projectId=r.projectId || p.id;
        if(kind==='devTask')payload.prog=(payload.prog===''||payload.prog==null)?0:Math.max(0,Math.min(100,Number(payload.prog)));
        if(kind==='devLog'&&!payload.done&&!payload.blockers&&!payload.next){App.toast('至少填写一项进展、阻碍或下一步');return;}
        if(kind==='devBug')payload.images=images;
        try{if(id){Object.keys(payload).forEach(k=>{if(equal(payload[k],r[k])||(typeof payload[k]==='string'&&!payload[k]&&!r[k]))delete payload[k];});const current=D.devAll(kind).find(x=>x.id===id);if(current)Object.entries(payload).forEach(([field,mine])=>{if(!equal(current[field],r[field])&&!equal(current[field],mine)){const key=D.KEYS[kind]+'|'+id+'|'+field;if(!CONFLICTS.some(c=>c.key===key))CONFLICTS.push({key,kind:D.KEYS[kind],id,field,mine,theirs:current[field],by:current.updatedBy,title:current.title||current.name||id});}});}
        const saved=D.devSave(kind,payload,id);EDIT_DIRTY=false;delete localDrafts[draftKey];try{saveDrafts();}catch(e){toast('记录已保存，草稿清理失败','warn');}releaseLock();modalOptions=null;if(kind==='devProject'){self._project=saved.id;self.resetFilters();}App.closeModal();self.repaint();App.toast(id?'修改已保存':'记录已创建');}
        catch(err){App.toast(err.message,8000);}
      };
      const first=form.querySelector('input,textarea,select');if(first)first.focus({preventScroll:true});
    }};
    App.openModal(modalOpt);
  }
};



  function render(){
    if(!root)return;
    closeMention();
    closeMenu();
    migrateMemberNames();
    applyCloudMemberNames();
    if(MODE==='legacy'){if(GameDev._clock)clearInterval(GameDev._clock);renderLegacy();return;}
    root.querySelector('.t-root').dataset.th=curTheme();
    const surf=root.querySelector('.surface'),active=root.activeElement,search=active?.id==='gd-search',pos=active?.selectionStart;
    surf.innerHTML='<div class="top"><div class="brand">🎮 UE 团队开发 <small>'+VERSION+'</small></div><div class="spacer"></div><div class="topset" id="devTopSet"><button class="gb gb-set" id="devSetToggle" aria-expanded="false">⚙️ 设置 <span class="cs">▾</span></button><div class="topset-panel"><label>提醒语气 <select id="devTone"><option value="soft" '+(CONFIG.tone==='soft'?'selected':'')+'>柔和 · 只陈述事实</option><option value="standard" '+(CONFIG.tone==='standard'?'selected':'')+'>标准 · 报剩几天</option><option value="strict" '+(CONFIG.tone==='strict'?'selected':'')+'>严格 · 逾期标红</option></select></label><label>我是谁 <select id="devMe">'+Object.entries(ROLE).map(([k,r])=>'<option value="'+esc(k)+'" '+(k===CONFIG.me?'selected':'')+'>'+esc(r.n)+'</option>').join('')+'</select></label><button class="gb" id="legacyMode">旧看板 · '+DATA.length+'</button><button class="gb" id="devTrash">回收站</button><button class="gb" id="devLogHistory">团队历史</button><button class="gb" id="devSync">同步设置</button><p class="topset-note">只设一次，之后本机记住 —— 所以默认收起。</p></div></div><button class="syncdot" id="devMentions" title="@我的提醒">🔔<span class="stxt"></span></button><button class="syncdot" id="devPull"><i></i><span class="stxt"></span></button></div>'+conflictBanner()+'<div class="gd-root">'+GameDev.body()+'</div>';
    GameDev._box=surf.querySelector('.gd-root');GameDev.bind(GameDev._box);hydrateImages();
    root.querySelector('#legacyMode').onclick=()=>{MODE='legacy';render();};root.querySelector('#devTrash').onclick=showDevTrash;root.querySelector('#devLogHistory').onclick=showReplay;root.querySelector('#devSync').onclick=showSyncPanel;root.querySelector('#devPull').onclick=()=>pull();root.querySelector('#devMentions').onclick=showMentions;updateBell();
    const setBox=root.querySelector('#devTopSet'),setBtn=root.querySelector('#devSetToggle');
    if(setBtn)setBtn.onclick=e=>{e.stopPropagation();const on=setBox.classList.toggle('open');setBtn.setAttribute('aria-expanded',on?'true':'false');};
    if(setBox)surf.querySelector('.top').addEventListener('click',e=>{if(!e.target.closest('#devTopSet')){setBox.classList.remove('open');setBtn&&setBtn.setAttribute('aria-expanded','false');}});
    root.querySelector('#devTone').onchange=e=>{CONFIG.tone=e.target.value;try{localStorage.setItem(SYNC_PREFIX+'tone',CONFIG.tone);}catch(err){}render();};
    root.querySelector('#devMe').onchange=e=>{CONFIG.me=e.target.value;try{localStorage.setItem(SYNC_PREFIX+'me',CONFIG.me);}catch(e){}render();};root.querySelector('#resolveDev')?.addEventListener('click',resolveConflict);
    setDot(...syncStatus);if(search){const el=root.querySelector('#gd-search');el.focus();el.setSelectionRange(pos,pos);}
    try{localStorage.setItem(SYNC_PREFIX+'prefs',JSON.stringify({project:GameDev._project,tab:GameDev._tab,member:GameDev._member}));}catch(e){}
  }
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
    const activeTrash=TRASH.filter(r=>!RETIRED_DEV_KEYS.includes(r.kind)).map(r=>({...r,draft:null}));
    const activeDeleted=Object.fromEntries(Object.entries(DELETED).filter(([k])=>!RETIRED_DEV_KEYS.some(x=>k.startsWith(x+'|'))));
    return { ...EXTRA, DATA:DATA.map(r=>({...r,draft:null})), TRASH:activeTrash, LOG, DISCUSS, COLUMNS, ...DEV, DELETED:activeDeleted, _schema:2, _ts:now(), _by:CONFIG.me, _v:VERSION };
  }
  function saveLocal(s) {
    const state=s||collectLocal();
    try {localStorage.setItem(SYNC_PREFIX+'data',JSON.stringify({...state,_localConflicts:CONFLICTS}));SAVED=clone(state);}catch(e){throw Error('本机保存失败，请保留编辑内容并检查存储空间');}
  }
  function loadLocal() {
    try { const s = JSON.parse(localStorage.getItem(SYNC_PREFIX + 'data') || 'null'); return (s && s.DATA) ? s : null; } catch (e) { return null; }
  }
  function applyState(s) {
    if (!s) return;
    EXTRA=Object.fromEntries(Object.entries(s).filter(([k])=>!['DATA','TRASH','LOG','DISCUSS','COLUMNS','DELETED','_localConflicts',...Object.values(DEV_KEYS),...RETIRED_DEV_KEYS,'_ts','_by','_v','_schema'].includes(k)));
    Object.values(DEV_KEYS).forEach(k=>{DEV[k]=Array.isArray(s[k])?clone(s[k]):[];});
    DEV.devTasks.forEach(t=>{if(Object.hasOwn(t,'milestoneId')){delete t.milestoneId;if(t._fields)delete t._fields.milestoneId;}});
    DELETED=Object.fromEntries(Object.entries(s.DELETED||{}).filter(([k])=>!RETIRED_DEV_KEYS.some(x=>k.startsWith(x+'|'))));
    monotonic=sharedKeys.reduce((max,k)=>(s[k]||[]).reduce((n,r)=>Math.max(n,r.updatedAt||0,...Object.values(r._fields||{}).map(f=>f.t||0)),max),monotonic);
    monotonic=Object.values(DELETED).reduce((n,t)=>Math.max(n,t.at||0),monotonic);
    if (s.DATA) DATA = clone(s.DATA);
    if (s.TRASH) TRASH = s.TRASH.filter(r=>!RETIRED_DEV_KEYS.includes(r.kind));
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
    [...(a || []), ...(b || [])].sort((x, y) => (y.t || y.deletedAt || 0) - (x.t || x.deletedAt || 0)).forEach(i => {
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
  function computeMerge(local,remote) {return mergeShared(local,remote);}

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
    let data=j.content?b64dec(j.content):null;
    if(!data&&j.sha){const raw=await fetch(url,{headers:{Authorization:'token '+ch.token,Accept:'application/vnd.github.raw+json'},cache:'no-store'});if(!raw.ok)throw Error('GET '+raw.status);data=await raw.json();}
    if(data){
      const invalid=Object.values(DEV_KEYS).some(k=>{
        if(!data[k])return false;
        if(!Array.isArray(data[k]))return true;
        return data[k].some(r=>!r||typeof r.id!=='string'||(k==='devLogs'&&typeof r.date!=='string'));
      });
      if((data._schema||1)>2||!Array.isArray(data.DATA)||invalid)throw Error('云端结构无效，已停止写入');
    }
    return {sha:j.sha,data};
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
      applyState(merged);cacheBase(cur.data);saveLocal();
      if(CONFLICTS.length)throw Error('字段冲突待处理');validateShared();
      return ghPut(merged,cur.sha,retries-1);
    }
    if (!res.ok) throw new Error('PUT ' + res.status);
    const result=await res.json();cacheBase(payload);return result;
  }

  function setDot(state, txt) {
    syncStatus=[state,txt];
    if (!root) return;
    const dot = root.querySelector('#devPull'); if (!dot) return;   // v2.4.3：精准指向同步灯（.syncdot 第一个已是 🔔）
    const i = dot.querySelector('i');
    if (i) i.style.background = state === 'ok' ? '#10b981' : state === 'busy' ? '#f59e0b' : state === 'err' ? '#ef4444' : '#888';
    const t = dot.querySelector('.stxt'); if (t) t.textContent = txt;
  }

  async function doSyncChannel(channel) {
    const ch = CONFIG.channel;
    if (channel !== 'github' || ch.type === 'local') return;
    if (!ch.token) { setDot('err', '未配 token · 仅本地'); return; }
    if(CONFLICTS.length){setDot('err','字段冲突待处理');render();return;}
    if(curCard||root?.querySelector('.modal.show form')){pendingPush=true;return;}
    if (syncing) { pendingPush = true; return; }
    syncing = true; setDot('busy', '同步中…');
    try {
      const cur = await ghGet();
      const merged = computeMerge(collectLocal(), cur.data);
      applyState(merged);cacheBase(cur.data);saveLocal();
      if(CONFLICTS.length)throw Error('字段冲突待处理');validateShared();
      await ghPut(merged, cur.sha, 3);
      saveLocal(); render();
      setDot('ok', '已同步 · ' + fmtT(now()));
      emit('push', { count:totalRecords() });
    } catch (e) {
      render();setDot('err',CONFLICTS.length?'字段冲突待处理':String(e.message).includes('前置')?'依赖冲突 · 请编辑任务修正':'同步失败 · 保留本机');
      emit('push-error', { error: String(e) });
    } finally {
      syncing = false;
      if(pendingPush&&!CONFLICTS.length){pendingPush=false;scheduleSync();}
    }
  }
  /* 800ms 节流：拖拽/连续编辑只推一次 */
  function scheduleSync() {
    if (CONFIG.channel.type === 'local') return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => doSyncChannel('github'), 800);
  }
  /* 每次本地变更都调它：落盘 + 节流上云 */
  function save() {const s=stampAll(collectLocal());applyState(s);saveLocal(s);if(!CONFLICTS.length)scheduleSync();}

  async function pull(silent) {
    const ch=CONFIG.channel;
    if(ch.type==='local'){setDot('warn','本地模式 · 未接云端');return;}
    if(!ch.token){setDot('warn','未配 token · 仅本地');return;}
    if(syncing||curCard||root?.querySelector('.modal.show form'))return;
    syncing=true;if(!silent)setDot('busy','拉取中…');
    try{
      const cur=await ghGet();
      if(!cur.data){setDot('warn','未找到数据库 · 检查仓库或权限');return;}
      const merged=computeMerge(collectLocal(),cur.data);applyState(merged);cacheBase(cur.data);saveLocal();render();updateBell();pingMentions();
      setDot(CONFLICTS.length?'err':'ok',CONFLICTS.length?'字段冲突待处理':'已同步 · '+fmtT(now()));emit('pull',{count:totalRecords()});
    }catch(e){setDot('err','拉取失败 · 保留本机');emit('pull-error',{error:String(e)});}
    finally{syncing=false;if(pendingPush&&!CONFLICTS.length){pendingPush=false;scheduleSync();}}
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
  function undo() { if(syncing||CONFIG.channel.type==='github'){toast('共享模式请用编辑或回收站恢复，避免覆盖同事的新修改','warn');return;}if (!UNDO.length) return; REDO.push(JSON.stringify({ DATA, TRASH, LOG, DISCUSS, COLUMNS })); applySnap(UNDO.pop()); log('undo', null, '撤销'); save(); render(); toast('已撤销'); }
  function redo() { if(syncing||CONFIG.channel.type==='github'){toast('共享模式请用编辑或回收站恢复','warn');return;}if (!REDO.length) return; UNDO.push(JSON.stringify({ DATA, TRASH, LOG, DISCUSS, COLUMNS })); applySnap(REDO.pop()); log('redo', null, '重做'); save(); render(); toast('已重做'); }
  function updateUndoBtns() {
    if (!root) return;
    const u = root.querySelector('.undoBtn'), r = root.querySelector('.redoBtn');
    if(u)u.disabled=CONFIG.channel.type==='github'||!UNDO.length;
    if(r)r.disabled=CONFIG.channel.type==='github'||!REDO.length;
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
  #devMentions.has-unread{color:#f59e0b;border-color:#f59e0b;font-weight:600}
  .ment-list{display:flex;flex-direction:column;gap:10px;max-height:52vh;overflow:auto}
  .ment-i{border:1px solid var(--card-border);border-radius:10px;padding:10px 12px;background:var(--card-bg-2)}
  .ment-i p{margin:0 0 6px;font-size:12px;line-height:1.7}
  .ment-i .tm{color:var(--muted);font-size:11px}
  .ment-x{white-space:pre-wrap;color:var(--ink);background:var(--surface-3);border-radius:8px;padding:7px 10px}
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
  .dscrim{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:4;opacity:0;pointer-events:none;transition:opacity .22s}
  .dscrim.show{opacity:1;pointer-events:auto}
  .drawer{position:fixed;left:50%;top:50%;width:min(940px,96%);max-height:90%;background:var(--card-bg);border:1px solid var(--card-border);border-radius:14px;z-index:5;transform:translate(-50%,-50%) scale(.97);opacity:0;pointer-events:none;transition:transform .22s ease,opacity .22s ease;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,.34)}
  .drawer.show{transform:translate(-50%,-50%) scale(1);opacity:1;pointer-events:auto}
  .dhd{padding:12px 16px;border-bottom:1px solid var(--card-border);display:flex;align-items:center;gap:9px;font-weight:700}
  .dbd{padding:14px 16px;overflow-y:auto;flex:1}
  .noteArea{min-height:220px;line-height:1.7}
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
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:30;display:none;align-items:center;justify-content:center;padding:20px}
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
  .gd-root { width:100%;min-width:0;container:gamedev / inline-size; }
.gd-root svg,.gd-form svg { width:18px;height:18px;flex:none; }
.gd-heading { display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 10px; }
.gd-proj-meta { display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto;flex-wrap:wrap; }
.gd-proj-meta h3 { font-size:16px;font-weight:650;margin:0;overflow-wrap:anywhere; }
.gd-proj-line { color:var(--muted);font-size:12px;white-space:nowrap; }
.gd-noproj { color:var(--muted);font-size:13px; }
.gd-heading p,.gd-timer p { font-size:13px;color:var(--muted);line-height:1.8;margin:0; }
.gd-eyebrow { font-size:11px;letter-spacing:.08em;color:var(--brand-ink);font-weight:600; }
.gd-heading .btn,.gd-project-bar .btn,.gd-toolbar .btn { display:inline-flex;gap:6px;align-items:center;white-space:nowrap; }
.gd-project-bar { display:flex;align-items:center;gap:8px;margin:0;flex:none; }
.gd-project-bar select { flex:0 1 200px;min-width:120px;max-width:240px; }
.gd-project-card { border:1px solid var(--line);border-radius:14px;background:linear-gradient(110deg,var(--surface),var(--brand-soft));padding:12px 14px;margin-bottom:12px; }
.gd-card-head { display:flex;align-items:flex-start;justify-content:space-between;gap:12px; }
.gd-project-desc { color:var(--muted);line-height:1.7;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 10px;max-width:100ch; }
.gd-kpis { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;margin-top:20px;border-top:1px solid var(--line);padding-top:18px; }
.gd-kpi span { display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px; }
.gd-kpi strong { display:block;font-size:25px;font-weight:650;font-variant-numeric:tabular-nums;margin-top:7px; }
.gd-tabs { display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:18px; }
.gd-tab { display:flex;align-items:center;gap:7px;padding:10px 12px;border-radius:11px;background:transparent;border:1px solid transparent;font-size:13px;color:var(--muted);cursor:pointer; }
.gd-tab.on { color:var(--brand-ink);border-color:var(--brand);background:var(--brand-soft);font-weight:600; }
.gd-tab:not(.on):hover { background:var(--surface-2); }
.gd-tab small { background:var(--surface-3);border-radius:6px;padding:1px 5px;font-size:10px; }
.gd-toolbar { display:flex;gap:10px;align-items:center;margin-bottom:18px; }
.gd-search { position:relative;flex:1;min-width:0; }
.gd-search > span { position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--muted);display:flex; }
.gd-search .input { width:100%;padding-left:38px; }
.gd-toolbar > select { width:150px;flex:none; }
.gd-card-grid { display:grid;grid-template-columns:minmax(0,1fr);gap:16px; }
.gd-card { background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:20px;min-width:0; }
.gd-card h3 { font-size:17px;font-weight:600;line-height:1.6;margin:12px 0;overflow-wrap:anywhere; }
.gd-meta { display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--muted);line-height:1.8;overflow-wrap:anywhere; }
.gd-badge { display:inline-flex;padding:2px 8px;border-radius:6px;background:var(--surface-2);color:var(--muted);font-size:11px;white-space:nowrap; }
.gd-badge--active,.gd-badge--doing,.gd-badge--fixing { background:var(--brand-soft);color:var(--brand-ink); }
.gd-badge--done,.gd-badge--closed,.gd-badge--released { color:var(--ok); }
.gd-badge--high,.gd-badge--critical { color:var(--danger); }
.gd-badge--review,.gd-badge--verify,.gd-badge--mid { color:var(--accent); }
.gd-due { color:var(--muted);font-size:11px;line-height:1.8; }
.gd-due.is-overdue,.gd-dependency.is-blocked { color:var(--danger); }
.gd-detail { margin:12px 0; }
.gd-detail > span { color:var(--muted);font-size:11px; }
.gd-detail p { color:var(--ink);font-size:13px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0 0; }
.gd-progress { height:5px;border-radius:8px;background:var(--surface-3);overflow:hidden;margin:14px 0 8px; }
.gd-progress i { display:block;height:100%;background:var(--brand);border-radius:inherit; }
.gd-actions { display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:12px;margin-top:16px; }
.gd-actions [data-gd-delete] { color:var(--muted); }
.gd-actions [data-gd-delete]:hover { color:var(--danger); }
.gd-board { display:grid;grid-template-columns:minmax(0,1fr);gap:14px;align-items:start; }
.gd-column { border-radius:16px;border:1px solid var(--line);background:var(--surface-2);padding:12px;min-width:0; }
.gd-column-title { display:flex;align-items:center;justify-content:space-between;padding:4px 3px 12px;color:var(--muted);font-size:12px; }
.gd-column-title h3 { font-size:13px;font-weight:600;color:var(--ink);margin:0; }
.gd-task { position:relative;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:10px; }
.gd-task.is-locked { background:repeating-linear-gradient(135deg,var(--surface),var(--surface) 9px,rgba(139,92,246,.12) 9px,rgba(139,92,246,.12) 18px);border-color:rgba(139,92,246,.55); }
.gd-editing-pill { position:absolute;top:-9px;right:10px;display:inline-flex;align-items:center;gap:5px;background:#8b5cf6;color:#fff;font-size:10px;font-weight:600;border-radius:999px;padding:2px 9px;box-shadow:0 2px 8px rgba(0,0,0,.28);z-index:2;white-space:nowrap; }
.gd-editing-pill i { width:6px;height:6px;border-radius:50%;background:#fff;animation:gdPulse 1.2s infinite; }
@keyframes gdPulse { 50% { opacity:.3; } }
.gd-task:last-child { margin-bottom:0; }
.gd-task-head { display:flex;align-items:flex-start;justify-content:space-between;gap:8px; }
.gd-task-head h4 { font-size:13.5px;line-height:1.5;font-weight:600;overflow-wrap:anywhere;margin:0; }
.gd-task-head .gd-badge { flex:none; }
.gd-task-meta { display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-top:9px; }
.gd-task .btn-sm { font-size:11px;padding-inline:8px; }
.gd-coldot { width:8px;height:8px;border-radius:2.5px;display:inline-block;margin-right:6px;flex:none; }
.gd-dependency { font-size:11px;color:var(--muted);line-height:1.8;margin-top:8px;overflow-wrap:anywhere; }
.gd-column-empty { text-align:center;padding:24px 8px;color:var(--muted);font-size:12px; }
.gd-expand { margin:12px 0;font-size:12px; }
.gd-expand summary { color:var(--brand-ink);cursor:pointer; }
.gd-empty { padding:50px 20px;text-align:center;border:1px dashed var(--line);border-radius:18px;background:var(--surface); }
.gd-empty h3 { font-size:16px;font-weight:600;margin:10px 0; }
.gd-empty p { color:var(--muted);font-size:13px;line-height:1.9;margin:8px 0 20px; }
.gd-empty-icon { display:inline-flex;padding:18px;border-radius:18px;color:var(--brand-ink);background:var(--brand-soft); }
.gd-empty-icon svg { width:32px;height:32px; }
.gd-log-list,.gd-time-list { display:grid;gap:14px; }
.gd-log { display:flex;gap:28px; }
.gd-log-date { display:flex;flex-direction:column;gap:6px;flex:none;font-size:14px; }
.gd-log-date span { color:var(--muted);font-size:12px; }
.gd-log-body { flex:1;min-width:0; }
.gd-log-body .gd-detail:first-child { margin-top:0; }
.gd-timer { padding:22px;border:1px solid var(--line);border-radius:16px;background:var(--surface); }
.gd-timer h3 { font-size:17px;margin:0 0 6px; }
.gd-timer > div > .btn { margin-top:16px; }
.gd-timer small { display:block;font-size:11px;line-height:1.9;color:var(--muted);margin-top:16px; }
.gd-timer-active { display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap; }
.gd-timer-active + .gd-timer-active { border-top:1px solid var(--line);padding-top:16px;margin-top:16px; }
.gd-timer-buttons { display:flex;gap:8px;align-items:center;flex-wrap:wrap; }
.gd-timer-active strong { display:block;font-size:36px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:.03em;margin:8px 0; }
.gd-time-stats { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:16px 0; }
.gd-running-notice { display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;margin-bottom:16px;border:1px solid var(--line);border-radius:12px;background:var(--brand-soft);color:var(--brand-ink);font-size:12px; }
.gd-running-notice .btn { flex:none; }
.gd-time-stats > div { background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px; }
.gd-time-stats span { color:var(--muted);font-size:12px; }
.gd-time-stats strong { display:block;font-size:24px;font-weight:600;margin-top:8px; }
.gd-time-bars { border:1px solid var(--line);border-radius:14px;background:var(--surface);padding:18px;margin-bottom:16px; }
.gd-time-bars > div { display:flex;gap:14px;align-items:center;font-size:12px; }
.gd-time-bars span { width:60px;flex:none; }
.gd-time-bars .gd-progress { flex:1;margin:10px 0; }
.gd-time-bars strong { width:75px;text-align:right;font-weight:500; }
.gd-time-row { display:flex;align-items:center;gap:16px;border:1px solid var(--line);border-radius:12px;padding:16px;background:var(--surface);font-size:13px; }
.gd-time-row > div:first-child { display:flex;flex-direction:column;gap:4px;flex:none; }
.gd-time-row span { color:var(--muted);font-size:11px; }
.gd-time-row p { flex:1;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap; }
.gd-time-row > strong { white-space:nowrap; }
.gd-time-row .gd-actions { border:0;padding:0;margin:0;flex:none; }
.gd-checks { display:flex;gap:8px;flex-wrap:wrap;margin:16px 0; }
.gd-checks label { display:flex;gap:6px;align-items:center;border:1px solid var(--line);background:var(--surface-2);border-radius:7px;padding:6px 8px;font-size:11px;cursor:pointer; }
.gd-checks input { accent-color:var(--brand);width:14px;height:14px; }
.gd-form { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px; }
.gd-field { display:flex;flex-direction:column;gap:8px;font-size:12px;min-width:0; }
.gd-field > span { color:var(--muted);font-weight:500; }
.gd-field .input { width:100%;min-width:0; }
.gd-field textarea { min-height:90px;resize:vertical; }
.gd-full { grid-column:1/-1; }
.gd-form-actions { display:flex;justify-content:flex-end;gap:10px;margin-top:8px; }
.gd-note { color:var(--muted);font-size:11px;line-height:1.9; }
.gd-field textarea { min-height:132px;resize:vertical; }
/* ---- 项目资源区 ---- */
.gd-res { margin-top:12px; border-top:1px solid var(--card-border); padding-top:11px; }
.gd-res-head { display:flex;align-items:center;gap:8px;width:100%;margin:0 0 8px; }
.gd-res-t { font-size:12.5px;font-weight:600; }
.gd-res-head small { color:var(--muted);font-size:10.5px;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.gd-res-acts { margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex:none; }
.gd-res-edit { font-size:11px; }
.gd-res-fold { border:1px solid var(--card-border);background:var(--card-bg);color:var(--muted);border-radius:8px;font-size:10.5px;padding:3px 9px;cursor:pointer;white-space:nowrap;font-family:inherit; }
.gd-res-fold:hover { color:var(--accent);border-color:var(--accent); }
.gd-res-body.folded { display:none; }
.gd-res-grid { display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px; }
.gd-res-i { display:flex;align-items:center;gap:9px;background:var(--card-bg-2);border:1px solid var(--card-border);border-radius:10px;padding:7px 10px;min-width:0; }
.gd-res-ic { width:26px;height:26px;border-radius:8px;background:var(--soft,rgba(102,126,234,.12));display:grid;place-items:center;font-size:13px;flex:0 0 auto; }
.gd-res-tx { min-width:0;display:flex;flex-direction:column; }
.gd-res-tx b { font-size:10.5px;font-weight:500;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
.gd-res-vl { font-style:normal;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;min-width:0;max-width:100%; }
a.gd-a { color:var(--accent);text-decoration:none; }
a.gd-a:hover { text-decoration:underline; }
.gd-res-copyicon { flex:0 0 auto;border:1px solid var(--card-border);background:var(--card-bg);color:var(--muted);border-radius:8px;width:24px;height:24px;display:grid;place-items:center;font-size:11px;cursor:pointer;padding:0;font-family:inherit; }
.gd-res-copyicon:hover { color:var(--accent);border-color:var(--accent); }
a.gd-res-open,button.gd-res-open { flex:0 0 auto;border:1px solid var(--card-border);background:var(--card-bg);color:var(--accent);border-radius:8px;font-size:10.5px;padding:4px 9px;cursor:pointer;text-decoration:none;white-space:nowrap;font-family:inherit; }
a.gd-res-open:hover,button.gd-res-open:hover { border-color:var(--accent);text-decoration:none; }
.gd-res-notes a, .gd-res-notice a { color:var(--accent);text-decoration:none; }
.gd-res-notes a:hover, .gd-res-notice a:hover { text-decoration:underline; }
.gd-res-empty { display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid var(--card-border);padding-top:11px;margin-top:12px; }
.gd-res-empty .gd-res-h { font-size:12px;font-weight:600; }
.gd-res-empty .gd-res-hint { font-size:11.5px;color:var(--muted);line-height:1.7; }
.gd-res-notes { margin-top:9px;border-left:3px solid #f59e0b;background:rgba(245,158,11,.09);border-radius:0 8px 8px 0;padding:8px 12px;font-size:11.5px;line-height:1.75; }
.gd-res-notes b { color:#f59e0b;font-size:11px; }
.gd-res-notes ul { margin:3px 0 0;padding-left:16px; }
.gd-res-notice { margin-top:8px;border-left:3px solid var(--accent);background:var(--soft,rgba(102,126,234,.10));border-radius:0 8px 8px 0;padding:7px 12px;font-size:11.5px;line-height:1.7;display:flex;gap:8px; }
.gd-res-notice b { color:var(--accent);font-size:11px;flex:0 0 auto; }
/* ---- 卡片：阶段 / 软件 / 负责人 / 路径 ---- */
.gd-task-chips { display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin:2px 0 4px; }
.gd-chip { font-size:10px;color:var(--muted);border:1px solid var(--card-border);border-radius:5px;padding:1px 7px; }
.gd-soft { display:inline-flex;align-items:center;gap:4px;font-size:10px;border:1px dashed var(--card-border);border-radius:5px;padding:1px 7px 1px 3px;background:var(--card-bg-2); }
.gd-soft u { width:13px;height:13px;border-radius:3px;display:grid;place-items:center;font-size:8.5px;font-weight:700;text-decoration:none;background:var(--soft,rgba(102,126,234,.12)); }
.gd-owner { margin-left:auto;font-size:10.5px;color:var(--accent);background:none;border:0;border-bottom:1px dashed var(--card-border);cursor:pointer;padding:0 1px;font-family:inherit; }
.gd-owner:hover { border-bottom-color:var(--accent); }
.gd-pathrow { display:flex;align-items:center;gap:6px;min-width:0;margin-top:9px; }
.gd-pathlab { font-size:9.5px;color:var(--muted);border:1px solid var(--card-border);border-radius:4px;padding:0 4px;line-height:1.7;flex:none; }
.gd-path { flex:1;min-width:0;font-size:10.5px;color:var(--muted);font-family:ui-monospace,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--card-bg-2);border:1px solid var(--card-border);border-radius:6px;padding:2px 8px; }
.gd-owner-pick { display:flex;flex-wrap:wrap;gap:8px; }
/* ================= v2.3 顶部区：一行 KPI / 分区 / 流程阶段 / 软件 ================= */
.gd-kpibar { display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px;margin:0 0 12px;border-top:1px solid var(--line);padding-top:10px;font-size:12px;color:var(--muted);line-height:1.9; }
.gd-kpibar b { color:var(--ink);font-size:15px;font-weight:650;font-variant-numeric:tabular-nums;margin-right:4px; }
.gd-kpibar-sep { color:var(--line);font-style:normal; }
.gd-filterbar { display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 8px;font-size:12px; }
.gd-areaseg,.gd-softseg { display:inline-flex;align-items:center;gap:2px;flex-wrap:wrap; }
.gd-areaseg { border-right:1px solid var(--line);padding-right:10px; }
.gd-softseg em { font-style:normal;color:var(--muted);font-size:11px;margin-right:4px; }
.gd-areabtn,.gd-softbtn { font:inherit;font-size:12px;color:var(--muted);background:none;border:0;border-radius:7px;padding:4px 9px;cursor:pointer; }
.gd-areabtn:hover,.gd-softbtn:hover { background:var(--surface-2);color:var(--ink); }
.gd-areabtn.on,.gd-softbtn.on { color:var(--brand-ink);background:var(--brand-soft);font-weight:600; }
.gd-clearf { color:var(--accent);cursor:pointer;margin-left:auto;font-size:11.5px; }
.gd-clearf.gd-hide { visibility:hidden; }
.gd-rail { display:flex;align-items:center;flex-wrap:wrap;gap:2px 0;margin:0 0 16px;font-size:11px;color:var(--muted); }
.gd-railgrp { display:inline-flex;align-items:center;gap:2px; }
.gd-railgrp + .gd-railgrp { border-left:1px solid var(--line);margin-left:8px;padding-left:10px; }
.gd-railgrp > b { font-weight:500;color:var(--muted);font-size:10.5px;margin-right:5px; }
.gd-railarr { color:var(--line);margin:0 3px; }
.gd-step { display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:11px;color:var(--muted);background:none;border:0;padding:3px 6px;border-radius:6px;cursor:pointer;white-space:nowrap; }
.gd-step:hover { background:var(--surface-2);color:var(--ink); }
.gd-step.on { color:var(--brand-ink);background:var(--brand-soft);font-weight:600; }
.gd-step i { width:5px;height:5px;border-radius:50%;background:var(--line);flex:none; }
.gd-step.on i { background:var(--brand); }
.gd-step em { font-style:normal;color:var(--muted);font-size:10px; }
/* ---- 卡片 v2.3：负责人圆点 / 进度条 / 刚改过 ---- */
.gd-ownerline { justify-content:flex-start;gap:6px;margin-top:10px;align-items:center; }
.gd-owner { margin-left:0;display:inline-flex;align-items:center;gap:5px; }
.gd-owner b { font-weight:600; }
.gd-rdot { width:7px;height:7px;border-radius:50%;flex:none;display:inline-block; }
.gd-duewrap { display:inline-flex;align-items:center;gap:6px; }
.gd-fresh { margin-left:auto;color:var(--muted);font-size:10.5px;white-space:nowrap; }
.gd-progrow { display:flex;align-items:center;gap:8px;margin-top:10px; }
.gd-progrow .gd-progbar { flex:1;margin:0; }
.gd-progpct { font-size:10.5px;color:var(--muted);min-width:34px;text-align:right;font-variant-numeric:tabular-nums;flex:none; }
.gd-task-extra { font-size:10.5px;color:var(--muted);margin-top:7px;overflow-wrap:anywhere; }
.gd-task-foot { display:flex;align-items:center;gap:10px;margin-top:10px;padding-top:9px;border-top:1px dashed var(--card-border); }
.gd-disc-chip { background:none;border:0;color:var(--muted);font-size:11.5px;cursor:pointer;padding:0;font-family:inherit; }
.gd-disc-chip:hover { color:var(--accent); }
.gd-hist { background:none;border:1px solid var(--card-border);border-radius:7px;color:var(--muted);font-size:10.5px;padding:3px 8px;cursor:pointer;font-family:inherit;line-height:1.4; }
.gd-hist:hover { color:var(--accent);border-color:var(--accent); }
.gd-card-edit { margin-left:auto;background:none;border:1px solid var(--card-border);border-radius:7px;color:var(--muted);font-size:10.5px;padding:3px 9px;cursor:pointer;white-space:nowrap;font-family:inherit; }
.gd-card-edit:hover { color:var(--accent);border-color:var(--accent); }
/* ---- v2.4.0 任务编辑大弹窗（目标图四）---- */
.gd-form-task { grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:14px;align-items:start; }
.gd-ed-grid { display:contents; }
.gd-ed-col { display:flex;flex-direction:column;gap:14px;min-width:0; }
.gd-ed-col .gd-field.gd-full { grid-column:auto; }
.gd-ed-pair { display:grid;grid-template-columns:1fr 1fr;gap:10px; }
.gd-sliderfield input[type=range] { width:100%;accent-color:var(--brand);margin:6px 0 2px; }
.gd-slideval { color:var(--ink);font-variant-numeric:tabular-nums; }
.gd-chiprow { display:flex;flex-wrap:wrap;gap:8px; }
.gd-pick { border:1px solid var(--card-border);background:var(--card-bg);color:var(--muted);border-radius:999px;padding:5px 13px;font-size:11.5px;cursor:pointer;font-family:inherit;white-space:nowrap; }
.gd-pick:hover { color:var(--ink); }
.gd-pick.on { color:var(--accent);border-color:var(--accent);background:var(--soft,rgba(102,126,234,.12));font-weight:600; }
.gd-discfield .gd-note { margin:2px 0; }
.gd-disc-list { max-height:180px;overflow:auto;display:flex;flex-direction:column;gap:8px;border:1px solid var(--card-border);border-radius:8px;padding:8px 10px;background:var(--card-bg-2); }
.gd-disc-list p { margin:0;font-size:11.5px; }
.gd-disc-x { white-space:pre-wrap;color:var(--ink); }
.gd-disc-row { display:flex;gap:8px; }
.gd-disc-row .input { flex:1;min-width:0; }
.gd-ed-foot { justify-content:space-between; }
.gd-ed-foot-l { display:inline-flex;gap:8px; }
.btn-danger { color:var(--danger);border-color:var(--danger);background:none; }
.btn-danger:hover { background:var(--danger);color:#fff; }
.gd-charcount { margin-left:auto;color:var(--muted);font-weight:400;font-size:10.5px; }
.gd-progbar { height:5px;border-radius:8px;background:var(--surface-3);overflow:hidden;margin:8px 0 4px; }
.gd-progbar i { display:block;height:100%;background:var(--brand);border-radius:inherit; }
.gd-progtx { font-size:10.5px; }
.gd-due.is-today { color:#f59e0b; }
@media (max-width:700px){ .gd-clearf{margin-left:0;} }
/* ---- 拖动排序 ---- */
.gd-task[draggable="true"] { cursor:grab; }
.gd-task.gd-dragging { opacity:.45;border-style:dashed; }
.gd-column.over { border-color:var(--accent);background:var(--soft,rgba(102,126,234,.10)); }
.gd-project-list { display:grid;gap:10px;margin-bottom:20px; }
.gd-project-list > div { display:flex;gap:10px;align-items:center; }
.gd-project-list > div > .btn:first-child { flex:1;text-align:left;justify-content:flex-start;overflow-wrap:anywhere; }
.gd-screenshots { display:flex;gap:10px;flex-wrap:wrap;margin:14px 0; }
.gd-screenshots img { width:120px;height:80px;object-fit:cover;border:1px solid var(--line);border-radius:8px; }
.gd-screenshots > button { border:0;padding:0;background:transparent;cursor:pointer; }
.gd-screenshots > div { display:flex;flex-direction:column;gap:6px; }
.gd-image-full { display:block;max-width:100%;max-height:70vh;object-fit:contain;margin:auto; }
.gd-root button:focus-visible,.gd-root input:focus-visible,.gd-root select:focus-visible,.gd-form :focus-visible { outline:2px solid var(--brand);outline-offset:3px; }
@container gamedev (min-width:650px) {
  .gd-card-grid,.gd-board { grid-template-columns:repeat(2,minmax(0,1fr)); }
}
@container gamedev (min-width:1240px) {
  .gd-board { grid-template-columns:repeat(4,minmax(0,1fr)); }
  .gd-card-grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
}
@media (max-width:700px) {
  #view-root[data-view="gamedev"] { padding:12px; }
  .gd-heading { align-items:flex-start;gap:10px;flex-direction:column; }
  .gd-proj-meta { width:100%; }
  .gd-project-bar { flex-wrap:wrap;gap:8px;width:100%; }
  .gd-project-bar select { flex:1 1 140px;max-width:none; }
  .gd-project-card { padding:12px; }
  .gd-form-task { grid-template-columns:1fr; }
  .gd-ed-pair { grid-template-columns:1fr 1fr; }
  .gd-kpis { grid-template-columns:repeat(2,minmax(0,1fr));gap:14px; }
  .gd-kpi strong { font-size:22px; }
  .gd-tabs { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px; }
  .gd-tab { justify-content:center;padding:10px 6px;font-size:12px; }
  .gd-toolbar { flex-wrap:wrap; }
  .gd-search { flex-basis:100%; }
  .gd-toolbar > select { flex:1;width:auto;min-width:0; }
  .gd-toolbar > .btn { margin-left:auto; }
  .gd-card { padding:16px; }
  .gd-log { flex-direction:column;gap:16px; }
  .gd-log-date { flex-direction:row;align-items:center; }
  .gd-time-stats { gap:8px; }
  .gd-time-stats > div { padding:12px 8px; }
  .gd-time-stats strong { font-size:19px; }
  .gd-time-stats span { font-size:10px; }
  .gd-time-row { flex-wrap:wrap;gap:10px; }
  .gd-time-row p { flex-basis:100%;order:3;margin:0; }
  .gd-time-row .gd-actions { margin-left:auto; }
  .gd-form { grid-template-columns:minmax(0,1fr); }
}


  .t-root{--surface:var(--card-bg);--surface-2:var(--card-bg-2);--surface-3:var(--card-border);--line:var(--card-border);--ink:var(--text);--brand:var(--accent);--brand-ink:var(--accent);--brand-soft:color-mix(in srgb,var(--accent) 10%,var(--card-bg));--danger:#ef4444;--ok:#10b981}
  :host{font-family:'Source Han Sans SC','思源黑体','Noto Sans CJK SC','Noto Sans SC',sans-serif}
  .gd-root{padding:20px;width:100%;max-width:none}.input{padding:10px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink);font:inherit}
  button,input,textarea,select{font-family:inherit}button{touch-action:manipulation}button:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  .gd-root .btn,.gd-form .btn{font-size:12px;min-height:36px}.btn-primary{background:var(--accent);color:#fff;border-color:transparent}
  .gd-actions>.gd-meta{margin-right:auto}.modal .mbox{width:min(760px,calc(100vw - 24px));max-width:none;max-height:90vh}.modal .mbd{overflow:auto;max-height:70vh}.closeX{border:0;background:transparent;color:var(--text);display:inline-flex;align-items:center;justify-content:center;min-width:36px;min-height:36px}
  .top select{width:auto;max-width:150px;padding:5px}.top .syncdot{min-height:32px}.top .brand{white-space:normal}
  .gd-toolbar>select{width:auto;max-width:180px}.gd-project-bar select{max-width:none}.gd-project-desc{max-width:none}
  /* v2.4 顶部设置折叠：平时只有一行「⚙️ 设置 ▾」 */
  .topset{position:relative}
  .topset-panel{position:absolute;right:0;top:calc(100% + 6px);z-index:60;display:none;flex-direction:column;gap:6px;align-items:stretch;background:var(--card-bg);border:1px solid var(--card-border);border-radius:12px;padding:10px;min-width:210px;box-shadow:0 14px 40px rgba(0,0,0,.30)}
  .topset.open .topset-panel{display:flex}
  .topset-panel label{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);white-space:nowrap}
  .topset-panel .gb{text-align:left;justify-content:flex-start}
  .topset-note{margin:2px 0 0;font-size:10.5px;color:var(--muted);line-height:1.7}
  .topset .gb-set{white-space:nowrap}
  .topset .gb-set .cs{opacity:.65}
  .topset.open .gb-set .cs{display:inline-block;transform:rotate(180deg)}
  /* v2.3 编辑弹窗：居中加宽 + 任务说明大编辑区 */
  .modal.genericModal .mbox{width:min(1060px,calc(100vw - 24px));max-height:92vh}
  .modal.genericModal .mbd{max-height:none}
  .modal.genericModal .gd-field textarea{min-height:220px}
  @media(hover:hover) and (pointer:fine){.gd-card:hover,.gd-task:hover{transform:translateY(-2px);border-color:var(--accent)}}
  @media(max-width:700px){.gd-root{padding:12px}.gd-heading{flex-wrap:wrap}.modal .mbox{width:calc(100vw - 16px)}.drawer{width:calc(100vw - 12px);max-width:440px}.cols{grid-template-columns:1fr!important}.gd-toolbar>select{max-width:none}.gb,.btn{min-height:36px}.top .brand small{display:block}}
  /* ============================================================
     v2.5 任务看板重设计（对齐「合成版」预览：三视图 + 右栏 + 项目详情条）
     配色全部走 .t-root 主题令牌，所以 6 套主题自动跟随
     ============================================================ */
  .tk-wrap{display:grid;grid-template-columns:minmax(0,1fr) 262px;gap:12px;align-items:start;padding:11px 13px 13px}
  .tk-wrap.norail{grid-template-columns:minmax(0,1fr)}
  .tk-main{min-width:0}
  .tk-kpibar{display:flex;align-items:center;gap:13px;flex-wrap:wrap;padding:9px 13px;background:var(--card-bg);border-bottom:1px solid var(--card-border)}
  .tk-kpibar .it{display:flex;align-items:baseline;gap:5px;font-size:11.5px;color:var(--muted)}
  .tk-kpibar .it b{font-size:16px;font-weight:750;color:var(--text);font-variant-numeric:tabular-nums}
  .tk-kpibar .it.hot b{color:#ef4444}
  .tk-kpibar .it.warn b{color:#f5a524}
  .tk-kpibar .sep{width:1px;height:16px;background:var(--card-border)}
  .tk-kpibar .pw{flex:1 1 150px;min-width:110px;display:flex;align-items:center;gap:8px}
  .tk-kpibar .pw .pct{font-size:11px;color:var(--muted);white-space:nowrap}
  .tk-kpibar .lds{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
  .tk-kpibar .lds .ld{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted);white-space:nowrap}
  .tk-kpibar .lds .ld.over{color:#ef4444;font-weight:700}
  .tk-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 13px 0}
  .tk-seg{display:flex;gap:2px;background:var(--card-bg-2);border:1px solid var(--card-border);border-radius:9px;padding:2px}
  .tk-seg button{border:none;background:none;color:var(--muted);font:inherit;font-size:12.5px;padding:4px 12px;border-radius:7px;cursor:pointer;display:flex;align-items:center;gap:5px;font-family:inherit}
  .tk-seg button:hover{color:var(--text)}
  .tk-seg button.on{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:650}
  .tk-btn{padding:4px 10px;border-radius:8px;border:1px solid var(--card-border);background:var(--card-bg);color:var(--text);cursor:pointer;font-size:11.5px;font-family:inherit;line-height:1.4;display:inline-flex;align-items:center;gap:5px}
  .tk-btn:hover{border-color:var(--accent)}
  .tk-btn.on{border-color:var(--accent);color:var(--accent)}
  .tk-btn.pri{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent;color:#fff;font-weight:650}
  .tk-btn[disabled]{opacity:.45;cursor:not-allowed}
  .tk-srch{display:flex;align-items:center;gap:6px;background:var(--card-bg);border:1px solid var(--card-border);border-radius:8px;padding:3px 9px}
  .tk-srch input{border:none;background:none;color:var(--text);font:inherit;font-size:12px;outline:none;width:120px}
  /* 项目详情条 */
  .tk-proj{margin:0;background:var(--card-bg);border-bottom:1px solid var(--card-border)}
  .tk-proj-hd{display:flex;align-items:center;gap:9px;padding:8px 13px;font-size:12.5px;flex-wrap:wrap;cursor:pointer}
  .tk-proj-hd .sum{color:var(--muted);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}
  .tk-proj-hd .tri{color:var(--muted);font-size:11px;white-space:nowrap}
  .tk-pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px;padding:0 13px 11px}
  .tk-pf{background:var(--card-bg-2);border:1px solid var(--card-border);border-radius:9px;padding:7px 10px}
  .tk-pf i{display:block;font-style:normal;font-size:10px;color:var(--muted);margin-bottom:3px}
  .tk-pf b{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .tk-plink{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;border:1px solid var(--card-border);border-radius:7px;padding:2px 8px;cursor:pointer;background:var(--card-bg);color:var(--text);font-family:inherit}
  .tk-plink:hover{border-color:var(--accent);color:var(--accent)}
  /* v2.7.0（v3-17）：公告独立条 —— 底部渐变大字 footer，走主题令牌 6 套主题自动跟随 */
  .tk-ann{margin:2px 13px 12px;background:linear-gradient(90deg,color-mix(in srgb,var(--accent2,#8b5cf6) 20%,transparent),color-mix(in srgb,var(--accent2,#8b5cf6) 4%,transparent));border-left:3px solid var(--accent2,#8b5cf6);border-radius:0 9px 9px 0;padding:9px 13px}
  .tk-ann-t{font-size:10.5px;font-weight:800;letter-spacing:3px;color:var(--accent2,#8b5cf6);display:flex;align-items:center;gap:6px;margin-bottom:2px}
  .tk-ann-c{font-size:13px;font-weight:600;color:var(--text);line-height:1.6;word-break:break-all}
  .tk-ann-c a{color:var(--accent)}
  .gd-project-card .tk-ann{margin:10px 0 0}
  /* 卡片/零件 */
  .tk-card{background:var(--card-bg-2);border:1px solid var(--card-border);border-radius:10px;padding:8px 10px;transition:.14s;cursor:pointer;position:relative}
  .tk-card:hover{border-color:var(--accent)}
  .tk-card.sel{outline:2px solid var(--accent);outline-offset:1px}
  .tk-card.blocked{border-color:#ef444470;background:color-mix(in srgb,#ef4444 8%,var(--card-bg-2))}
  .tk-card.blocked:before{content:'';position:absolute;left:0;top:6px;bottom:6px;width:3px;border-radius:2px;background:#ef4444}
  .tk-pri{font-size:9.5px;font-weight:800;padding:1px 5px;border-radius:4px;flex:0 0 auto;background:var(--card-border);color:var(--muted)}
  /* v2.6.0：P0–P3 四级四色 —— 原来是「P2 灰底 / P3 灰描边」，肉眼几乎分不出（用户实测） */
  .tk-pri.P0{background:#ef4444;color:#fff;box-shadow:0 0 0 2px color-mix(in srgb,#ef4444 35%,transparent)}
  .tk-pri.P1{background:#f5a524;color:#1b1200}
  .tk-pri.P2{background:#3b82f6;color:#fff}
  .tk-pri.P3{background:transparent;color:var(--muted);border:1px solid var(--card-border)}
  .tk-card .tk-r1{display:flex;gap:5px;align-items:flex-start}
  .tk-card .tk-r1 .tt{flex:1 1 auto;min-width:0}
  .tk-card .tk-ico{display:flex;gap:1px;flex:0 0 auto;opacity:0;transition:opacity .15s}
  .tk-card:hover .tk-ico,.tk-card.sel .tk-ico{opacity:1}
  .tk-ib{border:none;background:none;color:var(--muted);cursor:pointer;font-size:10.5px;padding:0 3px;border-radius:4px;font-family:inherit;line-height:1.6}
  .tk-ib:hover{background:var(--card-border);color:var(--text)}
  .tk-ib b{font-weight:800;font-size:9px}
  .tk-card .tk-r2{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:10px;color:var(--muted);margin-top:5px}
  .tk-card .tk-r2 i{font-style:normal;opacity:.45}
  .tk-card .tk-sw{border:1px solid var(--card-border);border-radius:4px;padding:0 4px}
  .tk-card .tk-dim2{opacity:.5}
  .tk-card .tk-r3{display:flex;align-items:center;gap:7px;margin-top:6px}
  .tk-own{display:inline-flex;align-items:center;gap:5px;border:none;background:none;color:inherit;cursor:pointer;font-family:inherit;font-size:10.5px;padding:0}
  .tk-own b{color:var(--muted);font-weight:600}
  .tk-own:hover b{color:var(--accent)}
  .tk-card .tk-sp{flex:1 1 auto}
  .tk-mut2{color:var(--muted);opacity:.7;font-size:10px}
  .tk-nodue{font-size:10px;color:#f5a524;border:1px dashed #f5a52466;border-radius:4px;padding:0 5px;white-space:nowrap}
  .tk-card .tk-r4{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
  .tk-lk{font-size:9.5px;color:#ef4444;border:1px solid #ef444466;border-radius:4px;padding:0 5px}
  .tk-wait2{font-size:9.5px;color:#f5a524;border:1px dashed #f5a52455;border-radius:4px;padding:0 5px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tk-wait2.blocked{color:#ef4444;border-color:#ef444455}
  .tk-tag{font-size:9.5px;color:var(--muted);border:1px solid var(--card-border);border-radius:4px;padding:0 5px}
  .tk-card.locked{opacity:.65;background-image:repeating-linear-gradient(45deg,transparent 0 6px,color-mix(in srgb,var(--card-border) 45%,transparent) 6px 12px)}
  .tk-av{width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:#fff;flex:0 0 auto}
  .tk-st{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted);white-space:nowrap}
  .tk-st .d{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
  .tk-due{font-size:10.5px;font-weight:700;white-space:nowrap}
  .tk-due.over{color:#ef4444}.tk-due.soon{color:#f5a524}.tk-due.ok{color:var(--muted)}.tk-due.done{color:#10b981}
  /* v3-20 柔和档：不评判、不催，只报事实 */
  .tk-due.calm{color:var(--muted);font-weight:500}
  .tk-due.calm-today{color:var(--accent);font-weight:600}
  .tk-due.calm-over{color:#f5a524;font-weight:600}
  .tk-due.is-loud{background:color-mix(in srgb,#ef4444 14%,transparent);border-radius:4px;padding:0 4px}
  .tk-mut{color:var(--muted)}.tk-dim{color:var(--muted);opacity:.75}
  .tk-emptyst{color:var(--muted);font-size:12px;padding:12px;text-align:center;border:1px dashed var(--card-border);border-radius:9px}
  /* 视图 1 · 泳道 */
  .tk-lane{border:1px solid var(--card-border);border-radius:12px;overflow:hidden;margin-bottom:10px}
  .tk-lane-hd{display:flex;align-items:center;gap:9px;padding:7px 12px;font-size:12.5px;font-weight:700;background:var(--card-bg-2);border-left:4px solid var(--accent);cursor:pointer;flex-wrap:wrap}
  .tk-lane-hd .cnt{font-size:11px;color:var(--muted);font-weight:500}
  .tk-lane-hd .hint{font-size:11px;color:#f5a524;font-weight:500;margin-left:auto}
  .tk-lane-hd .tri{color:var(--muted);font-size:11px;font-weight:400}
  .tk-lane.min .tk-lane-bd{display:none}
  .tk-lane.min .tk-lane-hd .hint{display:none}
  .tk-minichips{display:none;gap:5px;align-items:center;margin-left:8px}
  .tk-lane.min .tk-minichips{display:flex}
  .tk-minichips span{font-size:10.5px;padding:0 6px;border-radius:4px;border:1px solid var(--card-border);color:var(--muted)}
  .tk-lane-bd{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:9px}
  .tk-cell{min-height:54px;border-radius:8px;background:var(--card-bg-2);border:1px solid var(--card-border);padding:6px;display:flex;flex-direction:column;gap:6px}
  .tk-cell .ct{font-size:10px;color:var(--muted);font-weight:700;letter-spacing:.04em;display:flex;align-items:center;gap:5px;opacity:.85}
  .tk-cell .ct .hot{margin-left:auto;color:#f5a524;font-weight:600;opacity:1}
  .tk-card .tt{font-size:12px;font-weight:600;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .tk-wait{display:inline-flex;align-items:center;gap:4px;font-size:10px;color:#f5a524;border:1px dashed #f5a52455;border-radius:5px;padding:0 5px;margin-top:4px}
  .tk-card[draggable="true"]{cursor:grab}
  .tk-card[draggable="true"]:active{cursor:grabbing}
  .tk-card.tk-dragging{opacity:.4;border-style:dashed}
  .tk-cell.over{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 45%,transparent)}
  .tk-meta{font-size:10.5px;color:var(--muted);opacity:.85;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* 视图 2 · 总表 */
  .tk-tw{overflow:auto;border:1px solid var(--card-border);border-radius:11px;max-height:calc(100vh - 300px)}
  .tk-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
  .tk-tbl th{position:sticky;top:0;z-index:3;background:var(--card-bg-2);text-align:left;font-size:10.5px;color:var(--muted);font-weight:700;padding:7px 9px;border-bottom:1px solid var(--card-border);cursor:pointer;white-space:nowrap;user-select:none}
  .tk-tbl th:hover{color:var(--accent)}
  .tk-tbl th.nos{cursor:default}.tk-tbl th.nos:hover{color:var(--muted)}
  .tk-tbl td{padding:6px 9px;border-bottom:1px solid var(--card-border);vertical-align:middle}
  .tk-tbl tr.r:hover td{background:color-mix(in srgb,var(--accent) 7%,transparent)}
  .tk-tbl tr.r{cursor:pointer}
  .tk-tbl tr.r.sel td{background:color-mix(in srgb,var(--accent) 15%,transparent)}
  .tk-tbl .tt{font-weight:600;max-width:270px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tk-tbl .num{color:var(--muted);font-variant-numeric:tabular-nums}
  .tk-tbl tr.hide{display:none}
  .tk-tbl td.frz,.tk-tbl th.frz{position:sticky;left:0;background:var(--card-bg);z-index:2;box-shadow:1px 0 0 var(--card-border)}
  .tk-tbl th.frz{z-index:4;background:var(--card-bg-2)}
  .tk-tbl tr.r.over td.frz{box-shadow:inset 3px 0 0 #ef4444,1px 0 0 var(--card-border)}
  .tk-tbl tr.r.soon td.frz{box-shadow:inset 3px 0 0 #f5a524,1px 0 0 var(--card-border)}
  .tk-tbl tr.grp td{background:var(--card-bg-2);font-weight:700;font-size:12px;cursor:pointer;border-bottom:1px solid var(--card-border)}
  .tk-tbl tr.grp .gc{color:var(--muted);font-weight:500}
  .tk-ie select,.tk-ie input{border:1px solid transparent;background:transparent;color:inherit;font:inherit;font-size:12.5px;padding:2px 4px;border-radius:5px;outline:none;cursor:pointer;width:100%;min-width:0;font-family:inherit}
  .tk-ie select:hover,.tk-ie input:hover{border-color:var(--card-border)}
  .tk-ie select:focus,.tk-ie input:focus{border-color:var(--accent);background:var(--card-bg-2);cursor:text}
  .tk-saved{font-size:10px;color:#10b981;margin-left:5px;opacity:0;transition:.3s}
  .tk-saved.on{opacity:1}
  .tk-den1 td{padding:3px 9px!important;font-size:11.5px}
  .tk-den2 td{padding:10px 9px!important}
  .tk-chk{width:15px;height:15px;accent-color:var(--accent);cursor:pointer}
  .tk-bat{position:sticky;bottom:0;margin-top:9px;display:flex;align-items:center;gap:8px;padding:8px 11px;border-radius:10px;background:var(--card-bg-2);border:1px solid var(--card-border);flex-wrap:wrap;transition:.18s}
  .tk-bat.live{border-color:var(--accent)}
  .tk-bat b{color:var(--accent);font-size:15px}
  .tk-bat select,.tk-bat input{background:var(--card-bg);border:1px solid var(--card-border);color:var(--text);border-radius:7px;padding:3px 7px;font:inherit;font-size:11.5px;outline:none;font-family:inherit;width:auto!important;max-width:190px;flex:0 0 auto}
  /* 视图 3 · 时间 */
  .tk-gt{width:100%;border-collapse:collapse;font-size:12.5px}
  .tk-gt th{position:sticky;top:0;z-index:3;background:var(--card-bg-2);text-align:left;font-size:10.5px;color:var(--muted);padding:7px 9px;border-bottom:1px solid var(--card-border);white-space:nowrap}
  .tk-gt td{border-bottom:1px solid var(--card-border);vertical-align:middle;padding:0}
  .tk-gt td.n{padding:7px 9px;cursor:pointer}
  .tk-gt td.n:hover{background:color-mix(in srgb,var(--accent) 7%,transparent)}
  .tk-track{position:relative;height:42px;background:repeating-linear-gradient(90deg,transparent 0 calc(100%/14 - 1px),var(--card-border) calc(100%/14 - 1px) calc(100%/14))}
  .tk-track .gb2{position:absolute;top:13px;height:16px;border-radius:5px;min-width:10px}
  .tk-track .gb2.over{background:#ef4444!important}
  .tk-track .tv{position:absolute;top:0;bottom:0;width:2px;background:var(--accent);z-index:2}
  .tk-track .tv:after{content:'今天';position:absolute;top:-1px;left:3px;font-size:9px;color:var(--accent);font-weight:700}
  .tk-gaxis{display:flex;margin-top:3px}
  .tk-gaxis span{flex:1 1 0;text-align:center;font-size:9.5px;color:var(--muted);opacity:.8}
  /* 右栏 */
  .tk-rail{position:sticky;top:8px;background:var(--card-bg);border:1px solid var(--card-border);border-radius:12px;padding:11px;max-height:calc(100vh - 140px);overflow:auto}
  .tk-rail h3{margin:0 0 9px;font-size:12.5px;display:flex;align-items:center;gap:7px}
  .tk-rail h3 .bx{margin-left:auto;font-size:10.5px;color:var(--muted);cursor:pointer;border:1px solid var(--card-border);border-radius:6px;padding:1px 6px;font-weight:500}
  .tk-rail h3 .bx:hover{border-color:var(--accent);color:var(--accent)}
  .tk-rrow{display:flex;align-items:center;gap:7px;padding:5px 7px;border-radius:8px;font-size:12px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
  .tk-rrow:hover{background:var(--card-bg-2)}
  /* v2.13.0 · 今日更新面板 */
  /* v2.14.0 · 卡片密度与列收纳 */
  .tk-cdseg button{padding:3px 7px;font-size:11px;line-height:1.6}
  .tk-ico .hoveronly{display:none}
  .tk-card:hover .tk-ico .hoveronly{display:inline-flex}
  @media (hover:none){.tk-ico .hoveronly{display:inline-flex}}
  .tk-more{width:100%;font-size:10.5px;color:var(--accent);background:none;border:1px dashed var(--card-border);border-radius:7px;padding:3px;cursor:pointer;font-family:inherit}
  .tk-more:hover{background:var(--card-bg)}
  .tk-cell{max-height:56vh;overflow-y:auto;overscroll-behavior:contain}
  .tk-cell .ct{position:sticky;top:0;z-index:2;background:var(--card-bg-2);padding-bottom:3px}
  .tk-card.tk-cd-tight .tt{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tk-r23{flex-wrap:nowrap;overflow:hidden;gap:5px}
  .tk-r23m{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .tk-r23m .tk-sw{font-size:9px;padding:0 3px}
  .tk-cico{font-size:10px;color:var(--muted);flex:0 0 auto}
  .tk-cbar{display:inline-block;width:20px;height:3px;border-radius:2px;background:var(--card-border);position:relative;overflow:hidden;flex:0 0 auto}
  .tk-cbar i{position:absolute;inset:0 auto 0 0;background:var(--accent);border-radius:2px}
  .tk-card.tk-cd-row{display:flex;align-items:center;gap:6px;padding:4px 7px}
  .tk-card.tk-cd-row .tk-r1{flex:1 1 auto;min-width:0;align-items:center}
  .tk-card.tk-cd-row .tt{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11.5px}
  .tk-card.tk-cd-row .tk-ico{display:none}
  .tk-card.tk-cd-row .tk-rowmeta{display:flex;align-items:center;gap:4px;flex:0 0 auto;font-size:10px;color:var(--muted)}
  .tk-card.tk-cd-row .tk-rowmeta em{font-style:normal}
  .tk-card.tk-cd-row .tk-nodue,.tk-card.tk-cd-row .tk-due{font-size:10px}
  .tk-card.tk-cd-row .tk-reply{display:none}
  .tk-ubadge{font-size:9.5px;padding:0 5px;border-radius:8px;background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent);font-weight:800;margin-left:5px;vertical-align:1px}
  .tk-ucnt{font-size:11px;color:var(--muted);line-height:1.6;margin-bottom:1px}
  .tk-ucnt b{color:var(--text)}
  .tk-ucnt b.hl{color:#f5a524}
  .tk-urow{position:relative;padding:6px 7px 6px 9px;border-radius:8px;cursor:pointer;border:1px solid transparent;margin-bottom:2px}
  .tk-urow:hover{background:var(--card-bg-2)}
  .tk-urow.unread::before{content:"";position:absolute;left:0;top:7px;bottom:7px;width:3px;border-radius:2px;background:var(--accent)}
  .tk-uhd{display:flex;align-items:center;gap:5px}
  .tk-utype{font-size:9px;padding:0 4px;border-radius:4px;border:1px solid;line-height:15px;flex:0 0 auto;white-space:nowrap}
  .tk-utt{font-size:12px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tk-un{font-size:9.5px;padding:0 4px;border-radius:7px;background:var(--card-bg-2);border:1px solid var(--card-border);color:var(--muted);flex:0 0 auto}
  .tk-umt{font-size:10px;color:var(--muted);margin-top:2px;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tk-utl{display:none;margin-top:5px;padding-top:5px;border-top:1px dashed var(--card-border)}
  .tk-urow.open .tk-utl{display:block}
  .tk-uli{font-size:10px;color:var(--muted);line-height:1.7}
  .tk-uli .tm{opacity:.7;margin-right:4px;font-variant-numeric:tabular-nums}
  .tk-uolder{margin-top:8px;border-top:1px solid var(--card-border);padding-top:6px}
  .tk-uolder summary{font-size:10.5px;color:var(--muted);cursor:pointer;list-style:none}
  .tk-uolder summary::-webkit-details-marker{display:none}
  .tk-uold{font-size:10.5px;color:var(--muted);padding:3px 2px;display:flex;gap:6px;cursor:pointer}
  .tk-uold:hover{color:var(--text)}
  .tk-uold span{margin-left:auto;opacity:.7}
  .tk-uact{display:flex;gap:5px;margin-top:9px;padding-top:8px;border-top:1px solid var(--card-border)}
  .tk-uact .tk-btn{font-size:10.5px;padding:3px 8px}
  .tk-uact .tk-uhelp{margin-left:auto;padding:3px 7px}
  .tk-dgm{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;z-index:9999;padding:16px}
  .tk-dg{width:360px;max-width:92vw;max-height:72vh;overflow:auto;border-radius:14px;padding:14px 15px;box-shadow:0 14px 40px rgba(0,0,0,.45);font-size:12px;line-height:1.6}
  .tk-dg[data-dg="dark"]{background:#1b1d27;color:#e8eaf2;border:1px solid #2c2f3d}
  .tk-dg[data-dg="light"]{background:#fff;color:#1b1e28;border:1px solid #e2e6f0}
  .tk-dgh{display:flex;align-items:baseline;gap:8px;padding-bottom:8px;margin-bottom:8px;border-bottom:1px solid rgba(128,128,128,.25)}
  .tk-dgh b{font-size:13.5px}
  .tk-dgh span{font-size:10.5px;opacity:.65;margin-left:auto}
  .tk-dgi{display:flex;gap:6px;font-size:11.5px;padding:3px 0;align-items:flex-start}
  .tk-dgi i{width:5px;height:5px;border-radius:50%;margin-top:6px;flex:0 0 auto;display:block}
  .tk-dgi b{font-weight:650}
  .tk-dgf{margin-top:9px;padding-top:7px;border-top:1px dashed rgba(128,128,128,.3);font-size:10px;opacity:.6}
  .tk-dgb{display:flex;gap:6px}
  .tk-rrow.over{background:color-mix(in srgb,#ef4444 8%,transparent);border-color:#ef444440}
  .tk-rrow.today{background:color-mix(in srgb,var(--accent) 10%,transparent);border-color:color-mix(in srgb,var(--accent) 35%,transparent)}
  .tk-rrow .t{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tk-rsec{font-size:10px;font-weight:800;color:var(--muted);letter-spacing:.05em;margin:10px 0 5px;opacity:.9}
  .tk-rsec:first-of-type{margin-top:0}
  .tk-det h4{margin:0 0 3px;font-size:14px;line-height:1.35}
  .tk-det .kv{display:grid;grid-template-columns:58px 1fr;gap:6px 9px;font-size:12px;margin-top:10px}
  .tk-det .kv i{font-style:normal;color:var(--muted)}
  .tk-projmini{background:var(--card-bg-2);border:1px solid var(--card-border);border-radius:9px;padding:8px 10px;font-size:12px}
  .tk-projmini .pn{font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .tk-projmini .pm{font-size:10.5px;color:var(--muted);line-height:1.7}
  .tk-msg{display:flex;gap:7px;margin-bottom:9px;font-size:12px}
  .tk-msg .b{background:var(--card-bg-2);border:1px solid var(--card-border);border-radius:9px;padding:6px 9px;flex:1 1 auto;min-width:0}
  .tk-rbtns{display:flex;gap:7px;margin-top:10px}
  .tk-rbtns .tk-btn{flex:1 1 auto;justify-content:center}
  /* 脏数据确认条（不替换原有页脚按钮，避免打断编辑器自身事件） */
  .tk-dirtybar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px;padding:8px 11px;border-radius:9px;background:color-mix(in srgb,#f5a524 12%,transparent);border:1px solid #f5a52466;font-size:12.5px}
  .tk-dirtybar .sp{flex:1 1 auto}
  @media(max-width:1280px){.tk-wrap{grid-template-columns:1fr}.tk-rail{position:static;max-height:none}}
  @media(max-width:900px){.tk-lane-bd{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media(max-width:640px){.tk-lane-bd{grid-template-columns:1fr}.tk-proj-hd .sum{display:none}}
  @media(prefers-reduced-motion:reduce){*,*:before,*:after{transition:none!important;animation:none!important}.card:hover,.gd-card:hover,.gd-task:hover{transform:none}}

  /* ===== v3-22 · 双击改标题 / 卡上回讨论 / 卡内子任务 ===== */
  .tk-title-edit{width:100%;border:1px solid var(--accent);border-radius:5px;background:var(--card-bg);color:var(--text);
    font:inherit;font-size:12px;font-weight:600;padding:1px 4px;outline:none;font-family:inherit;min-width:0}
  .tk-card .tk-r1 .tt{cursor:text}
  .tk-reply{margin-top:6px;padding-top:5px;border-top:1px dashed var(--card-border);display:flex;align-items:center;gap:5px;
    font-size:10px;color:var(--muted);cursor:text;min-height:17px}
  .tk-reply .ic{font-size:9.5px;opacity:.8;flex:0 0 auto}
  .tk-reply .tx{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tk-reply .tx.dim{opacity:.55}
  .tk-reply:hover{color:var(--text)}
  .tk-reply:hover .tx.dim{opacity:.9}
  .tk-reply-in{flex:1 1 auto;min-width:0;border:none;background:var(--card-bg);color:var(--text);font:inherit;font-size:10.5px;
    padding:2px 5px;border-radius:4px;outline:1px solid var(--accent);font-family:inherit}
  .tk-subs{margin-top:6px;padding-top:5px;border-top:1px dashed var(--card-border)}
  .tk-subs-hd{display:flex;align-items:center;gap:6px;font-size:9.5px;color:var(--muted);margin-bottom:3px}
  .tk-subs-hd b{color:var(--text);font-weight:700}
  .tk-subs-hd .bar{flex:1 1 auto;height:3px;border-radius:2px;background:var(--card-border);overflow:hidden}
  .tk-subs-hd .bar i{display:block;height:100%;background:#10b981;border-radius:2px;transition:width .2s}
  .tk-subs-hd button{border:1px dashed var(--card-border);background:none;color:var(--muted);border-radius:4px;font-size:9px;
    padding:0 4px;cursor:pointer;font-family:inherit;line-height:1.6}
  .tk-subs-hd button:hover{border-color:var(--accent);color:var(--accent);border-style:solid}
  .tk-sub{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--text);padding:1px 0;cursor:pointer}
  .tk-sub input[type=checkbox]{width:11px;height:11px;accent-color:var(--accent);cursor:pointer;flex:0 0 auto;margin:0}
  .tk-sub span{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tk-sub.done span{color:var(--muted);text-decoration:line-through;opacity:.7}
  .tk-sub .del{opacity:0;border:none;background:none;color:var(--muted);cursor:pointer;font-size:10px;padding:0 2px;line-height:1;font-family:inherit}
  .tk-sub:hover .del{opacity:.6}
  .tk-sub .del:hover{color:#ef4444;opacity:1}
  .tk-sub-more{font-size:9px;color:var(--muted);opacity:.7;padding-top:1px}
  .tk-sub-more:hover{opacity:1;cursor:pointer}
  .tk-subadd-inline{border:1px dashed var(--card-border);background:none;color:var(--muted);border-radius:4px;font-size:9.5px;
    padding:0 4px;cursor:pointer;font-family:inherit;line-height:1.7;flex:0 0 auto;opacity:.55;transition:.14s}
  .tk-reply:hover .tk-subadd-inline{opacity:1}
  .tk-subadd-inline:hover{border-style:solid;border-color:var(--accent);color:var(--accent)}
  /* ===== v3-21 · 状态点换列 / 卡片右键菜单 / 我来做认领 ===== */
  .tk-stbtn{width:9px;height:9px;border-radius:50%;border:none;padding:0;cursor:pointer;flex:0 0 auto;margin-top:4px;position:relative;transition:transform .14s}
  .tk-stbtn:hover{transform:scale(1.4)}
  .tk-stbtn:after{content:'';position:absolute;inset:-6px}
  .tb-menu{position:fixed;z-index:9998;background:var(--card-bg);border:1px solid var(--card-border);border-radius:10px;
    box-shadow:0 16px 44px rgba(0,0,0,.45);padding:4px;min-width:168px}
  .tb-menu-hd{font-size:9.5px;color:var(--muted);padding:4px 9px 5px;letter-spacing:.02em}
  .tb-menu-i{display:flex;align-items:center;gap:8px;width:100%;border:none;background:none;color:var(--text);font:inherit;
    font-size:12px;padding:6px 9px;border-radius:6px;cursor:pointer;text-align:left;font-family:inherit;line-height:1.5}
  .tb-menu-i:hover{background:color-mix(in srgb,var(--accent) 16%,transparent)}
  .tb-menu-i .ic{width:15px;text-align:center;flex:0 0 auto;font-size:11px;opacity:.9}
  .tb-menu-i .d{width:8px;height:8px;border-radius:50%;display:inline-block}
  .tb-menu-i .ck{margin-left:auto;color:var(--accent);font-weight:800;font-size:11px}
  .tb-menu-i.danger{color:#f87171}
  .tb-menu-i.danger:hover{background:color-mix(in srgb,#ef4444 16%,transparent)}
  .tb-menu .sp{height:1px;background:var(--card-border);margin:4px 6px}
  /* ===== v3-19 · @ 成员选择器 / 多人负责人 / 讨论名字上色 ===== */
  .tb-ment{position:fixed;z-index:9999;background:var(--card-bg);border:1px solid var(--card-border);border-radius:11px;
    box-shadow:0 14px 38px rgba(0,0,0,.42);padding:5px;min-width:172px;max-width:280px}
  .tb-ment-hd{font-size:9.5px;color:var(--muted);padding:4px 8px 6px;letter-spacing:.02em;white-space:nowrap;overflow:hidden}
  .tb-ment-i{display:flex;align-items:center;gap:7px;width:100%;border:none;background:none;color:var(--text);font:inherit;
    font-size:12px;padding:6px 8px;border-radius:7px;cursor:pointer;text-align:left;font-family:inherit;line-height:1.4}
  .tb-ment-i:hover,.tb-ment-i.on{background:color-mix(in srgb,var(--accent) 18%,transparent)}
  .tb-ment-i i{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
  .tb-ment-i b{font-weight:650;white-space:nowrap}
  .tb-ment-i em{margin-left:auto;font-style:normal;font-size:10px;color:var(--muted);opacity:.9;white-space:nowrap;overflow:hidden}
  /* 多人负责人：头像叠放；超过 2 人折成 +N */
  .tk-av+.tk-av{margin-left:-5px;box-shadow:0 0 0 1.5px var(--card-bg-2)}
  .tk-av-more{background:var(--card-border)!important;color:var(--muted)!important;font-size:8.5px!important;font-weight:700}
  /* 讨论里的人：色点 + 人色名字，谁说的颜色一眼分清 */
  .tb-who{display:inline-flex;align-items:center;gap:4px;font-weight:700;white-space:nowrap}
  .tb-who i{width:6px;height:6px;border-radius:50%;flex:0 0 auto;display:inline-block}
  .gd-disc-list p>b{font-weight:700}
  .tb-disc-n{font-size:10.5px;color:var(--muted);margin-bottom:2px;display:flex;align-items:center;gap:5px;flex-wrap:wrap}
  .tb-owner-multi{display:flex;align-items:center;gap:6px;flex-wrap:wrap}

  /* ===== v3-18 · 统一看板层（tb-*）：任务 / BUG / 日志 =====
     目标：这 3 个面板和「任务看板」长同一张脸 —— 同 KPI 条、同泳道列、
     同紧凑卡（P 级 pill + 标题 + 信息行 + hover 图标动作）、同剩余天数说法。
     全部走既有主题令牌，6 套主题自动跟随。 */
  .tb-c4.tk-lane-bd{grid-template-columns:repeat(4,minmax(0,1fr))}
  .tk-lane-bd.tb-c3{grid-template-columns:repeat(3,minmax(0,1fr))}
  .tk-lane-bd.tb-c2{grid-template-columns:repeat(2,minmax(0,1fr))}
  .tb-desc{font-size:10.5px;color:var(--muted);line-height:1.55;margin-top:5px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .tb-k{font-size:10px;color:var(--muted);opacity:.85;white-space:nowrap}
  .tb-pg{display:flex;align-items:center;gap:6px;margin-top:6px}
  .tb-pct{font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums;flex:0 0 auto}
  .tb-line{display:flex;gap:6px;font-size:10.5px;line-height:1.6;margin-top:3px;color:var(--text)}
  .tb-line i{font-style:normal;flex:0 0 26px;color:var(--muted);opacity:.8;font-size:10px;padding-top:1px}
  .tb-line span{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .tb-line.warn i{color:#f5a524;opacity:1}
  .tb-line.ok i{color:#10b981;opacity:1}
  .tb-adv{font-size:9.5px;border:1px solid var(--card-border);border-radius:5px;padding:0 6px;background:var(--card-bg);color:var(--muted);cursor:pointer;font-family:inherit;white-space:nowrap;line-height:1.7}
  .tb-adv:hover{border-color:var(--accent);color:var(--accent)}
  .tk-own-ro{cursor:default}
  /* 开发日志时间线 */
  .tb-loglist{display:flex;flex-direction:column;gap:8px}
  .tb-logrow{display:grid;grid-template-columns:62px minmax(0,1fr);gap:9px;align-items:start}
  .tb-logdate{display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding-top:7px}
  .tb-logdate b{font-size:14px;font-weight:750;font-variant-numeric:tabular-nums;line-height:1.1}
  .tb-logdate i{font-style:normal;font-size:9.5px;color:var(--muted);opacity:.75}
  .tb-logdate span{font-size:9.5px;color:var(--muted);opacity:.9}
  .tk-card.tb-logcard{padding:9px 11px}
  /* 手机上没有 hover → 图标动作常显一半，否则根本点不到 */
  @media(hover:none){.tk-card .tk-ico{opacity:.72}}
  @media(max-width:900px){
    .tk-lane-bd.tb-c3,.tk-lane-bd.tb-c4,.tb-timers{grid-template-columns:repeat(2,minmax(0,1fr))}
  }
  @media(max-width:640px){
    .tk-lane-bd.tb-c3,.tk-lane-bd.tb-c4,.tk-lane-bd.tb-c2,.tb-timers{grid-template-columns:1fr}
    .tb-logrow{grid-template-columns:52px minmax(0,1fr)}
    .tb-trow{grid-template-columns:52px minmax(0,1fr) auto;row-gap:3px}
    .tb-trow .tx{grid-column:1/-1}
  }
  .tk-pri.tb-ok{background:#10b981;color:#fff}
  .tk-card.tb-logcard{position:relative}
  .tb-loghd{position:absolute;right:5px;top:5px}
  .tb-logcard .tb-line.main span{font-weight:600;color:var(--text);font-size:11.5px;line-height:1.65;-webkit-line-clamp:3;padding-right:44px}
  .tb-stages span{width:16px;height:16px}
`;

  /* ============================================================
     渲染
     ============================================================ */
  function updateTheme(){const tr=root?.querySelector('.t-root');if(tr)tr.dataset.th=curTheme();}
  function curTheme() {
    if (CONFIG.theme === 'dark') return 'midnight';
    if (CONFIG.theme === 'light') return 'default';
    try {
      if(document.documentElement.classList.contains('dark'))return 'midnight';
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
          <div class="dhd"><span id="dTitle">卡片</span><button type="button" class="closeX" id="dClose" aria-label="关闭卡片">×</button></div>
          <div class="dbd" id="dBody"></div>
          <div class="dft" id="dFoot"></div>
        </div>
        <div class="modal conflictModal">
          <div class="mbox">
            <div class="mhd">⚠️ 检测到编辑冲突 <span class="spacer"></span><button type="button" class="closeX" id="cfClose" aria-label="关闭冲突提示">×</button></div>
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
            <div class="mhd"><span id="gmTitle">标题</span><span class="spacer"></span><button type="button" class="closeX" id="gmClose" aria-label="关闭弹窗">×</button></div>
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
    /* v2.5：所有 .modal 都支持点空白处关闭（此前只有 ✕ 和 Esc，用户实测点不动） */
    root.querySelectorAll('.modal').forEach(m => m.addEventListener('click', ev => {
      if (ev.target !== m) return;
      closeModal(m.classList.contains('genericModal') ? 'genericModal' : 'conflictModal');
    }));
    /* v2.5：编辑器脏数据守卫 —— 改过内容再关，先在弹窗内插一条确认条（不动原有页脚按钮，避免打断编辑器事件） */
    const gmBodyEl = root.querySelector('#gmBody');
    if (gmBodyEl) { gmBodyEl.addEventListener('input', () => { if (modalOptions) EDIT_DIRTY = true; });
                    gmBodyEl.addEventListener('change', () => { if (modalOptions) EDIT_DIRTY = true; }); }
    const gmFootEl = root.querySelector('#gmFoot');
    if (gmFootEl) gmFootEl.addEventListener('click', ev => {
      const b = ev.target.closest('button');
      /* ⚠️ 保存按钮是 <button class="btn btn-primary" id="gd-editor-save">，不是 .pri ——
         v2.5.0 只判了 pri/danger，所以点「更改保存」后仍被当成脏数据拦下来（用户实测）。
         现在：页脚上的按钮 = 用户的有意动作，一律不再拦；只有 ✕ / 点空白 / Esc 才走脏数据守卫。 */
      if (b.id === 'gd-editor-save' || b.id === 'gd-editor-del' || b.id === 'gd-editor-cancel'
          || b.classList.contains('btn-primary') || b.classList.contains('pri')
          || b.classList.contains('danger') || b.classList.contains('btn-danger')) EDIT_DIRTY = false;
    });
    root.querySelector('#cfClose').onclick = () => closeModal('conflictModal');
    root.addEventListener('click', onRootClick);
    root.addEventListener('change', onRootChange);
  }

  function renderLegacy() {
    if (!root) return;
    const theme = curTheme();
    const tr = root.querySelector('.t-root');
    if (tr) tr.dataset.th = theme;
    const surf = root.querySelector('.surface');
    if (!surf) return;
    surf.innerHTML = `
        <div class="top">
          <button class="gb" id="devModeBtn">开发工作区</button><div class="brand">🎮 UE 团队看板 <small>· 共 ${DATA.length} 项</small></div>
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
    surf.insertAdjacentHTML('afterbegin',conflictBanner());
    root.querySelector('#devModeBtn').onclick=()=>{MODE='dev';render();};
    root.querySelector('#resolveDev')?.addEventListener('click',resolveConflict);
    renderKPI();
    renderBoard();
    bindStatic();
    updateUndoBtns();
    updateSel();
    const ch = CONFIG.channel;
    setDot(...syncStatus);
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
    const lock = LOCKED[a.id], draft = localDrafts['DATA|'+a.id], dcount = (DISCUSS[a.id] || []).length;
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
      <div class="field"><div class="flabel">📝 任务说明</div><textarea id="fNote" class="noteArea" placeholder="要做什么、做到什么程度、和谁配合…（可写长）">${esc(a.note)}</textarea></div>
      <div class="flabel" style="margin-top:4px">💬 讨论（${dcount}）· 讨论留在卡上，三个月后还能查到</div>
      <div class="disc" id="discList">
        ${(DISCUSS[a.id] || []).map(d => `<div class="disc-i">${av(d.u, 22)}
          <div class="disc-b"><div class="disc-h">${whoName(d.u)}<span class="tm">${fmtT(d.t)}</span></div>
          <div class="disc-t">${esc(d.x).replace(mentionRe(), '<span class="at">@$1</span>')}</div></div></div>`).join('')
        || '<div class="tiny mut">还没有讨论 · 第一个说点什么</div>'}
      </div>
      <div class="row" style="gap:6px;margin-top:8px">
        <input type="text" id="discInput" data-mention placeholder="回复…（${esc(mentionHint())}）" style="flex:1">
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
    const ud=root.querySelector('#useDraft');if(ud)ud.onclick=()=>{const d=localDrafts['DATA|'+a.id];Object.entries({name:'fName',status:'fStatus',owner:'fOwner',pri:'fPri',prog:'fProg',note:'fNote'}).forEach(([k,id])=>root.querySelector('#'+id).value=d[k]);root.querySelector('#fDue').value=dstr(d.due);toast('草稿已恢复到表单');};
    const dd=root.querySelector('#dropDraft');if(dd)dd.onclick=()=>{delete localDrafts['DATA|'+a.id];saveDrafts();openDrawer(a.id);toast('本机草稿已丢弃');};
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

  /* ============================================================
     自动同步（2026-10-13 新增；2026-10-15 v2.4.2 改自适应频率）
     ------------------------------------------------------------
     之前只在 mount 时 pull 一次 ⇒ 同事改了卡片，你这边**必须手点「🔄 刷新」**才看得到。
     现在三层，尽量静默、不打扰、不烧 API 配额：
       ① 自适应轮询：**有人正在编辑（存在 15 分钟内的锁）→ 5 秒一班**；平时 20 秒一班
          （锁胶囊/别人的改动最多 5 秒出现在你屏幕上）
       ② 切回这个标签页（visibilitychange → visible）立刻拉
       ③ 窗口重新获焦（focus）立刻拉
     ⚠️ 抽屉打开时不拉：编辑中的 curCard 指向旧对象，pull 后 applyState 会换掉 DATA，
        这时保存会把改动写回悬空对象 ⇒ 直接丢数据。
     ⚠️ 轮询用静默模式（pull(true)）：不闪「拉取中…」、失败也不动状态灯。
     配额：5s 一班 ≈ 720 次/小时/标签页 ×2 请求；只在有锁时启用 ⇒ 三人常态仍是 20s
        （180 次/小时/标签页），fine-grained token 5000/小时才不会被打爆。 */
  let autoTimer = null, lastAuto = 0, nextAutoMs = 20000;
  function autoPull() {
    scheduleAuto();                                   // 先排下一班，再决定这一班拉不拉
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (curCard || root?.querySelector('.modal.show')) return;                              // 正在编辑，别打扰
    if (syncing) return;                              // 已有同步在跑
    if (!CONFIG.channel || CONFIG.channel.type === 'local') return;
    const t = Date.now();
    if (t - lastAuto < 3000) return;                  // 防重入（轮询 + focus 可能撞一起）
    lastAuto = t;
    pull(true);
  }
  function scheduleAuto() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    const hasLock = (DEV.devTasks || []).some(function(r){const lb=r.lockedBy;return lb&&lb.by&&lb.by!==CONFIG.me&&(now()-(lb.at||0))<15*60000;});
    nextAutoMs = hasLock ? 5000 : 20000;
    autoTimer = setTimeout(autoPull, nextAutoMs);
  }
  function startAutoSync() {
    stopAutoSync();
    scheduleAuto();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', autoPull);
    }
    if (typeof window !== 'undefined') window.addEventListener('focus', autoPull);
  }
  function stopAutoSync() { if(autoTimer){clearTimeout(autoTimer);autoTimer=null;} document.removeEventListener('visibilitychange',autoPull);global.removeEventListener?.('focus',autoPull); }
  function sendDisc(id) {
    const inp = root.querySelector('#discInput'); if (!inp) return;
    const v = inp.value.trim(); if (!v) return;
    snapshot();
    (DISCUSS[id] = DISCUSS[id] || []).push({ u: CONFIG.me, t: now(), x: v });
    log('discuss', id, `讨论：${v.slice(0, 20)}`);
    const at = notifyMentions(v, id);
    if (at.length) toast(`📨 已提醒 ${at.join('、')}`);
    else if (/@[^\s]/.test(v)) toast(`⚠️ @ 的名字没匹配到成员（可用：${mentionHint()}）`, 'warn');
    save(); render(); updateBell(); openDrawer(id, true);
  }
  function saveDraft(a) {
    snapshot();
    localDrafts['DATA|'+a.id] = {
      name: root.querySelector('#fName').value, status: root.querySelector('#fStatus').value,
      owner: root.querySelector('#fOwner').value, pri: root.querySelector('#fPri').value,
      due: +new Date(root.querySelector('#fDue').value).setHours(18, 0, 0, 0),
      prog: +root.querySelector('#fProg').value, note: root.querySelector('#fNote').value
    };
    try{saveDrafts();}catch(e){toast('草稿保存失败，请保留表单','warn');return;}closeDrawer();render();
    toast('📝 已存为草稿 · 别人看到的还是旧值', 'warn');   // 43 草稿暂存
  }
  function saveCard(a) {
    a=DATA.find(x=>x.id===a.id);if(!a){toast('卡片已删除');return;}
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
    a.updatedAt=now();a.draft=null;delete localDrafts['DATA|'+a.id];saveDrafts();
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
      html: `删除「<b>${esc(a.name)}</b>」？<br><span class="tiny mut">会移入回收站，保留删除记录，可在回收站还原。</span>`,
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
    const at=tick();DELETED['DATA|'+a.id]={at,by:CONFIG.me};TRASH.unshift({...a,deletedAt:at,deletedBy:CONFIG.me});
    DATA.splice(i, 1);
    log('delete', a.id, `删除「${a.name}」`);
    save(); render();
    toast(`已移入回收站：${a.name}`, '', () => restoreFromTrash(a.id));
  }
  function restoreFromTrash(id, closeAfter) {
    const i = TRASH.findIndex(x => !x.kind && x.id === id); if (i < 0) return;
    snapshot();
    const a = TRASH.splice(i, 1)[0]; delete a.deletedAt; delete a.deletedBy;
    a._restoredAt=Math.max(tick(),(DELETED['DATA|'+id]?.at||0)+1);a.updatedAt=a._restoredAt;DATA.push(a);
    log('restore', id, `还原「${a.name}」`);
    save(); render();
    toast(`已还原：${a.name}`, '', () => undo());
    if (closeAfter) closeModal('genericModal');
  }
  function showTrash() {
    root.querySelector('#gmTitle').innerHTML = '🗑️ 回收站';
    root.querySelector('#gmBody').innerHTML = TRASH.length
      ? TRASH.filter(a=>!a.kind).map(a => `<div class="trash-i">
          <div style="flex:1"><div style="font-weight:650;font-size:12.5px">${esc(a.name)}</div>
          <div class="tiny mut">${roleOf(a.deletedBy).n} 删除 · ${fmtT(a.deletedAt)} · 保留删除记录，可在回收站还原</div></div>
          <button class="btn pri" data-restore="${a.id}">还原</button></div>`).join('')
        + '<div class="mut tiny" style="margin-top:9px">💡 删除只是标记，删除标记持续保留，避免旧缓存复活记录</div>'
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
          const c=l.cardId&&(DATA.find(x=>x.id===l.cardId)||Object.values(DEV).flat().find(x=>x.id===l.cardId));
          return `<div class="tl-i"><div><b>${roleOf(l.by).n}</b> <span class="mut">${actLabel(l.act)}</span>
            ${c ? `<b style="color:var(--accent)">${esc(c.name||c.title||c.date)}</b>` : ''}
            <div class="tm">${fmtT(l.t)} ${esc(l.detail || '')}</div></div></div>`;
        }).join('')}</div><div class="mut tiny" style="margin-top:9px">💡 像回放录像一样看团队今天做了什么</div>`
      : '<div class="mut" style="text-align:center;padding:28px 0">还没有操作记录 · 试着拖一张卡看看</div>';
    root.querySelector('#gmFoot').innerHTML = '';
    openModal('genericModal');
  }
  function showHistory(id) {
    const c=DATA.find(x=>x.id===id)||Object.values(DEV).flat().find(x=>x.id===id);if(!c)return;
    const logs = LOG.filter(l => l.cardId === id);
    root.querySelector('#gmTitle').innerHTML = `🕘 变更时光机 · ${esc(c.name||c.title||c.date)}`;
    root.querySelector('#gmBody').innerHTML = logs.length
      ? `<div class="tl">${logs.map(l => `<div class="tl-i"><div><b>${roleOf(l.by).n}</b> ${esc(l.detail || actLabel(l.act))}<div class="tm">${(new Date(l.t).toDateString()===new Date().toDateString()?'':dstr(l.t)+' ')}${fmtT(l.t)}</div></div></div>`).join('')}</div>
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
    const ch=CONFIG.channel;
    DevModal.openModal({title:'团队数据同步',html:'<p class="gd-note">共用数据库：'+esc(ch.repo)+' / '+esc(ch.file)+' · '+esc(ch.branch)+'</p><p class="gd-note">凭据状态：'+(ch.token?'已配置（不显示内容）':'未配置，保留本机修改')+'</p><form id="team-token-form" class="gd-form"><label class="gd-field gd-full"><span>更新本机 Token（留空不修改）</span><input type="password" name="token" autocomplete="off" spellcheck="false" placeholder="粘贴后验证，仅保存到本机"></label><button type="submit" class="btn pri">验证并保存</button></form><p id="token-result" class="gd-note" role="status"></p><div class="gd-form-actions"><button class="btn" id="token-clear">移除本机凭据</button><button class="btn pri" id="syncNow">立即同步</button></div><p class="gd-note">记录按字段合并。冲突处理后再上传；截图保存在同一个私有仓中。成员须使用同版组件，界面更新需要刷新页面。</p>',mount:body=>{
      body.querySelector('form').onsubmit=async e=>{
        e.preventDefault();const input=body.querySelector('[name=token]'),value=input.value.trim(),label=body.querySelector('#token-result'),button=body.querySelector('[type=submit]');if(!value){label.textContent='未修改凭据';return;}button.disabled=true;label.textContent='正在验证仓库访问…';
        try{const res=await fetch('https://api.github.com/repos/'+ch.repo,{headers:{Authorization:'token '+value},cache:'no-store'});if(!res.ok)throw Error('仓库访问验证失败（'+res.status+'）');localStorage.setItem(SYNC_PREFIX+'token',value);CONFIG.channel.token=value;input.value='';label.textContent='已验证并保存到本机';setDot('warn','已配置 · 等待同步');}
        catch(e){label.textContent=e.message||'验证失败，未保存';}finally{button.disabled=false;}
      };
      body.querySelector('#token-clear').onclick=()=>askConfirm({title:'移除本机凭据？',msg:'团队记录和数据库会保留。移除后本页只保留本机修改。',then:yes=>{if(!yes)return;try{localStorage.removeItem(SYNC_PREFIX+'token');CONFIG.channel.token=null;setDot('warn','未配 token · 仅本地');toast('本机凭据已移除');}catch(e){toast('移除失败','warn');}}});
      body.querySelector('#syncNow').onclick=()=>{DevModal.closeModal();doSyncChannel('github');};
    }});
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
  function openModal(cls) {EDIT_DIRTY=false;const m=root.querySelector('.'+cls);if(m){modalReturn=root.activeElement;m.classList.add('show');m.setAttribute('role','dialog');m.setAttribute('aria-modal','true');m.setAttribute('aria-label',root.querySelector('#gmTitle')?.textContent||'对话框');setTimeout(()=>{(m.querySelector('#gmBody input,#gmBody select,#gmBody textarea')||m.querySelector('input,select,textarea,button'))?.focus();},0);}}
  function closeModal(cls) {
    /* v2.5 脏数据守卫：改过内容第一次关 → 不关，改弹窗里插确认条；再点「放弃改动」才真关 */
    if(cls==='genericModal' && EDIT_DIRTY && root){
      const m0=root.querySelector('.genericModal'), bd=root.querySelector('#gmBody');
      if(m0 && bd && !bd.querySelector('.tk-dirtybar')){
        const bar=document.createElement('div');
        bar.className='tk-dirtybar';
        bar.innerHTML='<span>⚠️ 有未保存的改动，确定关掉？</span><span class="sp"></span>'
          +'<button type="button" class="btn" data-tk-keep>继续编辑</button>'
          +'<button type="button" class="btn danger" data-tk-drop>放弃改动</button>';
        bd.insertBefore(bar, bd.firstChild);
        bar.querySelector('[data-tk-keep]').onclick=()=>{ bar.remove(); };
        bar.querySelector('[data-tk-drop]').onclick=()=>{ EDIT_DIRTY=false; bar.remove(); closeModal('genericModal'); };
        setTimeout(()=>bar.scrollIntoView({block:'nearest'}),0);
        return;
      }
    }
    EDIT_DIRTY=false;
    if(cls==='genericModal'&&modalOptions&&typeof modalOptions.beforeClose==='function'){let ok=true;try{ok=modalOptions.beforeClose();}catch(e){ok=true;}if(ok===false)return;}const m=root.querySelector('.'+cls);if(m)m.classList.remove('show');if(cls==='genericModal'){modalOptions=null;const box=root.querySelector('#gmBody');box.oninput=null;box.onclick=null;}modalReturn?.focus?.();if(pendingPush&&!syncing){pendingPush=false;scheduleSync();}}
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
    if(!mounted||!e.composedPath().includes(hostEl))return;
    const modal=root.querySelector('.modal.show');
    if(modal&&e.key==='Tab'){const list=[...modal.querySelectorAll('button,input,select,textarea,[tabindex]')].filter(x=>!x.disabled&&x.getClientRects().length);if(list.length){const i=list.indexOf(root.activeElement);if(e.shiftKey&&(i<=0)){e.preventDefault();list.at(-1).focus();}else if(!e.shiftKey&&(i===list.length-1||i<0)){e.preventDefault();list[0].focus();}}return;}
    const input=e.composedPath().find(x=>x.matches?.('input,textarea,[contenteditable=true]'));
    if(input&&e.key!=='Escape')return;
    if(MODE==='dev'&&e.key!=='Escape'){
      /* v2.5：任务看板快捷键（1/2/3 切视图 · j/k 换卡 · t 开关右栏 · / 搜索 · Enter 编辑） */
      if(GameDev._tab==='devTask'){
        if(e.key==='/'){const kw=root.querySelector('[data-tk-kw]');if(kw){e.preventDefault();kw.focus();}return;}
        if(e.key==='Enter'&&TBoard.rsel){e.preventDefault();GameDev.openEditor('devTask',TBoard.rsel);return;}
        if(TBoard.key(e)){e.preventDefault();GameDev.repaint();}
      }
      return;
    }
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
      if(channel&&Object.hasOwn(channel,'token')){try{if(channel.token)localStorage.setItem(SYNC_PREFIX+'token',channel.token);else localStorage.removeItem(SYNC_PREFIX+'token');}catch(e){toast('凭据保存失败，仅在当前页面有效','warn');}}
      return api;
    },
    development:DevData,
    get developmentData(){return clone(DEV);},
    get conflicts(){return clone(CONFLICTS);},
    get data() { return DATA.slice(); },
    set data(list) { DATA = list || []; render(); save(); },
    get columns() { return COLUMNS.slice(); },
    get trash() { return TRASH.slice(); },
    get log() { return LOG.slice(); },
    pull, push: () => doSyncChannel('github'),
    setMembers(roles, opt) {
      Object.assign(ROLE, roles || {});
      /* v3-19：成员名字是团队共享信息 —— 以前只存本机，换台机器又叫回默认名。
         现在显式改名（非 silent）会把名字写进团队数据，两台机器看同一份。 */
      if(!(opt && opt.silent)){
        const names = {};
        Object.keys(ROLE).forEach(function(k){ names[k] = String(ROLE[k].n || ''); });
        EXTRA.members = Object.assign({}, EXTRA.members || {}, names);
        try { save(); } catch (e) {}
      }
      render(); return api;
    },
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
    _autoNextMs() { return nextAutoMs; },   // v2.4.2 测试钩子：当前自适应轮询间隔
    get _ROLE() { return ROLE; },           // v2.4.4 测试钩子：成员表（名字改了测试自动跟随，不再硬编码）
    get _uDigest() { return TBoard.digestText(D.devAll('devTask')); },   // v2.13.0 测试钩子：今日更新摘要文本
    get _uRows() { return TBoard.uScan(D.devAll('devTask')); },          // v2.13.0 测试钩子：今日更新行
    _uMarkAllRead() { (TBoard._uRows||[]).forEach(function(r){ TBoard.uMarkRead(r.t.id); }); render(); return api; },
    on,
    mount(sel) {
      hostEl = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!hostEl) return api;
      if(mounted&&hostEl.shadowRoot===root)return api;
      root = hostEl.shadowRoot || (hostEl.attachShadow ? hostEl.attachShadow({ mode: 'open' }) : hostEl);
      if (!root.querySelector) root = hostEl;   // 极端兜底
      VIEW = CONFIG.defaultView;
      // 首次：本地 → 无则种子
      const local = loadLocal();
      if (local) applyState(local);
      // 空数据库保持空，不将示例卡写入真实团队仓。
      SAVED=clone(collectLocal());
      try {localDrafts=JSON.parse(localStorage.getItem(SYNC_PREFIX+'drafts')||'{}');CONFLICTS=local?local._localConflicts||[]:[];const b=JSON.parse(localStorage.getItem(SYNC_PREFIX+'base')||'null');if(b&&b.repo===CONFIG.channel.repo&&b.file===CONFIG.channel.file&&b.branch===CONFIG.channel.branch)BASE=b.state;const p=JSON.parse(localStorage.getItem(SYNC_PREFIX+'prefs')||'{}');GameDev._project=p.project||'';GameDev._tab=DEV_KEYS[p.tab]?p.tab:'devTask';GameDev._member=p.member||'';}catch(e){}
      if (!mounted) { mounted = true; document.addEventListener('keydown', onKeydown); }
      buildChrome();
      themeObserver?.disconnect();if(global.MutationObserver){themeObserver=new MutationObserver(()=>{const tr=root?.querySelector('.t-root');if(tr)tr.dataset.th=curTheme();});themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class','data-theme']});if(hostEl.parentElement)themeObserver.observe(hostEl.parentElement,{attributes:true,attributeFilter:['class','data-theme']});}
      themeMedia=global.matchMedia?.('(prefers-color-scheme: dark)');themeMedia?.addEventListener?.('change',updateTheme);
      render();
      pull();
      startAutoSync();
      emit('mount', { count:totalRecords(),view:VIEW });
      return api;
    },
    destroy() {
      if(pollTimer)clearInterval(pollTimer);clearTimeout(pushTimer);if(GameDev._clock)clearInterval(GameDev._clock);imageCache.forEach(u=>URL.revokeObjectURL(u));imageCache.clear();
      stopAutoSync();themeObserver?.disconnect();themeMedia?.removeEventListener?.('change',updateTheme);
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
    if(ds.me)opt.me=ds.me;else try{const me=localStorage.getItem(SYNC_PREFIX+'me');if(ROLE[me])opt.me=me;}catch(e){}
    if (ds.theme) opt.theme = ds.theme;
    try { const tn = localStorage.getItem(SYNC_PREFIX + 'tone'); if (tn) opt.tone = tn; } catch (e) {}
    if (ds.view) opt.defaultView = ds.view;
    const chOpt = {};
    if (ds.repo) chOpt.repo = ds.repo;
    if (ds.file) chOpt.file = ds.file;
    if (ds.branch) chOpt.branch = ds.branch;
    const tokenFromAttr = null; // 凭据仅从本机存储或宿主 config 传入
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
