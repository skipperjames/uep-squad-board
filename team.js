/* ============================================================
   team.js —— UE 团队看板「植入工具」  v2.2.0-20261014
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

  const VERSION = 'v2.2.0-20261014'; // 团队开发六页签 / 共享字段合并 / 删除标记 / 私仓附件

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
    b:  { n: '邢锦', c: '#e879f9', r: '美术TA' }
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
  let mounted=false,themeObserver=null,themeMedia=null;

  const now = () => Date.now();
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const fmtT = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
  const daysLeft = ms => Math.round((ms - now()) / 86400000);
  const dstr = ms => { const d = new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
  const fieldLabel = f => ({ prog:'进度', note:'任务说明', owner:'负责人', status:'状态', pri:'优先级', due:'交付日', name:'名称',__timeResult:'计时结束与耗时',title:'标题',description:'说明',acceptance:'验收标准',dependsOn:'前置任务' }[f] || f);
  const fieldVal = (f, v) => {
    if (f === 'status') return ST[v] ? ST[v].l : v;
    if (f === 'owner') return (ROLE[v] || {}).n || v;
    if (f === 'prog') return v + '%';
    if (f === 'due') return dstr(v);
    return String(v);
  };
  const roleOf = id => ROLE[id] || { n: String(id), c: '#888', r: '' };

  /* v2.2: shared development records. Preferences/drafts are local only. */
  const DEV_KEYS = {devProject:'devProjects',devMilestone:'devMilestones',devTask:'devTasks',devBug:'devBugs',devLog:'devLogs',devTime:'devTimes',devAsset:'devAssets'};
  const STAGE_LIST = ['资产制作','UV 拆分','材质制作','UI 制作','美术场景搭建','玩法程序','系统功能','工具脚本','优化调优','联调测试','策划','评审','文档'];
  const DEV_SCHEMA = {
    devProjects:{choices:{status:['active','paused','released','archived']}},
    devMilestones:{choices:{status:['planned','active','done']}},
    devTasks:{choices:{status:['backlog','doing','review','done'],category:['玩法','程序','美术','技术美术','音频','测试','其他'],priority:['high','mid','low']}},
    devBugs:{choices:{status:['open','fixing','verify','closed'],severity:['critical','high','medium','low']}},
    devLogs:{choices:{}},devTimes:{choices:{category:['程序','美术','技术美术','设计','调试','学习','其他']}},
    devAssets:{choices:{type:['模型','材质','动画','特效','HDA','场景','音频','其他']}}
  };
  const clone = x => JSON.parse(JSON.stringify(x));
  const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const uid = () => global.crypto?.randomUUID?.() || now().toString(36)+'-'+Math.random().toString(36).slice(2);
  let DEV = Object.fromEntries(Object.values(DEV_KEYS).map(k=>[k,[]]));
  const totalRecords=()=>DATA.length+Object.values(DEV).reduce((n,rows)=>n+rows.length,0);
  let DELETED = {}, EXTRA = {}, BASE = null, SAVED = null, CONFLICTS = [];
  let MODE = 'dev', syncStatus = ['warn','本地模式'], localDrafts = {}, modalOptions = null, modalReturn = null;
  let monotonic = 0;
  const tick = () => monotonic = Math.max(now(),monotonic+1);
  const sharedKeys = ['DATA',...Object.values(DEV_KEYS)];
  const timerFields=['startedAt','endedAt','minutes','sessionStartedAt','sessionEndedAt'];
  const isTimer=r=>r&&Object.hasOwn(r,'startedAt')&&r.category&&r.date;
  const fields = r => Object.keys(r||{}).filter(k=>!['id','createdAt','updatedAt','_ut','_fields','draft','_restoredAt',...(isTimer(r)?timerFields:[])].includes(k)).flatMap(k=>k==='checks'?Object.keys(r.checks||{}).map(s=>'checks.'+s):[k]).concat(isTimer(r)?['__timeResult']:[]);
  const getField = (r,k) => k==='__timeResult'?(isTimer(r)?Object.fromEntries(timerFields.map(k=>[k,r[k]||0])):undefined):k.startsWith('checks.') ? r?.checks?.[k.slice(7)] : r?.[k];
  function putField(r,k,v) {if(k==='__timeResult'){Object.assign(r,v);return;}if(k.startsWith('checks.'))(r.checks=r.checks||{})[k.slice(7)]=v;else if(v===undefined)delete r[k];else r[k]=clone(v);}
  function normalizeSessions(state){
    const rows=state.devTimes||[],primaries=rows.filter(r=>r.sessionId===r.id&&r.sessionStartedAt&&r.sessionEndedAt);
    for(const primary of primaries){
      const manual=new Set(rows.filter(r=>r.id.startsWith(primary.id+'@')&&!r.sessionId).map(r=>r.id));
      state.devTimes=state.devTimes.filter(r=>r.sessionId!==primary.id);let start=primary.sessionStartedAt,index=0;
      while(start<primary.sessionEndedAt){const day=new Date(start);day.setHours(24,0,0,0);const end=Math.min(+day,primary.sessionEndedAt),id=index++?primary.id+'@'+dstr(start):primary.id;
        const tomb=state.DELETED?.['devTimes|'+id];if(!manual.has(id)&&(!tomb||(primary._restoredAt||0)>tomb.at))state.devTimes.push({...clone(primary),id,date:dstr(start),startedAt:start,endedAt:end,minutes:(end-start)/60000});start=end;}
      if(primary.sessionStartedAt===primary.sessionEndedAt)state.devTimes.push(primary);
    }
    return state;
  }

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
    merged.devTasks.forEach(t=>{['dependsOn','milestoneId'].forEach(k=>{const kind=k==='dependsOn'?'devTasks':'devMilestones',tomb=tombs[kind+'|'+t[k]];if(t[k]&&tomb&&!merged[kind].some(r=>r.id===t[k])){t._fields={...t._fields,[k]:{t:tomb.at,by:tomb.by}};t[k]='';}});});
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
    if(r.milestoneId&&!DEV.devMilestones.some(m=>m.id===r.milestoneId&&m.projectId===r.projectId))throw Error('请选择同项目的里程碑');
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
    Object.entries(DEV_SCHEMA[key].choices).forEach(([k,opts])=>{if(!opts.includes(r[k]))throw Error('请选择有效的 '+fieldLabel(k));});
    if((kind==='devProject'||kind==='devAsset')?!String(r.name||'').trim():['devTask','devBug','devMilestone'].includes(kind)&&!String(r.title||'').trim())throw Error('请填写名称');
    if(kind==='devLog'&&!r.done&&!r.blockers&&!r.next)throw Error('至少填写一项进展、阻碍或下一步');
    ['date','dueDate','targetDate'].forEach(k=>{if(r[k]&&!/^\d{4}-\d{2}-\d{2}$/.test(r[k]))throw Error('日期格式无效');});
    if(['devLog','devTime'].includes(kind)&&!r.date)throw Error('请填写日期');
    if(kind==='devTask')validateTask(r);
    if(kind==='devTime'&&(!Number.isFinite(r.minutes)||r.minutes<0||r.minutes>1440||(!r.startedAt&&r.minutes<.1)))throw Error('手动工时应在 0.1–1440 分钟之间');
    if(kind==='devBug'&&((r.images||[]).length>2||(r.images||[]).some(x=>!validAttachment(x))))throw Error('截图附件格式无效');
    const before=clone(collectLocal());
    r.owner=r.owner||CONFIG.me;r.recorder=old?.recorder||CONFIG.me;r.checks=r.checks||{};
    stamp(r,old);DEV[key]=old?DEV[key].map(x=>x.id===id?r:x):[...DEV[key],r];
    log(old?'edit':'create',r.id,(kind==='devProject'?'项目':'开发记录')+' · '+(r.name||r.title||r.date));
    try { save(); } catch(e){applyState(before);throw e;}
    return r;
  }
  function devRemove(kind,id) {
    if(kind==='devProject')throw Error('项目请改为归档，以保留关联历史');
    const key=DEV_KEYS[kind],r=DEV[key]?.find(x=>x.id===id);if(!r)return;
    const before=clone(collectLocal()),at=tick();
    DELETED[key+'|'+id]={at,by:CONFIG.me};TRASH.unshift({...clone(r),kind:key,deletedAt:at,deletedBy:CONFIG.me});
    DEV[key]=DEV[key].filter(x=>x.id!==id);
    if(kind==='devMilestone'||kind==='devTask')DEV.devTasks.forEach(t=>{const k=kind==='devTask'?'dependsOn':'milestoneId';if(t[k]===id){const prev=clone(t);t[k]='';stamp(t,prev);}});
    log('delete',id,'删除开发记录');
    try {save();}catch(e){applyState(before);throw e;}
  }
  function devRestore(kind,id) {
    const at=TRASH.findIndex(r=>r.kind===kind&&r.id===id);if(at<0)return;
    const before=clone(collectLocal()),r=clone(TRASH[at]);
    delete r.kind;delete r.deletedAt;delete r.deletedBy;
    r._restoredAt=Math.max(tick(),(DELETED[kind+'|'+id]?.at||0)+1);r.updatedAt=r._ut=r._restoredAt;
    if(kind==='devTasks'){if(!DEV.devTasks.some(x=>x.id===r.dependsOn))r.dependsOn='';if(!DEV.devMilestones.some(x=>x.id===r.milestoneId))r.milestoneId='';validateTask(r);}
    DEV[kind].push(r);TRASH.splice(at,1);log('restore',id,'恢复开发记录');
    try {save();}catch(e){applyState(before);throw e;}
  }
  function startTime(projectId,category,note) {
    if(DEV.devTimes.some(r=>r.owner===CONFIG.me&&r.startedAt&&!r.endedAt))throw Error('你已有计时，请先停止；其他成员可以各自计时');
    return devSave('devTime',{projectId,category,note,owner:CONFIG.me,date:dstr(now()),startedAt:now(),endedAt:0,minutes:0});
  }
  function stopTime(id,end=now()) {
    const r=DEV.devTimes.find(r=>r.id===id);if(!r||!r.startedAt||r.endedAt)throw Error('计时已停止或被删除，请刷新查看');
    if(end<r.startedAt)throw Error('系统时间早于开始时间');
    const before=clone(collectLocal());let start=r.startedAt,index=0;const segments=[];
    while(start<end){const d=new Date(start);d.setHours(24,0,0,0);const finish=Math.min(+d,end);segments.push({...clone(r),id:index++?id+'@'+dstr(start):id,date:dstr(start),startedAt:start,endedAt:finish,minutes:(finish-start)/60000,sessionId:id,sessionStartedAt:r.startedAt,sessionEndedAt:end});start=finish;}
    if(!segments.length)segments.push({...clone(r),endedAt:end,minutes:0,sessionId:id,sessionStartedAt:r.startedAt,sessionEndedAt:end});
    DEV.devTimes=DEV.devTimes.filter(x=>x.id!==id).concat(segments.map(s=>stamp(s,s.id===id?r:null)));log('edit',id,'停止计时 · 按天保存');
    try{save();}catch(e){applyState(before);throw e;}
    return segments;
  }
  const DevData={KEYS:DEV_KEYS,DEV_SCHEMA,devAll:devRows,devSave,devRemove,devStartTime:startTime,devStopTime:stopTime,today:()=>dstr(now()),shift:(s,n)=>{const d=new Date(s+'T12:00:00');d.setDate(d.getDate()+n);return dstr(+d);},weekCn:s=>'日一二三四五六'[new Date(s+'T12:00:00').getDay()],devTimeSummary:(p,a,b,member)=>({minutes:DEV.devTimes.filter(r=>r.projectId===p&&(!r.startedAt||r.endedAt)&&r.date>=a&&r.date<=b&&(!member||r.owner===member)).reduce((n,r)=>n+r.minutes,0)})};
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
    DevModal.openModal({title:'团队讨论 · '+(record.title||record.name||record.date),html:'<div class="disc">'+(DISCUSS[id]||[]).map(m=>'<p><b>'+esc(roleOf(m.u).n)+'</b> · '+esc(dstr(m.t))+' '+fmtT(m.t)+'</p><p style="white-space:pre-wrap">'+esc(m.x)+'</p>').join('')+'</div><form id="dev-disc-form" class="gd-form"><label class="gd-field gd-full"><span>发送给团队</span><textarea name="discussion" maxlength="20000">'+esc(localDrafts[key]||'')+'</textarea></label><button class="btn pri" type="submit">发送</button></form>',mount:body=>{
      const form=body.querySelector('form'),input=form.querySelector('textarea');input.oninput=()=>{try{localDrafts[key]=input.value;saveDrafts();}catch(e){toast('草稿保存失败','warn');}};
      form.onsubmit=e=>{e.preventDefault();if(!input.value.trim())return;const before=clone(collectLocal());(DISCUSS[id]=DISCUSS[id]||[]).push({u:CONFIG.me,t:tick(),x:input.value.trim()});log('discuss',id,'开发记录讨论');try{save();delete localDrafts[key];try{saveDrafts();}catch(e){}DevModal.closeModal();render();toast('已发送到本机，等待同步');}catch(e){applyState(before);toast(e.message,'warn');}};
    }});
  }
  const DevModal={toast:msg=>toast(msg,'warn'),closeModal:()=>closeModal('genericModal'),openModal(opt){
    if(modalOptions?.beforeClose&&!modalOptions.beforeClose())return;
    const modalBody=root.querySelector('#gmBody');modalBody.onclick=null;modalBody.oninput=null;modalOptions=opt;root.querySelector('#gmTitle').textContent=opt.title;root.querySelector('#gmBody').innerHTML=(opt.sub?'<p class="gd-note">'+opt.sub+'</p>':'')+opt.html;root.querySelector('#gmFoot').innerHTML='';openModal('genericModal');opt.mount?.(root.querySelector('#gmBody'));hydrateImages(root.querySelector('#gmBody'));
  }};

