export async function startDashboard(api, E, css) {
  'use strict';
  const doc = api.document, host = doc.defaultView, KEY = 'playerStateTracker';
  const defaults = { autoAnalyze: true, recentMessages: 4 };
  let settings = { ...defaults }, store = E.freshStore(null), result = E.reconcile(store, []);
  let chatId = null, tab = 'home', category = 'all', assetCategory = 'all', busy = false, generating = false, disposed = false;
  let epoch = 0, signature = '', timer, poll, status = '准备读取当前聊天', error = '', savedAt = '', saveQueue = Promise.resolve();
  let currentMessages = [], injectionWarning = '', requestCount = 0, analysisBatchLimit = 6;
  let initializing = true;
  let paused=false, runSerial=0, cancelRequest=null, activeCompletion=Promise.resolve(), retryTimer, failures=0, lastError='';
  const stops = [], $ = id => doc.getElementById(id), esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  const format = value => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
  const pct = task => Math.min(100, task.progress / task.target * 100).toFixed(1).replace(/\.0$/, '');
  const statusName = value => ({ active: '进行中', completed: '已完成', failed: '已失败', locked: '未解锁' }[value] || value);
  const categoryNames = { belonging: '随身用品', property: '房产土地', vehicle: '交通工具', company: '公司企业', investment: '投资股权', other: '其他资产' };
  function dataState() { return store.state; }
  async function persist() {
    store.diagnostic = diagnostic();
    const id = chatId, revision = epoch, snapshot = E.clone(store);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      if (disposed || api.chatId() !== id || revision !== epoch) return;
      try { await api.writeStore(KEY, snapshot, id); if (disposed || api.chatId() !== id || revision !== epoch) return; savedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false }); if(error.startsWith('自动保存失败：'))error = ''; }
      catch (e) { error = `自动保存失败：${e.message}`; }
      renderStatus();
    });
    await saveQueue;
  }
  async function injection() {}
  function readMessages() { return currentMessages; }
  async function fetchMessages() { const rows = await api.messages(); if (!Array.isArray(rows)) throw new Error('聊天接口没有返回消息列表'); return rows; }
  function diagnostic() {
    return { version:'1.0.0',...(api.diagnostic?.()||{}),busy,paused,generating,lastError,readCount:currentMessages.length,analyzedSegments:result.resolved,totalSegments:result.total,pendingSegments:result.pending.length,
      records:E.recordedCounts(dataState()),emptyAnalysisSegments:Object.values(store.cache).filter(x=>x.patch && Object.keys(x.patch).length===0).length,
      requestsThisSession:requestCount,error,injectionWarning,lastModelReply:store.diagnostic?.lastModelReply || '' };
  }
  function completionText() {
    const n=E.recordedCounts(dataState()).total;
    return !currentMessages.length ? '没有读到聊天正文，请查看读取诊断' : n ? `已读取 ${currentMessages.length} 条聊天，已整理 ${n} 项状态记录` : `已读取 ${currentMessages.length} 条聊天，但未提取到状态；请查看读取诊断或重新分析`;
  }
  async function reload() {
    epoch++; const revision=epoch; chatId = api.chatId(); const id=chatId; signature = ''; error = ''; savedAt = ''; currentMessages=[];injectionWarning='';
    if (!chatId) { store = E.freshStore(null); result = E.reconcile(store, []); status = '请先打开一个聊天'; render(); await injection(); return; }
    try {
      const raw=await api.readStore(KEY);if(disposed||api.chatId()!==id||epoch!==revision)return;
      store = E.freshStore(raw);
      if(store.recorderRevision!=='owned-v1'){if(raw&&!store.legacy)store.legacy=E.clone(raw.state||raw);store.cache={};}
      store.recorderRevision='owned-v1';
    }
    catch (e) { error = `读取存档失败：${e.message}`; status = '读取失败，暂未写入任何数据'; render(); return; }
    await refresh(); schedule();
  }
  async function refresh() {
    if (disposed || initializing) return;
    if (api.chatId() !== chatId) return reload();
    if (!chatId) return;
    const mainActive=api.isMainGenerating?.();if(typeof mainActive==='boolean')generating=mainActive;
    if (generating) {status='酒馆正在生成回复，完成后自动继续整理';renderStatus();return;}
    let messages;const id=chatId,revision=epoch;
    try { messages = await fetchMessages(); }
    catch (e) { error = `读取聊天失败：${e.message}`; renderStatus(); return; }
    if(disposed||api.chatId()!==id||epoch!==revision)return;
    currentMessages=messages;
    const next = E.hash(JSON.stringify(E.normalizeMessages(messages)));
    if (next === signature) return;
    epoch++; signature = next; error = '';
    result = E.reconcile(store, messages);
    status = result.pending.length ? `已读取 ${messages.length} 条；已分析 ${result.resolved} / ${result.total} 段` : completionText();
    render(); await persist(); await injection();
  }
  function schedule() {
    clearTimeout(timer);
    if(paused||disposed)return;
    timer = setTimeout(() => { refresh().then(() => sync()).catch(report); }, 650);
  }
  function report(e) { error = e?.message || String(e);if(/abort|AbortReason|中止/i.test(error))error='模型请求被中止，已保留当前进度，可继续读取';lastError=error;status = '同步暂停，可点击继续读取';renderStatus();console.error('[用户状态记录 v2]',e); }
  async function cancelRun() {
    paused=true;runSerial++;busy=false;clearTimeout(timer);clearTimeout(retryTimer);cancelRequest?.();
    try{await api.abortAnalysis?.();}catch(e){console.warn('[用户状态记录] 取消旧分析请求失败',e);}
    await activeCompletion;
  }
  async function requestAnalysis(prompt,ticket) {
    let timeout,localCancel;
    const interruption=new Promise((_,reject)=>{
      localCancel=()=>{const e=new Error('本次读取已暂停');e.name='AbortError';reject(e);};cancelRequest=localCancel;
      timeout=setTimeout(()=>{try{api.abortAnalysis?.();}catch{}reject(new Error('模型请求超过两分钟未完成，已保留进度；可继续读取'));},api.requestTimeoutMs||120000);
    });
    try {return await Promise.race([api.analyze(prompt),interruption]);}
    finally {clearTimeout(timeout);if(cancelRequest===localCancel)cancelRequest=null;}
  }
  async function resume() {
    await cancelRun();paused=false;failures=0;error='';analysisBatchLimit=6;
    const mainActive=api.isMainGenerating?.();generating=typeof mainActive==='boolean'?mainActive:false;
    await refresh();
    if(!E.recordedCounts(dataState()).total&&!result.pending.length){epoch++;for(const key of Object.keys(store.cache))if(!Object.keys(store.cache[key].patch||{}).length)delete store.cache[key];result=E.reconcile(store,readMessages());}
    status=generating?'酒馆正在生成回复，完成后自动继续整理':`从第 ${result.pending[0]?.messageId??0} 条继续读取，保留 ${result.resolved} 段已整理结果`;
    renderStatus();await persist();await injection();await sync(true);
  }
  async function sync(force = false) {
    const mainActive=api.isMainGenerating?.();if(typeof mainActive==='boolean')generating=mainActive;
    if (disposed || initializing || paused || busy || generating || !chatId || !result.pending.length || (!settings.autoAnalyze && !force) || error) return;
    const ticket=++runSerial;let finish;activeCompletion=new Promise(resolve=>finish=resolve);
    busy = true; renderStatus();
    try {
      while (!disposed && !paused && ticket===runSerial && chatId && !generating && (settings.autoAnalyze || force)) {
        await refresh();
        if (error || !result.pending.length) break;
        const revision = epoch, id = chatId, first = result.pending[0];
        const firstIndex = result.units.findIndex(x => x.key === first.key), batch = []; let chars = 0;
        for (const unit of result.units.slice(firstIndex)) {
          if (unit.patches.length || store.cache[unit.key] || batch.length >= analysisBatchLimit || batch.length && chars + unit.text.length > 18000) break;
          batch.push(unit); chars += unit.text.length;
        }
        if (!batch.length) break;
        const before = E.stateBefore(store, result.units, first.key);
        const context = E.referenceContext(result.units.slice(Math.max(0, firstIndex - E.clamp(settings.recentMessages, 0, 30)), firstIndex));
        status = `正在读取 ${result.resolved + 1}–${result.resolved + batch.length} / ${result.total} 段剧情`; renderStatus();
        const modelBatch=batch.map((unit,index)=>({...unit,key:String(index)}));
        requestCount++;
        const reply = await requestAnalysis('已确认的用户别名：'+JSON.stringify(api.userAliases?.()||[])+'\n'+E.analysisPrompt(before, modelBatch, context),ticket);
        // Model work is asynchronous. An edited message or switched chat invalidates its result.
        if (disposed || ticket!==runSerial)break;
        if (api.chatId() !== id || epoch !== revision) continue;
        const freshMessages=await fetchMessages();
        if(disposed||ticket!==runSerial)break;
        if(api.chatId()!==id||epoch!==revision)continue;
        const freshSignature = E.hash(JSON.stringify(E.normalizeMessages(freshMessages)));
        if (freshSignature !== signature) { await refresh(); continue; }
        currentMessages=freshMessages;
        const text=E.responseText(reply);
        let patches;
        try {patches=E.validateAnalysis(text,modelBatch);}
        catch(e){if(batch.length>1){analysisBatchLimit=1;store.diagnostic.batchFallback=e.message;continue;}throw e;}
        store.diagnostic.lastModelReply=JSON.stringify({entries:Array.from(patches,([key,patch])=>({key,patch}))}).slice(0,6000);
        const time = new Date().toISOString();
        failures=0;lastError='';error='';
        for (const [slot, patch] of patches) store.cache[batch[Number(slot)].key] = { patch, time };
        result = E.reconcile(store, readMessages());
        status = result.pending.length ? `已读取 ${currentMessages.length} 条；已分析 ${result.resolved} / ${result.total} 段` : completionText();
        render(); await persist(); await injection();
      }
    } catch (e) {
      if(ticket===runSerial&&!disposed&&!paused){report(e);failures++;await persist();}
    }
    finally {
      if(ticket===runSerial){busy=false;await injection();renderStatus();
        if(!disposed&&!paused&&error&&settings.autoAnalyze&&result.pending.length&&failures<=2){
          const delay=api.retryDelayMs??failures*3000;status=`请求失败，${Math.ceil(delay/1000)} 秒后从断点重试（${failures}/2）`;renderStatus();
          retryTimer=setTimeout(()=>{if(!disposed&&!paused&&ticket===runSerial){error='';sync().catch(report);}},delay);
        }else if(!disposed&&!paused&&!error&&settings.autoAnalyze&&result.pending.length&&!generating)schedule();
      }
      finish();
    }
  }
  function renderStatus() {
    const node = $('psr-sync'); if (!node) return;
    node.className = `psr-sync ${error ? 'error' : busy ? 'busy' : ''}`;
    const known=E.recordedCounts(dataState()).total;
    node.innerHTML = `<span class="psr-dot"></span><div><b>${esc(initializing ? '正在初始化' : paused ? '已暂停读取' : error ? '需要继续读取' : busy ? '自动整理中' : result.pending.length ? settings.autoAnalyze ? '等待自动读取' : '自动读取已关闭' : !currentMessages.length ? '未读到聊天' : !known ? '未提取到状态' : '已同步')}</b><small>${esc(error ? error+'；'+status : status)}${savedAt ? ` · 已保存 ${esc(savedAt)}` : ''}</small></div>${busy?'<button data-action="pause" aria-label="暂停自动读取">暂停</button>':''}<button data-action="retry" aria-label="重新同步当前聊天">${paused||error?'继续读取':busy?'重启读取':!known?'重新分析':'同步'}</button>`;
    const count = $('psr-count'); if (count) count.textContent = `${result.resolved}/${result.total}`;
  }
  function title(english, chinese, subtitle, action = '') {
    return `<div class="psr-title"><div><small>${english}</small><h2>${chinese}</h2><p>${subtitle}</p></div>${action}</div>`;
  }
  function empty(text) { return `<div class="psr-empty"><span>◇</span><p>${text}</p></div>`; }
  function detail(label, value) { return `<div class="psr-detail"><dt>${label}</dt><dd class="${value ? '' : 'unknown'}">${esc(value || '剧情未说明')}</dd></div>`; }
  function sources(record) {
    const source = record.sources?.at(-1);
    if (!source) return '';
    return `<footer class="psr-source"><span>${source.kind === 'manual' ? '手动修订' : '来源'} · ${esc(source.label || `聊天 #${source.messageId}`)}</span>${source.messageId != null ? `<button data-action="source" data-message="${source.messageId}">查看原文 ↗</button>` : ''}</footer>`;
  }
  function controls(kind, id) { return `<div class="psr-card-actions"><button data-action="edit" data-kind="${kind}" data-id="${esc(id)}" aria-label="编辑记录">编辑</button><button data-action="delete" data-kind="${kind}" data-id="${esc(id)}" aria-label="移除记录">移除</button></div>`; }
  function homeHtml() {
    const s = dataState(), active = s.tasks.filter(x => x.status === 'active');
    return `<section class="psr-hero"><div class="psr-seal">录</div><div class="psr-identity"><small>PLAYER STATE</small><h2>${esc(s.profile.name)}</h2><p>${esc(s.profile.realm)} · 修炼进度 ${s.profile.realmProgress}%</p></div><button data-action="edit" data-kind="profile" aria-label="编辑宿主资料">编辑</button></section>
      <section class="psr-card psr-wealth"><div class="psr-section-head"><h3>财富余额</h3><span>三种账户 · 独立记账</span></div><div class="psr-wallets">${[['cash','余额',s.wealth.cashCurrency],['stones','灵石','枚'],['points','系统积分','点']].map(([key,label,unit])=>`<div><span>${label}</span><b>${s.sources[key]||s.wealth[key]!==0?format(s.wealth[key]):'未记录'}</b><small>${esc(unit)}</small></div>`).join('')}</div><button class="psr-text-button" data-action="edit" data-kind="wealth">调整账户记录 ↗</button></section>
      <div class="psr-overview-grid"><section class="psr-card"><span class="psr-kicker">修炼境界</span><h3 class="psr-realm">${esc(s.profile.realm)}</h3><div class="psr-progress"><i style="width:${s.profile.realmProgress}%"></i></div><p class="psr-muted">当前修炼进度 ${s.profile.realmProgress}%</p></section><section class="psr-card psr-counts"><div><span>进行任务</span><b>${active.length}</b></div><div><span>功法收藏</span><b>${s.techniques.length}</b></div><div><span>行囊种类</span><b>${s.inventory.length}</b></div><div><span>用品与资产</span><b>${s.assets.length}</b></div></section></div>
      <div class="psr-section-head"><h3>我的任务</h3><button data-tab="tasks">全部任务 ↗</button></div><div class="psr-list">${active.slice(0,3).map(taskCard).join('') || empty('尚无已确认的进行中任务')}</div>`;
  }
  function taskCard(x) {
    return `<article class="psr-card psr-task ${esc(x.status)}"><header><div><span class="psr-badge">${esc(statusName(x.status))}</span><h3>${esc(x.title)}</h3></div>${controls('tasks',x.id)}</header>${x.description ? `<p class="psr-copy">${esc(x.description)}</p>` : ''}<div class="psr-task-numbers"><div><span>目标${x.metric==='consumption'?'消费':''}</span><b>${format(x.target)} <small>${esc(x.unit)}</small></b>${x.targetText ? `<small>原文：${esc(x.targetText)}</small>` : ''}</div><div><span>${x.metric==='consumption'?'已消费':'当前进度'}</span><b>${format(x.progress)} <small>${esc(x.unit)}</small></b></div></div><div class="psr-percent"><span>当前进度</span><b>${pct(x)}%</b></div><div class="psr-progress"><i style="width:${pct(x)}%"></i></div><dl>${detail('任务奖励',x.reward)}${detail('失败惩罚',x.penalty)}${x.deadline ? detail('完成期限',x.deadline) : ''}</dl>${sources(x)}</article>`;
  }
  function tasksHtml() { return title('QUESTS','我的任务','目标、已消费与进度分别记录', '<button class="psr-primary" data-action="add" data-kind="tasks">＋ 任务</button>') + `<div class="psr-list">${dataState().tasks.map(taskCard).join('') || empty('聊天里出现任务后，会自动整理到这里')}</div>`; }
  function filters(values, chosen, type) { return `<div class="psr-filters">${values.map(([k,v])=>`<button data-filter="${type}" data-value="${k}" class="${k===chosen?'selected':''}">${v}</button>`).join('')}</div>`; }
  function itemsHtml() {
    const all = dataState().inventory, records = category === 'all' ? all : all.filter(x=>x.category===category);
    return title('INVENTORY','我的物品','一物一条，完整记录用途、效果和使用限制','<button class="psr-primary" data-action="add" data-kind="inventory">＋ 物品</button>') + filters([['all',`全部 ${all.length}`],['pill',`丹药 ${all.filter(x=>x.category==='pill').length}`],['item',`物品 / 道具 ${all.filter(x=>x.category==='item').length}`]],category,'inventory') + `<div class="psr-list">${records.map(x=>`<article class="psr-card psr-item"><header><div><span class="psr-badge">${x.category==='pill'?'丹药':'物品 / 道具'} · ${esc(x.rarity)}</span><h3>${esc(x.name)}<small class="psr-quantity">× ${format(x.quantity)}</small></h3></div>${controls('inventory',x.id)}</header><dl>${detail('功能 / 用途',x.function)}${detail('具体效果',x.effect)}${detail('疼痛 / 副作用',x.sideEffects)}${detail('使用要求',x.requirements)}${detail('使用方法',x.usage)}${x.description ? detail('补充说明',x.description) : ''}</dl>${sources(x)}</article>`).join('') || empty('丹药与阵法、法宝、道具在这里分类整理')}</div>`;
  }
  function techniquesHtml() { return title('CULTIVATION','功法典籍','修炼要求、效果、方法与风险单独留档','<button class="psr-primary" data-action="add" data-kind="techniques">＋ 功法</button>') + `<div class="psr-list">${dataState().techniques.map(x=>`<article class="psr-card psr-technique"><header><div><span class="psr-badge">功法 · ${esc(x.rarity)}</span><h3>${esc(x.name)}</h3></div>${controls('techniques',x.id)}</header><dl>${detail('修炼要求',x.requirements)}${detail('功法效果',x.effect)}${detail('修炼方法',x.method)}${detail('风险 / 代价',x.risks)}${detail('当前层次',x.stage)}${x.description ? detail('详细说明',x.description) : ''}</dl>${sources(x)}</article>`).join('') || empty('聊天里获得或修炼功法后，会自动记录到这里')}</div>`; }
  function assetsHtml() {
    const all = dataState().assets, records = assetCategory === 'all' ? all : all.filter(x=>x.category===assetCategory);
    return title('PERSONAL ASSETS','用品与资产','手机、手表、房产、公司等按归属分别整理','<button class="psr-primary" data-action="add" data-kind="assets">＋ 资产</button>') + filters([['all','全部'],...Object.entries(categoryNames)],assetCategory,'assets') + `<div class="psr-list">${records.map(x=>`<article class="psr-card psr-asset"><header><div><span class="psr-badge">${categoryNames[x.category]}</span><h3>${esc(x.name)}<small class="psr-quantity">${x.quantity>1?'× '+format(x.quantity):''}</small></h3></div>${controls('assets',x.id)}</header><dl>${detail('功能 / 用途',x.function)}${detail('归属 / 持股',x.ownership)}${detail('位置 / 存放',x.location)}${detail('配置 / 业务详情',x.details)}${detail('估值',x.valuation == null ? '' : `${format(x.valuation)} ${x.valuationCurrency}`)}${x.description ? detail('详细说明',x.description) : ''}</dl>${sources(x)}</article>`).join('') || empty('个人用品与名下资产会在这里分类，与丹药和功法分开')}</div>`;
  }
  function originalSettingsHtml() {
    return title('SYNC','自动记录与设置','仅整理用户当前拥有的状态') + `<div class="psr-list">
      <label class="psr-setting"><div><b>自动读取并保存</b><small>默认开启。完整聊天分批处理；新增、编辑、删除和切换回复页后自动校准。通过酒馆当前模型提取，会消耗模型额度。</small></div><input type="checkbox" data-setting="autoAnalyze" ${settings.autoAnalyze?'checked':''}></label>
      <section class="psr-card"><h3>用户记录范围</h3><p class="psr-copy">余额、灵石、积分、境界、任务、进度、物品、丹药、功法、随身用品和名下资产。收到才加入，送出、出售或消耗后扣除；部分送出保留剩余数量。</p></section>
      <section class="psr-card"><h3>同步进度</h3><p class="psr-copy">已分析 <b id="psr-count">${result.resolved}/${result.total}</b> 段。删改消息后，会移除失效来源并重新整理后续剧情。</p><button class="psr-primary" data-action="retry">${error?'继续读取':'立即同步'}</button><button data-action="rebuild">按当前聊天重新记录</button></section>
      <details class="psr-card"><summary>辅助参考与备份</summary><label class="psr-setting"><div><b>辅助参考段数</b><small>仅帮助理解每一批前文，不限制全部聊天读取范围。</small></div><input type="number" min="0" max="30" data-setting="recentMessages" value="${settings.recentMessages}"></label><p class="psr-copy">记录器使用当前聊天补全连接，以独立的8192 Token上限请求完整JSON。未知效果、品阶和数值显示未记录或未说明。</p><div class="psr-button-row"><button data-action="export">导出用户记录</button><button data-action="import">导入用户记录</button></div></details>
    </div>`;
  }
  function settingsHtml() {
    const d=diagnostic(),n=d.records;
    const card=`<section class="psr-card"><h3>读取与记录诊断</h3><p class="psr-copy">当前读到 <b>${d.readCount}</b> 条消息；已分析 <b>${d.analyzedSegments}/${d.totalSegments}</b> 段。<br>财富 ${n.accounts} 项 · 任务 ${n.tasks} 项 · 行囊 ${n.inventory} 项 · 功法 ${n.techniques} 项 · 资产 ${n.assets} 项。</p><p class="psr-copy">${esc(d.strategy || '尚未读取')}${injectionWarning?'<br>'+esc(injectionWarning):''}</p><button data-action="diagnostic">查看读取诊断与模型结果</button></section>`;
    return originalSettingsHtml().replace('<div class="psr-list">','<div class="psr-list">'+card);
  }
  function render() {
    const body = $('psr-body'); if (!body || disposed) return;
    const scroll = body.scrollTop;
    try { body.innerHTML = ({home:homeHtml,tasks:tasksHtml,inventory:itemsHtml,techniques:techniquesHtml,assets:assetsHtml,settings:settingsHtml}[tab] || homeHtml)(); }
    catch(e) { report(e); return; }
    body.scrollTop = scroll;
    doc.querySelectorAll('#psr-panel [data-tab]').forEach(x=>{ const on=x.dataset.tab===tab; x.classList.toggle('selected',on); x.setAttribute('aria-current',on?'page':'false'); });
    renderStatus();
  }
  function editor(kind, id = '') {
    const s = dataState(), item = kind==='profile'?s.profile:kind==='wealth'?s.wealth:s[kind].find(x=>x.id===id) || {};
    const input = (key,label,type='text',value=item[key]??'')=>`<label><span>${label}</span><input name="${key}" type="${type}" value="${esc(value)}" ${['name','title'].includes(key)?'required':''}></label>`;
    const area = (key,label)=>`<label class="wide"><span>${label}</span><textarea name="${key}" rows="3">${esc(item[key]||'')}</textarea></label>`;
    const select=(key,label,values)=>`<label><span>${label}</span><select name="${key}">${values.map(([v,t])=>`<option value="${v}" ${item[key]===v?'selected':''}>${t}</option>`).join('')}</select></label>`;
    let html='';
    if(kind==='profile') html=input('name','宿主名字')+input('realm','当前境界')+input('realmProgress','修炼进度（%）','number');
    else if(kind==='wealth') html=input('cash','余额','number')+input('cashCurrency','余额单位')+input('stones','灵石','number')+input('points','系统积分','number');
    else if(kind==='tasks') html=input('title','任务名称')+select('metric','任务类型',[['progress','一般任务'],['consumption','消费任务']])+input('target','目标数值','text',item.target??100)+input('progress','当前进度 / 已消费','text',item.progress??0)+input('unit','数值单位（元、件等）')+input('targetText','目标原文（可选）')+select('status','任务状态',Object.entries({active:'进行中',completed:'已完成',failed:'已失败',locked:'未解锁'}))+input('deadline','完成期限')+area('description','任务详细说明')+area('reward','奖励')+area('penalty','失败惩罚');
    else if(kind==='inventory') html=input('name','物品名称')+select('category','分类',[['item','物品 / 道具'],['pill','丹药']])+input('quantity','数量','number',item.quantity??1)+input('rarity','品阶')+area('function','功能 / 用途')+area('effect','具体效果')+area('sideEffects','疼痛 / 副作用')+area('requirements','使用要求')+area('usage','使用方法')+area('description','补充说明');
    else if(kind==='techniques') html=input('name','功法名称')+input('rarity','品阶')+input('stage','当前层次')+area('requirements','修炼要求')+area('effect','功法效果')+area('method','修炼方法')+area('risks','风险 / 代价')+area('description','详细说明');
    else html=input('name','用品 / 资产名称')+select('category','资产分类',Object.entries(categoryNames))+input('quantity','数量','number',item.quantity??1)+input('ownership','归属 / 持股')+input('location','位置 / 存放')+input('valuation','估值（未知留空）','number',item.valuation??'')+input('valuationCurrency','估值单位','text',item.valuationCurrency||'元')+area('function','功能 / 用途')+area('details','配置 / 业务详情')+area('description','详细说明');
    const form=$('psr-form'); form.dataset.kind=kind;form.dataset.id=id; $('psr-fields').innerHTML=html;
    $('psr-editor-title').textContent={profile:'宿主资料',wealth:'财富账户',tasks:'任务记录',inventory:'行囊记录',techniques:'功法记录',assets:'用品与资产'}[kind];
    $('psr-modal').hidden=false; $('psr-fields').querySelector('input')?.focus();
  }
  async function manual(patch) {
    if (!chatId) return;
    await refresh();
    const time=new Date().toISOString();
    store.manual.push({anchor:result.anchor,patch,source:{kind:'manual',key:`manual-${Date.now()}-${E.hash(JSON.stringify(patch))}`,label:'手动修订',messageId:null,time}});
    result=E.reconcile(store,readMessages());render();await persist();await injection();
  }
  async function submit(e) {
    e.preventDefault();const form=e.currentTarget, data=Object.fromEntries(new host.FormData(form)),kind=form.dataset.kind,id=form.dataset.id;
    for(const k of ['cash','stones','points','realmProgress','target','progress','quantity']) if(data[k]!=null) data[k]=E.num(data[k]);
    if(data.valuation!=null) data.valuation=data.valuation===''?null:E.num(data.valuation);
    const patch=kind==='profile'?{profile:data}:kind==='wealth'?{wealth:data}:{[kind]:[{...data,id:id||undefined,op:kind==='inventory'?'set':'upsert'}]};
    $('psr-modal').hidden=true;await manual(patch);
  }
  function download(name,value) {
    const url=host.URL.createObjectURL(new host.Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=doc.createElement('a');
    a.href=url;a.download=name;doc.body.appendChild(a);a.click();a.remove();setTimeout(()=>host.URL.revokeObjectURL(url),5000);
  }
  async function act(button) {
    const {action,kind,id,message}=button.dataset;
    if(action==='close') {$('psr-panel').classList.remove('open');$('psr-launcher').focus();}
    else if(action==='settings'){tab='settings';render();$('psr-body').scrollTop=0;}
    else if(action==='modal-close') $('psr-modal').hidden=true;
    else if(action==='edit'||action==='add') {if(chatId)editor(kind,id);}
    else if(action==='delete') {
      const record=dataState()[kind]?.find(x=>x.id===id); if(!record)return;
      if(host.confirm(`移除「${record.title||record.name}」？这是当前聊天的手动修订，可通过编辑聊天来源重新记录。`)) await manual({[kind]:[{id,op:'delete'}]});
    } else if(action==='retry') await resume();
    else if(action==='pause'){paused=true;await cancelRun();status=`已暂停，保留 ${result.resolved}/${result.total} 段已整理结果`;renderStatus();await persist();}
    else if(action==='rebuild') {
      if(!host.confirm('从当前现存聊天重新记录？会先导出备份，再清除读取缓存和手动修订，自动重新分析。'))return;
      download(`用户状态记录-重建前备份-${Date.now()}.json`,store); epoch++; store.cache={};store.manual=[];store.baseline=E.blankState();signature='';error='';await refresh();await sync(true);
    } else if(action==='export') download(`用户状态记录-备份-${Date.now()}.json`,store);
    else if(action==='export-legacy') download(`用户状态记录-旧版备份-${Date.now()}.json`,store.legacy);
    else if(action==='import') $('psr-file').click();
    else if(action==='source') {
      const text=readMessages().find(x=>String(x.message_id)===message)?.message;
      $('psr-source-modal').querySelector('h3').textContent='聊天来源原文';
      $('psr-source-text').textContent=text||'来源消息已不存在，将自动重新同步。';$('psr-source-modal').hidden=false;
    } else if(action==='diagnostic') {
      $('psr-source-modal').querySelector('h3').textContent='读取诊断（仅本机查看）';
      $('psr-source-text').textContent=JSON.stringify(diagnostic(),null,2);$('psr-source-modal').hidden=false;
    } else if(action==='source-close') $('psr-source-modal').hidden=true;
  }
  function onClick(e) {
    const node=e.target.closest('[data-tab],[data-filter],[data-action]');if(!node)return;
    if(node.dataset.tab){tab=node.dataset.tab;render();$('psr-body').scrollTop=0;}
    else if(node.dataset.filter){if(node.dataset.filter==='inventory')category=node.dataset.value;else assetCategory=node.dataset.value;render();$('psr-body').scrollTop=0;}
    else act(node).catch(report);
  }
  async function onChange(e) {
    const node=e.target.closest('[data-setting]');if(!node)return;
    settings[node.dataset.setting]=node.type==='checkbox'?node.checked:E.clamp(node.value,0,node.dataset.setting==='depth'?99:30);
    try{await api.writeSettings(settings);await injection();error='';render();schedule();}catch(err){report(err);}
  }
  function cleanup() {
    disposed=true;paused=true;runSerial++;cancelRequest?.();api.abortAnalysis?.();epoch++;clearTimeout(timer);clearTimeout(retryTimer);clearInterval(poll);stops.forEach(stop=>stop?.());
    host.visualViewport?.removeEventListener('resize',fitViewport);host.visualViewport?.removeEventListener('scroll',fitViewport);
    host.removeEventListener('resize',fitViewport);host.removeEventListener('keydown',onKey);api.setPrompt('',0).catch(()=>{});
    doc.querySelectorAll('#psr-style,#psr-launcher,#psr-panel,#psr-modal,#psr-file,#psr-source-modal').forEach(x=>x.remove());
  }
  function fitViewport() {
    const view=host.visualViewport,panel=$('psr-panel');if(!panel)return;
    panel.style.height=`${view?.height||host.innerHeight}px`;panel.style.top=`${view?.offsetTop||0}px`;
  }
  function onKey(e){if(e.key==='Escape'){if(!$('psr-source-modal').hidden)$('psr-source-modal').hidden=true;else if(!$('psr-modal').hidden)$('psr-modal').hidden=true;else $('psr-panel').classList.remove('open');}}
  const old=host.__playerStateTracker;old?.cleanup();
  // Remove the v1 visual elements; installation instructions also require disabling v1 listeners.
  // Only clean up a previous instance of this extension.
  const style=doc.createElement('style');style.id='psr-style';style.textContent=css;doc.head.appendChild(style);
  doc.body.insertAdjacentHTML('beforeend',`<button id="psr-launcher" title="打开用户状态记录" aria-label="打开用户状态记录">录</button><aside id="psr-panel" aria-label="用户状态记录"><header class="psr-header"><div><span class="psr-header-mark">◈</span><b>用户状态记录</b><small>PLAYER RECORDS</small></div><div><button data-action="settings" aria-label="同步与设置">⚙</button><button data-action="close" aria-label="关闭系统面板">×</button></div></header><section id="psr-sync" class="psr-sync"></section><main id="psr-body"></main><nav aria-label="系统分类">${[['home','◉','用户'],['tasks','▤','任务'],['inventory','◇','物品'],['techniques','▥','功法'],['assets','▣','资产']].map(([k,icon,label])=>`<button data-tab="${k}"><span>${icon}</span>${label}</button>`).join('')}</nav></aside><div id="psr-modal" class="psr-overlay" hidden><form id="psr-form"><header><h3 id="psr-editor-title">编辑记录</h3><button type="button" data-action="modal-close" aria-label="关闭编辑">×</button></header><p class="psr-editor-note">手动修订跟随当前聊天来源；删改此前消息后会重新按剧情校准。</p><div id="psr-fields"></div><footer><button type="button" data-action="modal-close">取消</button><button type="submit" class="psr-primary">保存修订</button></footer></form></div><div id="psr-source-modal" class="psr-overlay" hidden><section><header><h3>聊天来源原文</h3><button data-action="source-close" aria-label="关闭来源原文">×</button></header><pre id="psr-source-text"></pre></section></div><input id="psr-file" type="file" accept=".json,application/json" hidden>`);
  $('psr-launcher').onclick=()=>{$('psr-panel').classList.add('open');render();refresh().then(()=>sync()).catch(report);};
  $('psr-panel').onclick=onClick;$('psr-modal').onclick=onClick;$('psr-source-modal').onclick=onClick;
  $('psr-form').onsubmit=e=>submit(e).catch(report);$('psr-panel').onchange=e=>onChange(e).catch(report);
  $('psr-file').onchange=async e=>{
    const file=e.target.files?.[0];if(!file||!chatId)return;
    try{
      const raw=JSON.parse(await file.text());
      const imported=raw?.state||raw;
      if(!imported||typeof imported!=='object'||(!imported.profile&&!imported.wealth&&!Array.isArray(imported.inventory)))throw new Error('不是有效的用户状态记录存档');
      if(!host.confirm('导入会替换当前面板资料，并先导出当前备份。确认导入？'))return;
      download(`用户状态记录-导入前备份-${Date.now()}.json`,store);epoch++;
      // Caches can only be reused for the same exact current conversation prefix.
      if(raw.version===E.VERSION&&raw.cache&&Array.isArray(raw.manual))store=E.freshStore(raw);
      else {store=E.freshStore(null);store.baseline=E.normalizeState(imported);}
      signature='';error='';await refresh();schedule();
    }catch(err){report(err);}finally{e.target.value='';}
  };
  host.__playerStateTracker={cleanup,getState:()=>E.clone(store),ready:()=>!busy&&!result.pending.length,getStatus:()=>({busy,paused,generating,error,status,pending:result.pending.length}),refresh,sync,resume};
  try {api.onOpen?.(()=>{$('psr-panel').classList.add('open');render();});}catch(e){console.warn('[用户状态记录] 脚本按钮接口不可用，悬浮按钮仍可打开',e.message);}
  const bind=(name,callback)=>{try{stops.push(api.on(name,callback));}catch(e){console.warn('[用户状态记录] 事件接口不可用，将使用定期检查',name,e.message);}};
  for(const name of ['MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_UPDATED','MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_SWIPED'])bind(name,schedule);
  bind('CHAT_CHANGED',()=>{if(!initializing)reload().catch(report);});
  bind('GENERATION_STARTED',type=>{if(!busy&&type!=='quiet')generating=true;});
  for(const name of ['GENERATION_ENDED','GENERATION_STOPPED'])bind(name,()=>{generating=false;if(!busy)schedule();});
  host.visualViewport?.addEventListener('resize',fitViewport);host.visualViewport?.addEventListener('scroll',fitViewport);host.addEventListener('resize',fitViewport);host.addEventListener('keydown',onKey);fitViewport();
  try {api.onDispose?.(cleanup);}catch(e){console.warn('[用户状态记录] 生命周期接口不可用',e.message);}
  // Mount and bind the launcher before asynchronous settings or chat reads.
  render();
  try {settings={...defaults,...await api.readSettings()};}catch(e){console.warn('[用户状态记录] 设置接口不可用，使用自动读取默认设置',e.message);}
  if(disposed)return host.__playerStateTracker;
  initializing=false;
  poll=setInterval(()=>{if(!disposed){refresh().then(()=>{if(!busy&&!error&&result.pending.length)schedule();}).catch(report);}},2500);
  try {await reload();}catch(e){report(e);}
  console.info('[用户状态记录] v1.0 已加载；自动同步全部现存聊天');
  return host.__playerStateTracker;
}
