/* 正式夜跑：后台权威状态、原始 GPS 持久队列、仅本人轨迹。 */
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } };
  const write = (k,v) => localStorage.setItem(k,JSON.stringify(v));
  const session = () => U.load('night_run',null);
  let pumping=false;
  async function flush() {
    const r=session(); if(!r || pumping)return;
    pumping=true;
    try {
      const key='night_queue_'+r.id;
      let queue=read(key)||[];
      while(queue.length && navigator.onLine) {
        const batch=queue.slice(0,100);
        await API.post('/api/runs/'+r.id+'/track',{points:batch});
        const sent=new Set(batch.map(p=>p.seq));
        queue=(read(key)||[]).filter(p=>!sent.has(p.seq));write(key,queue);
      }
    } finally { pumping=false; }
  }
  // Queue persists until an acknowledged upload. One ordered writer per page.
  let lastSample=0;
  window.addEventListener('night:gps',function(e){
    const p=e.detail,r=session();if(!r || r.status!=='running' || p.ts===lastSample)return;
    lastSample=p.ts;
    const key='night_queue_'+r.id, queue=read(key)||[];
    const seq=Number(read('night_seq_'+r.id)||0);
    const point={seq,rawLat:p.lat,rawLng:p.lng,accuracy:p.accuracy,ts:p.ts,source:'gps',crs:'wgs84',heading:p.heading,speed:p.speed};
    try { write(key,queue.concat(point));write('night_seq_'+r.id,seq+1); }
    catch(e){U.toast('手机存储已满，轨迹可能未保存，请立即联系工作人员');}
  });
  window.addEventListener('online',()=>flush().catch(()=>{}));
  setInterval(()=>flush().catch(()=>{}),10000);

  function page() {
    let map,me,accuracy,line,passed,trace,course,plan,run=session(),timer,disposed=false,watchListener;
    /* 组别优先取报名记录；未报名时允许用 URL ?group= 预览对应路线（仅供踏勘，
     * 不构成参赛资格）。 */
    let group=(DB.getReg()||{}).group||((/[?&]group=(competition|experience|unity)/.exec(location.search)||[])[1])||'competition',base='normal',lastTs=0,track=[],hits=[],error='',offSince=0,offCount=0,passedIndex=0;
    const overlays=[];
    let wake;
    return {
      html:'<div class="night-page"><header><button id="nr-back">‹ 返回</button><strong>荧光夜跑 · 比赛地图</strong><button id="nr-admin">管理</button></header><p class="night-note">路线仅由现场实测和管理员审核发布。手机 GPS 仅提示接近，游戏以工作人员盖章为准。</p><div id="nr-map" class="night-map"></div><div class="night-tools"><button id="nr-locate">◎ 重新定位</button><button id="nr-base">卫星 / 道路</button><button id="nr-fit">全程</button></div><section class="night-panel"><div id="nr-status" role="status">正在读取比赛路线…</div><div id="nr-metrics" class="night-metrics"></div><div id="nr-actions" class="night-actions"></div><div id="nr-task"></div><small>请保持页面前台与屏幕点亮。息屏、切后台可能中断定位；断网保留轨迹待补传，现场凭证卡由工作人员盖章。</small><div id="nr-error" role="alert"></div></section></div>',
      async mount(el) {
        const find=s=>el.querySelector(s);
        find('#nr-back').onclick=()=>Router.go('home');
        find('#nr-admin').onclick=()=>Router.go(AdminAuth.isLoggedIn && AdminAuth.isLoggedIn()?'night-admin':'admin-login');
        find('#nr-locate').onclick=async()=>{await Geo.start();const p=Geo.snapshot().last;if(p&&map)map.setCenter(p.gcjLng,p.gcjLat,18);};
        find('#nr-base').onclick=()=>{base=base==='normal'?'hybrid':'normal';if(map)map.setBase(base);};
        find('#nr-fit').onclick=()=>{if(map&&course)map.fitPoints(course.route.points);};
        try {
          plan=(await API.get('/api/night-plan')).data;
          course=(await API.get('/api/night/course',{group})).data;
          // Bind to the exact immutable route version for a resumed run.
          if(run && run.courseId) { const j=await API.get('/api/course',{courseId:run.courseId}); if(j.data && j.data.status==='published')course=j.data; }
          map=await MapEngine.create(find('#nr-map'),{zoom:16,minZoom:12,maxZoom:20});
          if(disposed){map.destroy();return;}
          if(course) {
            const draft=!!course.draft;
            line=map.addPolyline(course.route.points,{strokeColor:group==='competition'?'#ef4444':'#2563eb',strokeWeight:7,showDir:true,strokeStyle:draft?'dashed':'solid'});
            passed=map.addPolyline([],{strokeColor:'#22c55e',strokeWeight:4});
            trace=map.addPolyline([],{strokeColor:'#f59e0b',strokeWeight:3});
            const markers=[{p:course.route.start,label:'起'},{p:course.route.finish,label:'终'},...course.checkpoints.map(cp=>({p:cp.lnglat,label:String(cp.order)}))];
            markers.forEach(x=>overlays.push(map.addMarker({position:x.p,html:'<div class="night-pin">'+x.label+'</div>'})));
            map.fitPoints(course.route.points);
            /* 地图容器刚插入 DOM 时尺寸可能为 0，fit 会算错。
             * 在下一帧与 400ms 后各校正一次。 */
            requestAnimationFrame(()=>{try{map.resize&&map.resize();map.fitPoints(course.route.points);}catch(_){}});
            setTimeout(()=>{try{if(!disposed&&map){map.resize&&map.resize();map.fitPoints(course.route.points);}}catch(_){}},400);
          }
          if(MapEngine.lastError()) error='高德 JS API 未就绪，当前为栅格预览：'+MapEngine.lastError().title;
          if(run&&run.courseId&&course&&course._server&&run.courseId!==course._server.courseId)error='您绑定的比赛路线已被管理员发布新版本；请回到起点由工作人员核对。';
        } catch(e) {error=e.message||e.title||'地图加载失败';}
        async function act(fn){try{error='';await fn();}catch(e){error=e.message;}render();}
        function render(){
          if(disposed)return;
          const snap=Geo.snapshot(),p=snap.last,r=run;
          const pending=r?(read('night_queue_'+r.id)||[]).length:0;
          find('#nr-status').textContent=(navigator.onLine?'联网':'网络中断')+' · '+snap.message+(document.hidden?' · 后台定位可能暂停':'');
          find('#nr-metrics').innerHTML='<span>计时 <b>'+(r?U.fmtTime((r.endedAt||Date.now())-r.startedAt):'00:00')+'</b></span><span>打卡 <b>'+hits.length+' / 3</b></span><span>精度 <b>'+(p?Math.round(p.accuracy)+' m':'—')+'</b></span><span>待上传 <b>'+pending+'</b></span>';
          find('#nr-error').textContent=error;
          const reg=DB.getReg();
          find('#nr-actions').innerHTML=!reg?'<button id="nr-register">报名并选择组别</button>':!course?'<p>本组路线待现场核对和审核发布。当前没有可用于比赛的路线，不能开始。</p>':course.draft?'<p class="night-warn">当前显示的是<b>待现场核对的草稿路线</b>，仅供踏勘参考，不能开跑。管理员完成现场核对并发布后即可比赛。</p>':(run&&run.courseId&&course&&course._server&&run.courseId!==course._server.courseId)?'<p>请回到起点由工作人员重新核对后参赛。</p>':!r?'<button id="nr-start">定位签到并开始比赛</button>':r.status==='running'?'<button id="nr-finish">已到终点 · 申请完赛</button>':'<p>比赛已结束 · 成绩等待工作人员复核</p>';
          const b=find('#nr-register');if(b)b.onclick=()=>Router.go('register');
          const start=find('#nr-start');if(start)start.onclick=()=>act(async()=>{
            await Geo.start();const p=Geo.snapshot().last;
            if(!p||Date.now()-p.ts>30000)throw Error('请等待新鲜 GPS 定位后再次开始');
            await API.post('/api/checkins',{sid:reg.sid,rawLat:p.lat,rawLng:p.lng,crs:'wgs84',accuracy:p.accuracy,ts:p.ts});
            const d=(await API.post('/api/runs/start',{sid:reg.sid,mode:'gps'})).data;
            run=d;U.save('night_run',d);DB.setRunId(d.id);
            if(navigator.wakeLock)try{wake=await navigator.wakeLock.request('screen');}catch(_){}
          });
          const finish=find('#nr-finish');if(finish)finish.onclick=()=>act(async()=>{
            await flush();if((read('night_queue_'+run.id)||[]).length)throw Error('轨迹尚未上传完成，请联网后重试');
            const d=(await API.post('/api/runs/'+run.id+'/finish',{})).data;
            run=Object.assign({},run,d);U.save('night_run',run);
          });
          if(plan){
            const spec=plan.routes[group==='competition'?'A':'B'];
            find('#nr-task').innerHTML='<strong>'+esc(spec.name)+'</strong><p>'+(course?'路线 '+Math.round(course.meta.distance)+' m（坐标计算）':'路线长度待核对')+'</p>'+plan.games.map((g,i)=>{
              const done=hits.some(h=>h.code===g.id&&h.valid),cp=course&&course.checkpoints[i];
              const dist=p&&cp?Math.round(Coord.haversine([p.gcjLat,p.gcjLng],[cp.lnglat[1],cp.lnglat[0]])):null;
              return '<details'+(!done&&i===hits.length?' open':'')+' class="'+(done?'night-done':'')+'"><summary>'+ (done?'✓ 已盖章':'○ 待工作人员确认')+' '+esc(g.name)+' · '+esc(spec.checkpoints[i])+(dist!=null?' · '+dist+'m':' · 待现场确认')+'</summary><p>'+esc(g.rule)+(group==='unity'&&g.unityRule?' '+esc(g.unityRule):'')+'</p></details>';
            }).join('')+(run?'<p>向工作人员出示场次号：<b>'+run.id+'</b>（仅用于查询，不能自行盖章）</p>':'');
          }
        }
        watchListener=()=>{
          const p=Geo.snapshot().last;if(!p||p.ts===lastTs)return;lastTs=p.ts;
          if(map){
            if(!me){me=map.addMarker({position:p.gcj,html:'<div class="night-me"></div>'});accuracy=map.addCircle(p.gcj,p.accuracy,{strokeColor:'#2563eb',fillColor:'#2563eb'});}
            me.setPosition(p.gcj);accuracy.setCenter(p.gcj);accuracy.setRadius(p.accuracy);
            if(run&&run.status==='running') {track.push(p.gcj);if(trace)trace.setPath(track);}
            if(course&&p.trusted){
              const pts=course.route.points;let near=Infinity,index=0;
              pts.forEach((v,i)=>{const d=Coord.haversine([p.gcjLat,p.gcjLng],[v[1],v[0]]);if(d<near){near=d;index=i;}});
              // Advance only adjacent nodes; never paint a shortcut as completed.
              if(near<Math.max(20,p.accuracy)&&index<=passedIndex+1){passedIndex=Math.max(passedIndex,index);passed.setPath(pts.slice(0,passedIndex+1));}
              const distance=U.distToPath([p.gcjLat,p.gcjLng],pts.map(v=>[v[1],v[0]]));
              if(distance>50+p.accuracy){offCount++;if(!offSince)offSince=Date.now();if(offCount>=3&&Date.now()-offSince>=10000)error='持续偏离路线约 '+Math.round(distance)+' 米，请返回规定道路。此提示不代表违规判罚。';}
              else {offSince=0;offCount=0;}
            }
          }
          render();
        };
        window.addEventListener('night:gps',watchListener);
        let refreshing=false;
        async function refresh(){
          if(refreshing||disposed)return;refreshing=true;
          try{if(run){const d=(await API.get('/api/runs/'+run.id)).data;hits=d.hits||[];run=Object.assign({},run,d);U.save('night_run',run);}}catch(e){error=e.message;}
          finally{refreshing=false;render();}
        }
        render();refresh();let ticks=0;
        timer=setInterval(()=>{render();if(++ticks%10===0)refresh();},1000);
        if(run&&run.status==='running')Geo.start();
      },
      unmount(){disposed=true;clearInterval(timer);window.removeEventListener('night:gps',watchListener);if(map)map.destroy();if(wake)wake.release();}
    };
  }
  window.Night={esc,flush};
  Pages.map=page; Pages.run=page; Pages.checkin=page;
})();