const D = DevData;
const I={get:k=>'<span aria-hidden="true">'+({gamepad:'🎮',plus:'＋',target:'◎',grid:'▦',shield:'◇',edit:'✎',clock:'◷',inbox:'▣',search:'⌕',todo:'☷'}[k]||'')+'</span>'};
const App=DevModal;
const TABS = [
  ['devMilestone','里程碑','target'],['devTask','任务看板','grid'],['devBug','BUG 追踪','shield'],
  ['devLog','开发日志','edit'],['devTime','工时统计','clock'],['devAsset','资产流程','inbox']
];
const LABELS = {
  active:'进行中',paused:'暂停',released:'已发布',archived:'已归档',planned:'未开始',done:'已完成',
  backlog:'待开发',doing:'开发中',review:'待验收',open:'待处理',fixing:'修复中',verify:'待验证',closed:'已关闭',
  high:'高',mid:'中',low:'低',critical:'阻断',medium:'一般'
};
const STAGES = {design:'设计确认',build:'制作完成',uv:'UV 完成',material:'材质完成',collision:'碰撞完成',lod:'LOD 完成',engine:'UE 入库'};
const WORKFLOWS = {
  '模型':['design','build','uv','material','collision','lod','engine'],
  '场景':['design','build','material','collision','engine'],
  '材质':['design','build','engine'],'动画':['design','build','engine'],'特效':['design','build','engine'],
  'HDA':['design','build','engine'],'音频':['design','build','engine'],'其他':['design','build','engine']
};
const NEW_LABELS = {devMilestone:'新建里程碑',devTask:'新建任务',devBug:'记录 BUG',devLog:'写开发日志',devTime:'补录工时',devAsset:'新建资产'};
const EDIT_LABELS = {devMilestone:'编辑里程碑',devTask:'编辑任务',devBug:'编辑 BUG',devLog:'编辑开发日志',devTime:'编辑工时',devAsset:'编辑资产'};
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
function hours(minutes) {return minutes>0&&minutes<.6?'不足 1 分钟':(minutes/60).toLocaleString('zh-CN',{maximumFractionDigits:2})+' h';}
function clock(ms) {
  const sec=Math.max(0,Math.floor(ms/1000));
  return [Math.floor(sec/3600),Math.floor(sec/60)%60,sec%60].map(function(n){return String(n).padStart(2,'0');}).join(':');
}
function badge(value) {return '<span class="gd-badge gd-badge--'+esc(value)+'">'+esc(LABELS[value] || value)+'</span>';}
function dateHint(date,done) {
  if(!date)return '';
  return '<span class="gd-due'+(!done&&date<D.today()?' is-overdue':'')+'">'+esc(date)+(!done&&date<D.today()?' · 已逾期':'')+'</span>';
}
function details(label,text) {
  return text?'<div class="gd-detail"><span>'+esc(label)+'</span><p>'+esc(text)+'</p></div>':'';
}
function assetProgress(r) {
  const stages=WORKFLOWS[r.type] || WORKFLOWS['其他'];
  const count=stages.filter(function(k){return !!r.checks[k];}).length;
  return {stages:stages,count:count,total:stages.length,percent:Math.round(count/stages.length*100)};
}
function actions(kind,id,extra) {
  return '<div class="gd-actions">'+(extra || '')+'<button class="btn btn-sm" data-gd-disc="'+kind+'" data-id="'+esc(id)+'">讨论</button><button class="btn btn-sm" data-gd-history="'+esc(id)+'">历史</button><span class="gd-meta">'+esc(roleOf(D.devAll(kind).find(r=>r.id===id)?.owner).n)+' · 记录人 '+esc(roleOf(D.devAll(kind).find(r=>r.id===id)?.recorder).n)+'</span><button class="btn btn-sm" data-gd-edit="'+kind+'" data-id="'+esc(id)+'">编辑</button><button class="btn btn-ghost btn-sm" data-gd-delete="'+kind+'" data-id="'+esc(id)+'">删除</button></div>';
}

const GameDev = {
  key:'gamedev',title:'游戏开发',icon:'gamepad',_tab:'devMilestone',_project:'',_query:'',_filter:'',_box:null,_clock:null,_member:'',
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
    const tasks=all('devTask'),bugs=all('devBug'),assets=all('devAsset');
    const running=D.devAll('devTime').filter(r=>r.startedAt&&!r.endedAt);
    const timerNotice=tab!=='devTime'&&running.length?'<div class="gd-running-notice"><span>工作计时正在进行'+(running.length>1?'（'+running.length+' 段）':'')+' · <strong data-gd-clock="'+running[0].startedAt+'">'+clock(Date.now()-running[0].startedAt)+'</strong></span><button class="btn btn-sm" data-gd-tab="devTime">查看计时</button></div>':'';
    const summary=id?D.devTimeSummary(id,D.shift(D.today(),-6),D.today()):{minutes:0};
    const title='<div class="gd-heading"><div><div class="gd-eyebrow">UE / HOUDINI · 三人共享开发工作区</div><h2>一起把作品做出来</h2><p>计划、制作、验证与复盘，都围绕同一个项目。</p></div><button class="btn" data-gd-projects>'+I.get('gamepad')+'项目管理</button></div>';
    const picker='<div class="gd-project-bar"><label for="gd-project">当前项目</label><select class="input" id="gd-project" data-no-draft>'+optionList(projects.map(r=>[r.id,r.name+(r.status==='archived'?'（已归档）':'')]),id,projects.length?'':'还没有项目')+'</select><button class="btn btn-primary" data-gd-new-project>'+I.get('plus')+'新建项目</button></div>';
    const info=p?'<section class="gd-project-card"><div class="gd-project-top"><div><h3>'+esc(p.name)+'</h3><div class="gd-meta">'+badge(p.status)+'<span>'+esc(p.engine || '未设置工具')+'</span>'+dateHint(p.targetDate,p.status==='released')+'</div></div><button class="btn btn-sm" data-gd-edit="devProject" data-id="'+esc(p.id)+'">编辑项目</button></div>'+(p.description?'<p class="gd-project-desc">'+esc(p.description)+'</p>':'')+'<div class="gd-kpis">'+[
      ['待完成任务',tasks.filter(r=>r.status!=='done').length+'','todo'],['待关闭 BUG',bugs.filter(r=>r.status!=='closed').length+'','shield'],
      ['近 7 天工时',hours(summary.minutes),'clock'],['资产就绪',assets.filter(r=>assetProgress(r).percent===100).length+' / '+assets.length,'inbox']
    ].map(function(k){return '<div class="gd-kpi"><span>'+I.get(k[2])+esc(k[0])+'</span><strong>'+esc(k[1])+'</strong></div>';}).join('')+'</div>'+this.resourcePanel(p)+'</section>':'';
    const tabs='<div class="gd-tabs" role="tablist" aria-label="开发功能">'+TABS.map(function(t){return '<button role="tab" tabindex="'+(tab===t[0]?'0':'-1')+'" aria-selected="'+(tab===t[0])+'" class="gd-tab'+(tab===t[0]?' on':'')+'" data-gd-tab="'+t[0]+'">'+I.get(t[2])+'<span>'+t[1]+'</span><small>'+all(t[0]).length+'</small></button>';}).join('')+'</div>';
    if(!p)return title+picker+tabs+'<div class="gd-empty gd-welcome"><span class="gd-empty-icon">'+I.get('gamepad')+'</span><h3>先给你的作品建一个项目</h3><p>填写名称和目标，就能开始拆分里程碑、安排任务和记录开发。</p><button class="btn btn-primary" data-gd-new-project>创建第一个项目</button></div>';
    const toolbar='<div class="gd-toolbar"><div class="gd-search"><span>'+I.get('search')+'</span><input id="gd-search" class="input" aria-label="搜索当前功能" placeholder="搜索'+TABS.find(t=>t[0]===tab)[1]+'…" value="'+esc(this._query)+'"></div>'+this.filterSelect()+'<select id="gd-member" class="input" aria-label="筛选成员">'+optionList(Object.entries(ROLE).map(([id,r])=>[id,r.n]),this._member,'全部成员')+'</select><button class="btn btn-primary" data-gd-new="'+tab+'">'+I.get('plus')+NEW_LABELS[tab]+'</button></div>';
    const rows=all(tab).filter(r=>this.matches(r));
    let body='';
    if(tab==='devMilestone')body=this.milestones(rows,tasks);
    if(tab==='devTask')body=this.tasks(rows,tasks,all('devMilestone'));
    if(tab==='devBug')body=this.bugs(rows);
    if(tab==='devLog')body=this.logs(rows);
    if(tab==='devTime')body=this.times(rows,id);
    if(tab==='devAsset')body=this.assets(rows);
    return title+picker+info+timerNotice+tabs+toolbar+'<section class="gd-content" role="tabpanel" aria-label="'+TABS.find(t=>t[0]===tab)[1]+'">'+body+'</section>';
  },
  filterSelect:function() {
    let choices=[];
    if(this._tab==='devAsset')choices=[['pending','制作中'],['ready','已就绪']];
    else if(this._tab==='devTime')choices=[['today','今天'],['week','近 7 天'],['month','本月']];
    else choices=(D.DEV_SCHEMA[D.KEYS[this._tab]].choices.status || []).map(v=>[v,LABELS[v]]);
    return choices.length?'<select id="gd-filter" class="input" aria-label="筛选记录" data-no-draft>'+optionList(choices,this._filter,'全部')+'</select>':'';
  },
  matches:function(r) {
    if(this._member&&r.owner!==this._member)return false;
    if(this._query&&Object.keys(r).filter(k=>typeof r[k]==='string').map(k=>r[k]).join(' ').toLowerCase().indexOf(this._query.toLowerCase())<0)return false;
    const f=this._filter;
    if(!f)return true;
    if(this._tab==='devAsset')return (assetProgress(r).percent===100)===(f==='ready');
    if(this._tab==='devTime')return r.date<=D.today()&&r.date>=(f==='today'?D.today():f==='week'?D.shift(D.today(),-6):D.today().slice(0,7)+'-01');
    return r.status===f;
  },
  empty:function(text) {return '<div class="gd-empty"><h3>'+esc(text || '这里还没有记录')+'</h3><p>'+(this._query||this._filter?'可以调整搜索或筛选条件。':'点击右上方按钮，开始记录这个项目。')+'</p></div>';},
  milestones:function(rows,tasks) {
    if(!rows.length)return this.empty('把目标拆成可交付的里程碑');
    return '<div class="gd-card-grid">'+rows.slice().sort((a,b)=>(a.dueDate || '9999').localeCompare(b.dueDate || '9999')).map(function(r){
      const linked=tasks.filter(t=>t.milestoneId===r.id),done=linked.filter(t=>t.status==='done').length,pct=linked.length?Math.round(done/linked.length*100):r.status==='done'?100:0;
      return '<article class="gd-card"><div class="gd-card-head">'+badge(r.status)+dateHint(r.dueDate,r.status==='done')+'</div><h3>'+esc(r.title)+'</h3>'+details('目标',r.description)+details('交付 / 验收标准',r.acceptance)+'<div class="gd-progress"><i style="width:'+pct+'%"></i></div><div class="gd-meta">关联任务 '+done+' / '+linked.length+' · '+pct+'%</div>'+actions('devMilestone',r.id)+'</article>';
    }).join('')+'</div>';
  },
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
    if(!items.length && !notes.length && !p.notice)return '';
    return '<div class="gd-res">'
      + (items.length ? '<div class="gd-res-grid">' + items.map(function(it){
          return '<div class="gd-res-i"><span class="gd-res-ic">' + esc(it.ic) + '</span><span class="gd-res-tx"><b>' + esc(it.lb) + (it.sub ? '　·　' + esc(it.sub) : '') + '</b><i>' + esc(it.vl) + '</i></span></div>';
        }).join('') + '</div>' : '')
      + (notes.length ? '<div class="gd-res-notes"><b>⚠️ 注意事项</b><ul>' + notes.map(function(n){return '<li>' + esc(n) + '</li>';}).join('') + '</ul></div>' : '')
      + (p.notice ? '<div class="gd-res-notice"><b>📢 公告</b><span>' + esc(p.notice) + '</span></div>' : '')
      + '</div>';
  },
  tasks:function(rows,all,milestones) {
    const statuses=D.DEV_SCHEMA.devTasks.choices.status;
    return '<div class="gd-board">'+statuses.map(function(status){
      const items=rows.filter(r=>r.status===status).sort(function(a,b){
        const ao=(a.order==null?9999:a.order),bo=(b.order==null?9999:b.order);
        if(ao!==bo)return ao-bo;
        return ['high','mid','low'].indexOf(a.priority)-['high','mid','low'].indexOf(b.priority);
      });
      return '<section class="gd-column" data-gd-col="'+esc(status)+'"><div class="gd-column-title"><h3>'+LABELS[status]+'</h3><span>'+items.length+'</span></div>'+items.map(function(r){
        const dep=all.find(t=>t.id===r.dependsOn),milestone=milestones.find(m=>m.id===r.milestoneId),next=statuses[statuses.indexOf(status)+1];
        const ownerName=(ROLE[r.owner] || ROLE[CONFIG.me] || {n:'未指派'}).n;
        const chips='<div class="gd-task-chips">'+(r.stage?'<span class="gd-chip">'+esc(r.stage)+'</span>':'')+String(r.soft || '').split(/[,，;；\s]+/).filter(Boolean).map(function(s){return '<span class="gd-soft"><u>'+esc(({Houdini:'H',UE:'U',Blender:'B'})[s] || s.charAt(0))+'</u>'+esc(s)+'</span>';}).join('')+'</div>';
        return '<article class="gd-task" draggable="true" data-gd-task="'+esc(r.id)+'"><div class="gd-meta">'+badge(r.priority)+'<span>'+esc(r.category)+'</span><button type="button" class="gd-owner" data-gd-owner="'+esc(r.id)+'" title="点击更换负责人">'+esc(ownerName)+' ▾</button></div><h4>'+esc(r.title)+'</h4>'+chips+dateHint(r.dueDate,status==='done')+(r.path?'<div class="gd-path" title="'+esc(r.path)+'">'+esc(r.path)+'</div>':'')+(milestone?'<div class="gd-meta">里程碑 · '+esc(milestone.title)+'</div>':'')+(dep?'<div class="gd-dependency'+(dep.status!=='done'?' is-blocked':'')+'">前置 · '+esc(dep.title)+(dep.status==='done'?'（完成）':'（未完成）')+'</div>':'')+(r.description||r.acceptance?'<details class="gd-expand"><summary>任务说明 / 验收</summary>'+details('说明',r.description)+details('验收',r.acceptance)+'</details>':'')+actions('devTask',r.id,next?'<button class="btn btn-sm" data-gd-advance="devTask" data-id="'+esc(r.id)+'">'+(next==='done'?'完成验收':'移至'+LABELS[next])+'</button>':'')+'</article>';
      }).join('')+(!items.length?'<div class="gd-column-empty">暂无任务</div>':'')+'</section>';
    }).join('')+'</div>';
  },
  bugs:function(rows) {
    if(!rows.length)return this.empty('让问题都有复现步骤和处理结果');
    const statuses=D.DEV_SCHEMA.devBugs.choices.status;
    return '<div class="gd-card-grid">'+rows.slice().sort((a,b)=>['critical','high','medium','low'].indexOf(a.severity)-['critical','high','medium','low'].indexOf(b.severity)).map(function(r){
      const next=statuses[statuses.indexOf(r.status)+1];
      return '<article class="gd-card"><div class="gd-meta">'+badge(r.status)+badge(r.severity)+'</div><h3>'+esc(r.title)+'</h3>'+details('环境 / 版本',r.environment)+'<details class="gd-expand"><summary>复现与处理详情</summary>'+details('复现步骤',r.steps)+details('预期结果',r.expected)+details('实际结果',r.actual)+details('修复与验证',r.solution)+'</details>'+(r.images&&r.images.length?'<div class="gd-screenshots">'+r.images.map(function(src,i){return '<button data-gd-image="'+esc(r.id)+'" data-index="'+i+'" aria-label="查看 BUG 截图 '+(i+1)+'">'+thumb(src,'BUG 截图 '+(i+1))+'</button>';}).join('')+'</div>':'')+actions('devBug',r.id,next?'<button class="btn btn-sm" data-gd-advance="devBug" data-id="'+esc(r.id)+'">移至'+LABELS[next]+'</button>':'')+'</article>';
    }).join('')+'</div>';
  },
  logs:function(rows) {
    if(!rows.length)return this.empty('给明天的自己留下一个明确的起点');
    return '<div class="gd-log-list">'+rows.slice().sort((a,b)=>b.date.localeCompare(a.date)||b._ut-a._ut).map(function(r){return '<article class="gd-card gd-log"><div class="gd-log-date"><strong>'+esc(r.date)+'</strong><span>星期'+esc(D.weekCn(r.date))+'</span></div><div class="gd-log-body">'+details('完成 / 进展',r.done)+details('遇到的阻碍',r.blockers)+details('下次继续',r.next)+actions('devLog',r.id)+'</div></article>';}).join('')+'</div>';
  },
  times:function(rows,projectId) {
    const active=D.devAll('devTime').filter(r=>r.startedAt&&!r.endedAt&&(!this._member||r.owner===this._member));
    const projects=D.devAll('devProject'),today=D.devTimeSummary(projectId,D.today(),D.today(),this._member),week=D.devTimeSummary(projectId,D.shift(D.today(),-6),D.today(),this._member);
    const saved=rows.filter(r=>!r.startedAt||r.endedAt),total=saved.reduce((n,r)=>n+r.minutes,0),categories={};
    saved.forEach(r=>categories[r.category]=(categories[r.category] || 0)+r.minutes);
    const timer='<div class="gd-timer"><button class="btn" data-gd-start>开始我的计时</button>'+(active.length?active.map(function(r){const p=projects.find(p=>p.id===r.projectId);return '<div class="gd-timer-active"><div><span class="gd-eyebrow">正在计时 · '+esc(roleOf(r.owner).n)+' · '+esc(p?p.name:'未找到项目')+' · '+esc(r.category)+'</span><strong data-gd-clock="'+r.startedAt+'">'+clock(Date.now()-r.startedAt)+'</strong><p>'+esc(r.note || '专注于当前工作')+'</p></div><div class="gd-timer-buttons"><button class="btn btn-primary" data-gd-stop="'+esc(r.id)+'">停止并保存工时</button><button class="btn btn-sm" data-gd-delete="devTime" data-id="'+esc(r.id)+'">舍弃本次</button></div></div>';}).join(''):'<div><h3>开始一段专注开发</h3><p>选好工作类型，结束时记录实际耗时。</p><button class="btn btn-primary" data-gd-start>开始计时</button></div>')+'<small>计时跨页面、刷新后仍保留；关闭页面期间也会继续累计，离开工作前请停止。统计包含已保存工时，跨日计时按天拆分。</small></div>';
    const stats='<div class="gd-time-stats"><div><span>今天</span><strong>'+hours(today.minutes)+'</strong></div><div><span>近 7 天</span><strong>'+hours(week.minutes)+'</strong></div><div><span>当前筛选合计</span><strong>'+hours(total)+'</strong></div></div>';
    const bars=Object.keys(categories).length?'<div class="gd-time-bars">'+Object.keys(categories).map(function(k){return '<div><span>'+esc(k)+'</span><div class="gd-progress"><i style="width:'+(total?categories[k]/total*100:0)+'%"></i></div><strong>'+hours(categories[k])+'</strong></div>';}).join('')+'</div>':'';
    const list=saved.length?'<div class="gd-time-list">'+saved.slice().sort((a,b)=>b.date.localeCompare(a.date)||b._ut-a._ut).map(r=>'<article class="gd-time-row"><div><strong>'+esc(r.date)+'</strong><span>'+esc(r.category)+'</span></div><p>'+esc(r.note || '未填写说明')+'</p><strong>'+hours(r.minutes)+'</strong>'+actions('devTime',r.id)+'</article>').join('')+'</div>':this.empty('还没有符合条件的已保存工时');
    const members='<div class="gd-time-bars"><h3>成员工时 · 当前项目与日期筛选</h3>'+Object.entries(ROLE).map(([id,m])=>'<div><span>'+esc(m.n)+'</span><strong>'+hours(saved.filter(r=>r.owner===id).reduce((n,r)=>n+r.minutes,0))+'</strong></div>').join('')+'</div>';
    return timer+stats+members+bars+list;
  },
  assets:function(rows) {
    if(!rows.length)return this.empty('把资产从设计跟踪到 UE 入库');
    return '<div class="gd-card-grid">'+rows.map(function(r){
      const progress=assetProgress(r);
      return '<article class="gd-card"><div class="gd-card-head"><span class="gd-badge">'+esc(r.type)+'</span>'+dateHint(r.dueDate,progress.percent===100)+'</div><h3>'+esc(r.name)+'</h3><div class="gd-meta">'+(progress.percent===100?'已就绪':'制作中')+' · '+progress.count+' / '+progress.total+'</div><div class="gd-progress"><i style="width:'+progress.percent+'%"></i></div><div class="gd-checks">'+progress.stages.map(function(k){return '<label><input type="checkbox" data-gd-check="'+esc(r.id)+'" data-stage="'+k+'" '+(r.checks[k]?'checked':'')+' data-no-draft><span>'+STAGES[k]+'</span></label>';}).join('')+'</div>'+details('文件 / 资源路径',r.path)+details('备注',r.note)+actions('devAsset',r.id)+'</article>';
    }).join('')+'</div>';
  },
  bind:function(box) {
    const self=this;
    if(this._clock)clearInterval(this._clock);
    this._clock=setInterval(function(){if(!box.isConnected){clearInterval(self._clock);self._clock=null;return;}box.querySelectorAll('[data-gd-clock]').forEach(el=>{el.textContent=clock(Date.now()-Number(el.dataset.gdClock));});},1000);
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
      if(e.target.matches('[data-gd-check]')){
        const r=D.devAll('devAsset').find(r=>r.id===e.target.dataset.gdCheck);
        if(!r)return;
        try{D.devSave('devAsset',{checks:Object.assign({},r.checks,{[e.target.dataset.stage]:e.target.checked})},r.id);self.repaint();}
        catch(err){e.target.checked=!e.target.checked;App.toast(err.message,7000);}
      }
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
      const ow=e.target.closest('[data-gd-owner]');
      if(ow){
        const oid=ow.dataset.gdOwner,cur=D.devAll('devTask').find(function(x){return x.id===oid;});
        App.openModal({title:'更换负责人',sub:'指派给谁，谁就能在「筛选成员」里看到这张卡。',width:420,html:'<div class="gd-owner-pick">'+Object.entries(ROLE).map(function(p){return '<button type="button" class="btn'+(cur&&cur.owner===p[0]?' btn-primary':'')+'" data-gd-setowner="'+esc(p[0])+'">'+esc(p[1].n)+' · '+esc(p[1].r)+'</button>';}).join(' ')+'</div>',mount:function(mb){mb.onclick=function(ev){const btn=ev.target.closest('[data-gd-setowner]');if(!btn)return;try{D.devSave('devTask',{owner:btn.dataset.gdSetowner},oid);App.closeModal();self.repaint();App.toast('已指派给 '+ROLE[btn.dataset.gdSetowner].n);}catch(err){App.toast(err.message,7000);}};}});
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
      if(e.target.closest('[data-gd-start]')){self.startEditor();return;}
      const stop=e.target.closest('[data-gd-stop]');
      if(stop){try{D.devStopTime(stop.dataset.gdStop);self.repaint();App.toast('工时已保存');}catch(err){App.toast(err.message,7000);}return;}
      const img=e.target.closest('[data-gd-image]');
      if(img){const r=D.devAll('devBug').find(r=>r.id===img.dataset.gdImage);if(r&&r.images[+img.dataset.index])App.openModal({title:r.title,width:900,html:thumb(r.images[+img.dataset.index],'BUG 截图').replace('<img ','<img class="gd-image-full" ')});}
    });
  },
  chooseTab:function(key) {
    this._tab=key;this.resetFilters();
    this.repaint().then(()=>{const tab=this._box.querySelector('[role=tab][data-gd-tab="'+key+'"]');if(tab)tab.focus({preventScroll:true});});
  },
  resetFilters:function() {
    this._query='';this._filter='';
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
    const discard=kind==='devTime'&&r.startedAt&&!r.endedAt;
    const sub=discard?'本次计时将停止，不计入工时统计。':(kind==='devMilestone'||kind==='devTask'?'删除后会解除相关任务的关联。':'删除后可以在团队回收站恢复。');
    askConfirm({title:discard?'舍弃本次计时？':'删除这条记录？',msg:sub+' 删除会同步到团队，记录可以在回收站恢复。',ok:'确认删除',danger:true,then:yes=>{if(!yes)return;try{D.devRemove(kind,id);self.repaint();App.toast('已移入回收站');}catch(err){App.toast(err.message);}}});
  },
  startEditor:function() {
    const self=this,p=this.project();if(!p)return;
    App.openModal({title:'开始开发计时',sub:esc(p.name),width:480,html:'<form id="gd-timer-form" class="gd-form">'+select('category','工作类型',D.DEV_SCHEMA.devTimes.choices.category,'程序')+area('note','这段时间做什么','','例如：优化程序化岩石 HDA')+'<button class="btn btn-primary gd-full" type="submit">开始计时</button></form>',mount:function(body){body.querySelector('form').onsubmit=function(e){e.preventDefault();try{D.devStartTime(p.id,body.querySelector('[name=category]').value,body.querySelector('[name=note]').value.trim());App.closeModal();self.repaint();}catch(err){App.toast(err.message,7000);}};}});
  },
  openEditor:function(kind,id) {
    const self=this,p=this.project(),r=id?D.devAll(kind).find(r=>r.id===id):{};
    if(!r){App.toast('记录已被删除');return;}
    if(kind!=='devProject'&&!p){App.toast('请先创建项目');return;}
    if(kind==='devTime'&&r.startedAt&&!r.endedAt){App.toast('请先停止计时，再编辑工时');return;}
    const schema=D.DEV_SCHEMA[D.KEYS[kind]];
    let html='';
    if(kind==='devProject')html=field('name','项目名称',r.name,'text','required maxlength="200"')+field('engine','开发工具 / 版本',r.engine || 'UE / Houdini','text','maxlength="200"')+select('status','项目状态',schema.choices.status,r.status || 'active')+field('targetDate','目标交付日期',r.targetDate,'date')+area('description','项目简介 / 范围',r.description,'描述核心玩法、目标平台和当前版本范围')+field('rootPath','工程总路径',r.rootPath,'text','maxlength="300" placeholder="/Game/HuoDong/"')+area('resources','资源链接（一行一条）',r.resources,'格式：图标 名称 | 地址 | 备注　例：📊 排期表 | https://… | 日韩素材排期总表')+area('notes','注意事项（一行一条）',r.notes,'长期有效的规矩　例：Houdini 导出前先 Apply Transform、单位统一 cm')+area('notice','公告',r.notice,'会过期的短期提醒　例：本周目标——档案柜三档先跑通普通档');
    if(kind==='devMilestone')html=field('title','里程碑名称',r.title,'text','required maxlength="200"')+select('status','状态',schema.choices.status,r.status || 'planned')+field('dueDate','截止日期',r.dueDate,'date')+area('description','目标',r.description,'例如：完成可试玩的 10 分钟核心循环')+area('acceptance','交付 / 验收标准',r.acceptance,'明确做到什么程度算完成');
    if(kind==='devTask'){
      const milestones=D.devAll('devMilestone',p.id),tasks=D.devAll('devTask',p.id).filter(t=>t.id!==id);
      html=field('title','任务名称',r.title,'text','required maxlength="200"')+select('status','状态',schema.choices.status,r.status || 'backlog')+select('category','工作分类',schema.choices.category,r.category || '程序')+select('priority','优先级',schema.choices.priority,r.priority || 'mid')+field('dueDate','截止日期',r.dueDate,'date')+select('milestoneId','所属里程碑',milestones.map(m=>[m.id,m.title]),r.milestoneId,'不关联')+select('dependsOn','前置任务',tasks.map(t=>[t.id,t.title]),r.dependsOn,'无前置任务')+area('description','任务说明',r.description)+area('acceptance','验收标准',r.acceptance,'例如：手柄与键鼠均可完成交互，没有报错')+select('area','分区',[['art','🎨 美术开发'],['prog','💻 程序开发'],['misc','🧩 通用 / 策划']],r.area || 'art')+select('stage','流程阶段',STAGE_LIST,r.stage,'未设置')+field('soft','主要软件',r.soft,'text','maxlength="200" placeholder="Houdini,UE,Blender（逗号分隔）"')+field('path','UE 资源路径',r.path,'text','maxlength="2000" placeholder="/Game/HuoDong/…"');
    }
    if(kind==='devBug')html=field('title','BUG 标题',r.title,'text','required maxlength="200"')+select('status','状态',schema.choices.status,r.status || 'open')+select('severity','严重程度',schema.choices.severity,r.severity || 'medium')+field('environment','环境 / 软件版本',r.environment,'text','maxlength="1000"')+area('steps','复现步骤',r.steps,'1. 打开关卡\n2. 执行操作\n3. 观察结果')+area('expected','预期结果',r.expected)+area('actual','实际结果',r.actual)+area('solution','修复 / 验证记录',r.solution)+'<div class="gd-field gd-full"><span>问题截图（最多 2 张，每张不超过 1 MB）</span><input id="gd-bug-files" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple><div id="gd-bug-previews" class="gd-screenshots"></div><p class="gd-note">截图上传到同一团队私有仓。移除引用保留原文件；本地模拟模式刷新后截图重置。</p></div>';
    if(kind==='devLog')html=field('date','记录日期',r.date || D.today(),'date','required')+area('done','完成 / 进展',r.done,'今天实现了什么？尝试了哪些方案？')+area('blockers','遇到的阻碍',r.blockers,'当前卡在哪里？还需要验证什么？')+area('next','下次继续',r.next,'留下下一次打开项目时的第一步');
    if(kind==='devTime')html=field('date','工作日期',r.date || D.today(),'date','required')+select('category','工作类型',schema.choices.category,r.category || '程序')+field('minutes','耗时（分钟）',r.minutes==null?30:Math.max(.1,Math.round(r.minutes*10)/10),'number','required min="0.1" max="1440" step="0.1"')+area('note','工作说明',r.note)+(r.startedAt?'<p class="gd-note gd-full">编辑后的记录作为手动工时保存，时长精确到 0.1 分钟。</p>':'');
    if(kind==='devAsset')html=field('name','资产名称',r.name,'text','required maxlength="200"')+select('type','资产类型',schema.choices.type,r.type || '模型')+field('dueDate','截止日期',r.dueDate,'date')+field('path','文件 / UE 资源路径',r.path,'text','maxlength="2000"')+area('note','规格 / 备注',r.note,'例如：三角面预算、贴图规格、HDA 输出要求')+'<div class="gd-field gd-full"><span>制作检查清单</span><div id="gd-asset-stages" class="gd-checks"></div><p class="gd-note">检查项目随资产类型调整，保存后也可以在卡片上直接勾选。</p></div>';
    html=select('owner','负责人 / 工时成员',Object.entries(ROLE).map(([id,r])=>[id,r.n]),r.owner||CONFIG.me)+html;
    html='<form id="gd-editor" class="gd-form">'+html+'<div class="gd-form-actions gd-full"><button type="button" class="btn" id="gd-editor-cancel">取消</button><button type="submit" class="btn btn-primary" id="gd-editor-save">'+(id?'保存修改':'创建记录')+'</button></div></form>';
    App.openModal({title:kind==='devProject'?(id?'编辑项目':'新建开发项目'):(id?EDIT_LABELS[kind]:NEW_LABELS[kind]),sub:kind==='devProject'?'项目是六类开发记录的归属。':esc(p.name),width:940,html:html,mount:function(body){
      const form=body.querySelector('form'),draftKey=kind+'|'+(id||p?.id||'new');let images=(r.images || []).slice(),loading=false,checks=Object.assign({},r.checks || {});
      const restored=localDrafts[draftKey];if(restored?.__images)images=restored.__images;if(restored?.__checks)checks=restored.__checks;if(restored){form.querySelectorAll('[name]').forEach(el=>{if(restored[el.name]!==undefined)el.value=restored[el.name];});}
      function persistDraft(){const d={__images:images,__checks:checks};form.querySelectorAll('[name]').forEach(el=>{if(!el.name.startsWith('check-'))d[el.name]=el.value;});try{localDrafts[draftKey]=d;saveDrafts();}catch(err){App.toast('本机草稿保存失败，请保留表单');}}body.oninput=persistDraft;
      body.querySelector('#gd-editor-cancel').onclick=()=>App.closeModal();
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
      if(kind==='devAsset'){
        const node=body.querySelector('#gd-asset-stages'),type=body.querySelector('[name=type]');
        function stages(){node.innerHTML=(WORKFLOWS[type.value] || WORKFLOWS['其他']).map(k=>'<label><input type="checkbox" name="check-'+k+'" '+(checks[k]?'checked':'')+'><span>'+STAGES[k]+'</span></label>').join('');}
        node.onchange=function(e){checks[e.target.name.slice(6)]=e.target.checked;persistDraft();};type.onchange=stages;stages();
      }
      form.onsubmit=function(e){
        e.preventDefault();if(loading)return;
        const payload={};form.querySelectorAll('[name]').forEach(el=>{if(el.name.indexOf('check-')!==0)payload[el.name]=el.value.trim();});
        if(kind!=='devProject')payload.projectId=r.projectId || p.id;
        if(kind==='devLog'&&!payload.done&&!payload.blockers&&!payload.next){App.toast('至少填写一项进展、阻碍或下一步');return;}
        if(kind==='devTime'){payload.minutes=Number(payload.minutes);payload.startedAt=0;payload.endedAt=0;payload.sessionId='';payload.sessionStartedAt=0;payload.sessionEndedAt=0;}
        if(kind==='devBug')payload.images=images;
        if(kind==='devAsset')payload.checks=checks;
        try{if(id){Object.keys(payload).forEach(k=>{if(equal(payload[k],r[k])||(typeof payload[k]==='string'&&!payload[k]&&!r[k]))delete payload[k];});const current=D.devAll(kind).find(x=>x.id===id);if(current)Object.entries(payload).forEach(([field,mine])=>{if(!equal(current[field],r[field])&&!equal(current[field],mine)){const key=D.KEYS[kind]+'|'+id+'|'+field;if(!CONFLICTS.some(c=>c.key===key))CONFLICTS.push({key,kind:D.KEYS[kind],id,field,mine,theirs:current[field],by:current.updatedBy,title:current.title||current.name||id});}});}
        const saved=D.devSave(kind,payload,id);delete localDrafts[draftKey];try{saveDrafts();}catch(e){toast('记录已保存，草稿清理失败','warn');}modalOptions=null;if(kind==='devProject'){self._project=saved.id;self.resetFilters();}App.closeModal();self.repaint();App.toast(id?'修改已保存':'记录已创建');}
        catch(err){App.toast(err.message,8000);}
      };
      const first=form.querySelector('input,textarea,select');if(first)first.focus({preventScroll:true});
    }});
  }
};



  function render(){
    if(!root)return;
    if(MODE==='legacy'){if(GameDev._clock)clearInterval(GameDev._clock);renderLegacy();return;}
    root.querySelector('.t-root').dataset.th=curTheme();
    const surf=root.querySelector('.surface'),active=root.activeElement,search=active?.id==='gd-search',pos=active?.selectionStart;
    surf.innerHTML='<div class="top"><div class="brand">🎮 UE 团队开发 <small>'+VERSION+'</small></div><div class="spacer"></div><label>我是谁 <select id="devMe">'+Object.entries(ROLE).map(([k,r])=>'<option value="'+esc(k)+'" '+(k===CONFIG.me?'selected':'')+'>'+esc(r.n)+'</option>').join('')+'</select></label><button class="gb" id="legacyMode">旧看板 · '+DATA.length+'</button><button class="gb" id="devTrash">回收站</button><button class="gb" id="devLogHistory">团队历史</button><button class="gb" id="devSync">同步设置</button><button class="syncdot" id="devPull"><i></i><span class="stxt"></span></button></div>'+conflictBanner()+'<div class="gd-root">'+GameDev.body()+'</div>';
    GameDev._box=surf.querySelector('.gd-root');GameDev.bind(GameDev._box);hydrateImages();
    root.querySelector('#legacyMode').onclick=()=>{MODE='legacy';render();};root.querySelector('#devTrash').onclick=showDevTrash;root.querySelector('#devLogHistory').onclick=showReplay;root.querySelector('#devSync').onclick=showSyncPanel;root.querySelector('#devPull').onclick=()=>pull();
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
    return { ...EXTRA, DATA:DATA.map(r=>({...r,draft:null})), TRASH:TRASH.map(r=>({...r,draft:null})), LOG, DISCUSS, COLUMNS, ...DEV, DELETED, _schema:2, _ts:now(), _by:CONFIG.me, _v:VERSION };
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
    EXTRA=Object.fromEntries(Object.entries(s).filter(([k])=>!['DATA','TRASH','LOG','DISCUSS','COLUMNS','DELETED','_localConflicts',...Object.values(DEV_KEYS),'_ts','_by','_v','_schema'].includes(k)));
    Object.values(DEV_KEYS).forEach(k=>{DEV[k]=Array.isArray(s[k])?clone(s[k]):[];});
    DELETED=clone(s.DELETED||{});
    monotonic=sharedKeys.reduce((max,k)=>(s[k]||[]).reduce((n,r)=>Math.max(n,r.updatedAt||0,...Object.values(r._fields||{}).map(f=>f.t||0)),max),monotonic);
    monotonic=Object.values(DELETED).reduce((n,t)=>Math.max(n,t.at||0),monotonic);
    if (s.DATA) DATA = clone(s.DATA);
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
        return data[k].some(r=>!r||typeof r.id!=='string'||(['devLogs','devTimes'].includes(k)&&typeof r.date!=='string')||(k==='devAssets'&&(!r.checks||typeof r.checks!=='object')));
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
    const dot = root.querySelector('.syncdot'); if (!dot) return;
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
  function save() {const s=stampAll(normalizeSessions(collectLocal()));applyState(s);saveLocal(s);if(!CONFLICTS.length)scheduleSync();}

  async function pull(silent) {
    const ch=CONFIG.channel;
    if(ch.type==='local'){setDot('warn','本地模式 · 未接云端');return;}
    if(!ch.token){setDot('warn','未配 token · 仅本地');return;}
    if(syncing||curCard||root?.querySelector('.modal.show form'))return;
    syncing=true;if(!silent)setDot('busy','拉取中…');
    try{
      const cur=await ghGet();
      if(!cur.data){setDot('warn','未找到数据库 · 检查仓库或权限');return;}
      const merged=computeMerge(collectLocal(),cur.data);applyState(merged);cacheBase(cur.data);saveLocal();render();
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
.gd-heading { display:flex;align-items:center;justify-content:space-between;gap:20px;margin:4px 0 22px; }
.gd-heading h2 { font-size:26px;letter-spacing:-.03em;margin:6px 0;line-height:1.35; }
.gd-heading p,.gd-timer p { font-size:13px;color:var(--muted);line-height:1.8;margin:0; }
.gd-eyebrow { font-size:11px;letter-spacing:.08em;color:var(--brand-ink);font-weight:600; }
.gd-heading .btn,.gd-project-bar .btn,.gd-toolbar .btn { display:inline-flex;gap:7px;align-items:center;white-space:nowrap; }
.gd-project-bar { display:flex;align-items:center;gap:12px;margin-bottom:16px; }
.gd-project-bar label { color:var(--muted);font-size:13px;flex:none; }
.gd-project-bar select { flex:1;min-width:0;max-width:520px; }
.gd-project-card { border:1px solid var(--line);border-radius:20px;background:linear-gradient(110deg,var(--surface),var(--brand-soft));padding:22px;margin-bottom:22px; }
.gd-project-top,.gd-card-head { display:flex;align-items:flex-start;justify-content:space-between;gap:12px; }
.gd-project-top h3 { font-size:21px;font-weight:650;margin:0 0 10px;overflow-wrap:anywhere; }
.gd-project-top .btn { flex:none; }
.gd-project-desc { color:var(--muted);line-height:1.8;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0;max-width:100ch; }
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
.gd-task { background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:10px; }
.gd-task:last-child { margin-bottom:0; }
.gd-task h4 { font-size:14px;line-height:1.7;font-weight:600;overflow-wrap:anywhere;margin:10px 0 6px; }
.gd-task .gd-actions { gap:4px; }
.gd-task .btn-sm { font-size:11px;padding-inline:8px; }
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
.gd-res-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px; }
.gd-res-i { display:flex;align-items:center;gap:9px;background:var(--card-bg-2);border:1px solid var(--card-border);border-radius:10px;padding:7px 10px;min-width:0; }
.gd-res-ic { width:26px;height:26px;border-radius:8px;background:var(--soft,rgba(102,126,234,.12));display:grid;place-items:center;font-size:13px;flex:0 0 auto; }
.gd-res-tx { min-width:0;display:flex;flex-direction:column; }
.gd-res-tx b { font-size:10.5px;font-weight:500;color:var(--muted); }
.gd-res-tx i { font-style:normal;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
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
.gd-path { font-size:10.5px;color:var(--muted);font-family:ui-monospace,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:2px 0 4px; }
.gd-owner-pick { display:flex;flex-wrap:wrap;gap:8px; }
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
  .gd-heading { align-items:flex-start;gap:12px; }
  .gd-heading h2 { font-size:21px; }
  .gd-heading > .btn { font-size:11px;padding-inline:8px; }
  .gd-heading .gd-eyebrow { font-size:9px; }
  .gd-project-bar { flex-wrap:wrap;gap:8px; }
  .gd-project-bar label { width:100%; }
  .gd-project-card { padding:16px; }
  .gd-project-top h3 { font-size:18px; }
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
  @media(hover:hover) and (pointer:fine){.gd-card:hover,.gd-task:hover{transform:translateY(-2px);border-color:var(--accent)}}
  @media(max-width:700px){.gd-root{padding:12px}.gd-heading{flex-wrap:wrap}.modal .mbox{width:calc(100vw - 16px)}.drawer{width:calc(100vw - 12px);max-width:440px}.cols{grid-template-columns:1fr!important}.gd-toolbar>select{max-width:none}.gb,.btn{min-height:36px}.top .brand small{display:block}}
  @media(prefers-reduced-motion:reduce){*,*:before,*:after{transition:none!important;animation:none!important}.card:hover,.gd-card:hover,.gd-task:hover{transform:none}}
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
     自动同步（2026-10-13 新增）
     ------------------------------------------------------------
     之前只在 mount 时 pull 一次 ⇒ 同事改了卡片，你这边**必须手点「🔄 刷新」**才看得到。
     现在补三层，尽量静默、不打扰、不烧 API 配额：
       ① 每 20 秒轮询一次（页面可见 + 抽屉没开 + 没在同步中 + 距上次>5s）
       ② 切回这个标签页（visibilitychange → visible）立刻拉
       ③ 窗口重新获焦（focus）立刻拉
     ⚠️ 抽屉打开时不拉：编辑中的 curCard 指向旧对象，pull 后 applyState 会换掉 DATA，
        这时保存会把改动写回悬空对象 ⇒ 直接丢数据。
     ⚠️ 轮询用静默模式（pull(true)）：不闪「拉取中…」、失败也不动状态灯。
     配额：20s 一次 ≈ 180 次/小时/标签页，fine-grained token 上限 5000/小时，够用。 */
  let autoTimer = null, lastAuto = 0;
  function autoPull() {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (curCard || root?.querySelector('.modal.show')) return;                              // 正在编辑，别打扰
    if (syncing) return;                              // 已有同步在跑
    if (!CONFIG.channel || CONFIG.channel.type === 'local') return;
    const t = Date.now();
    if (t - lastAuto < 5000) return;                  // 防重入（轮询 + focus 可能撞一起）
    lastAuto = t;
    pull(true);
  }
  function startAutoSync() {
    stopAutoSync();
    autoTimer = setInterval(autoPull, 20000);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', autoPull);
    }
    if (typeof window !== 'undefined') window.addEventListener('focus', autoPull);
  }
  function stopAutoSync() { if(autoTimer){clearInterval(autoTimer);autoTimer=null;} document.removeEventListener('visibilitychange',autoPull);global.removeEventListener?.('focus',autoPull); }
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
  function openModal(cls) {const m=root.querySelector('.'+cls);if(m){modalReturn=root.activeElement;m.classList.add('show');m.setAttribute('role','dialog');m.setAttribute('aria-modal','true');m.setAttribute('aria-label',root.querySelector('#gmTitle')?.textContent||'对话框');setTimeout(()=>m.querySelector('input,button,select,textarea')?.focus(),0);}}
  function closeModal(cls) {if(cls==='genericModal'&&modalOptions?.beforeClose&&!modalOptions.beforeClose())return;const m=root.querySelector('.'+cls);if(m)m.classList.remove('show');if(cls==='genericModal'){modalOptions=null;const box=root.querySelector('#gmBody');box.oninput=null;box.onclick=null;}modalReturn?.focus?.();if(pendingPush&&!syncing){pendingPush=false;scheduleSync();}}
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
    if(MODE==='dev'&&e.key!=='Escape')return;
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
      if(mounted&&hostEl.shadowRoot===root)return api;
      root = hostEl.shadowRoot || (hostEl.attachShadow ? hostEl.attachShadow({ mode: 'open' }) : hostEl);
      if (!root.querySelector) root = hostEl;   // 极端兜底
      VIEW = CONFIG.defaultView;
      // 首次：本地 → 无则种子
      const local = loadLocal();
      if (local) applyState(local);
      // 空数据库保持空，不将示例卡写入真实团队仓。
      SAVED=clone(collectLocal());
      try {localDrafts=JSON.parse(localStorage.getItem(SYNC_PREFIX+'drafts')||'{}');CONFLICTS=local?local._localConflicts||[]:[];const b=JSON.parse(localStorage.getItem(SYNC_PREFIX+'base')||'null');if(b&&b.repo===CONFIG.channel.repo&&b.file===CONFIG.channel.file&&b.branch===CONFIG.channel.branch)BASE=b.state;const p=JSON.parse(localStorage.getItem(SYNC_PREFIX+'prefs')||'{}');GameDev._project=p.project||'';GameDev._tab=DEV_KEYS[p.tab]?p.tab:'devMilestone';GameDev._member=p.member||'';}catch(e){}
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
