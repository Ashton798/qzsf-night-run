(function(){
  'use strict';
  const esc=s=>Night.esc(s);
  Pages['night-admin']=function(){
    if(!AdminAuth.guard(Router))return {html:''};
    let map,timer,dead=false,markers=[],trackLine,routeLines=[],plan,selected=null;
    return {
      html:'<div class="night-admin"><header><button id="na-back">返回后台</button><h2>荧光夜跑 · 路线审核与现场监控</h2><button id="na-editor">编辑路线</button><button id="na-event">比赛时间配置</button></header><p id="na-status" role="status">正在连接…</p><div class="night-admin-grid"><div><div id="na-map"></div><p>实时位置仅工作人员可见。橙色轨迹为所选场次记录，包含待复核异常点。</p><div id="na-runs"></div></div><section><h3>路线核对与发布</h3><select id="na-group"><option value="competition">A · 竞赛组</option><option value="experience">B · 体验组 / 同心组</option></select><button id="na-load">加载最新草稿</button><div id="na-proof"></div><h3>现场游戏确认</h3><label>场次号<input id="na-id" type="number" min="1"></label><button id="na-detail">查看选手 / 轨迹</button><div id="na-person"></div><select id="na-cp"><option>CP1</option><option>CP2</option><option>CP3</option></select><label><input id="na-success" type="checkbox"> 已现场确认游戏成功</label><label><input id="na-both" type="checkbox"> 同心组两人均在现场</label><textarea id="na-note" placeholder="纸质凭证号、现场观察、补录原因"></textarea><button id="na-stamp">工作人员盖章</button><button id="na-field">记录断网 / 息屏现场补充凭证</button><button id="na-clear">审核成绩通过</button><h3>待复核警报</h3><div id="na-alerts"></div><p id="na-error" role="alert"></p></section></div></div>',
      async mount(el){
        const $=s=>el.querySelector(s);
        const action=fn=>async()=>{try{$('#na-error').textContent='';await fn();}catch(e){$('#na-error').textContent=e.message||e.title;}};
        $('#na-back').onclick=()=>Router.go('admin-home');$('#na-editor').onclick=()=>Router.go('admin-course');$('#na-event').onclick=()=>Router.go('admin-event');
        async function loadCourse(){
          selected=(await API.get('/api/night/course',{group:$('#na-group').value,draft:'1'})).data;
          const spec=plan.routes[$('#na-group').value==='competition'?'A':'B'];
          if(!selected){$('#na-proof').innerHTML='<p>尚无本路线草稿。请打开路线编辑器，根据实测坐标绘制。</p><img style="width:100%" src="'+spec.figure+'">';return;}
          const proof=selected.surveyEvidence||{};
          $('#na-proof').innerHTML='<p>'+esc(selected.name)+' · '+esc(selected.status)+' · '+selected.route.points.length+' 节点 · '+selected.meta.distance+'m</p><a href="'+spec.figure+'" target="_blank">策划原图</a> · <a href="data/assets/government-map-1.png" target="_blank">政府平面图</a><label>核对人<input id="na-reviewer" value="'+esc(proof.reviewer||'')+'"></label><label>现场日期<input id="na-date" type="date" value="'+esc(proof.surveyDate||'')+'"></label><label>坐标与道路核对证据<textarea id="na-source">'+esc(proof.source||'')+'</textarea></label><label><input id="na-aligned" type="checkbox"> 已对照真实底图逐段走测，路线不穿建筑、围墙、湖泊</label><p>每个地标绑定对应的路线节点编号（从1开始）；现场确认后勾选。</p>'+spec.landmarks.map((n,i)=>{const p=(proof.landmarks||[]).find(x=>x.name===n)||{};return '<label class="night-landmark"><input data-verified="'+i+'" type="checkbox" '+(p.verified?'checked':'')+'>'+esc(n)+'<input data-node="'+i+'" type="number" min="1" max="'+selected.route.points.length+'" value="'+(Number.isInteger(p.nodeIndex)?p.nodeIndex+1:'')+'" placeholder="节点号"></label>';}).join('')+'<button id="na-publish">保存核对证据并发布新版本</button><button id="na-export">导出完整坐标 JSON</button><p>发布版本不可编辑，修改须保存为新草稿并重新审核。</p>';
          $('#na-publish').onclick=action(async()=>{
            if(!$('#na-aligned').checked)throw Error('请先实际核对道路');
            const c=JSON.parse(JSON.stringify(selected));
            c.status='draft';c.forceNewVersion=true;
            c.surveyEvidence={reviewer:$('#na-reviewer').value.trim(),surveyDate:$('#na-date').value,source:$('#na-source').value.trim(),roadAligned:true,landmarks:spec.landmarks.map((n,i)=>({name:n,nodeIndex:Number($('[data-node="'+i+'"]').value)-1,verified:$('[data-verified="'+i+'"]').checked}))};
            const saved=(await API.put('/api/course',c)).data;
            await API.post('/api/night/course/'+saved.courseId+'/publish',{});await loadCourse();$('#na-error').textContent='审核版本已发布，选手端只读。';
          });
          $('#na-export').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(selected,null,2)],{type:'application/json'}));a.download='route-'+selected.route.routeKey+'-gcj02.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);};
          if(map){routeLines.forEach(l=>l.remove());routeLines=[];
            for(const g of ['competition','experience']){const c=(await API.get('/api/night/course',{group:g,draft:'1'})).data;if(c)routeLines.push(map.addPolyline(c.route.points,{strokeColor:g==='competition'?'#ef4444':'#2563eb',strokeWeight:5,showDir:true}));}
            map.fitPoints(selected.route.points);
          }
        }
        $('#na-load').onclick=action(loadCourse);
        async function detail(){
          const id=Number($('#na-id').value),d=(await API.get('/api/admin/runs/'+id)).data;
          $('#na-person').textContent=d.run.name+' / '+d.run.sid+' / '+d.run.group+' · '+d.run.cpDone+'/3 · '+d.run.status+' · 复核 '+d.run.reviewStatus;
          let cursor=0,points=[];
          do{const batch=(await API.get('/api/admin/runs/'+id+'/track',{since:cursor,limit:5000})).data.points;points.push(...batch);if(batch.length<5000)break;cursor=batch.at(-1).id;}while(!dead);
          if(map){if(trackLine)trackLine.remove();const pts=points.filter(p=>p.lng&&p.lat).map(p=>[p.lng,p.lat]);trackLine=map.addPolyline(pts,{strokeColor:'#f59e0b',strokeWeight:4});if(pts.length)map.fitPoints(pts);}
        }
        $('#na-detail').onclick=action(detail);
        $('#na-stamp').onclick=action(async()=>{
          const r=(await API.post('/api/runs/'+Number($('#na-id').value)+'/hit',{code:$('#na-cp').value,method:'manual',gameCompleted:$('#na-success').checked,bothPresent:$('#na-both').checked,note:$('#na-note').value})).data;
          if(r.valid===false)throw Error(r.reason);$('#na-success').checked=false;await detail();$('#na-error').textContent='已盖章并记录操作员。';
        });
        $('#na-field').onclick=action(async()=>{await API.post('/api/night/field-record',{runId:Number($('#na-id').value),note:$('#na-note').value});$('#na-error').textContent='现场凭证已记录，等待审核。';});
        $('#na-clear').onclick=action(async()=>{await API.patch('/api/admin/runs/'+Number($('#na-id').value)+'/review',{status:'cleared',note:$('#na-note').value});await detail();});
        let refreshing=false;
        async function refresh(){
          if(dead||refreshing)return;refreshing=true;
          try{
            const [live,stats,alerts,runs]=await Promise.all([API.get('/api/admin/live'),API.get('/api/stats'),API.get('/api/anomalies',{reviewed:'0'}),API.get('/api/admin/runs',{limit:1000})]);
            if(dead)return;
            $('#na-status').textContent='报名记录 '+stats.data.total+'（同心组一条为两人） · 各组 '+JSON.stringify(stats.data.byGroup)+' · 进行中 '+live.data.running+' · 45秒内上传 '+live.data.online+' · 待复核 '+live.data.unreviewedAnomalies;
            markers.forEach(m=>m.remove());markers=[];
            if(map)live.data.rows.filter(r=>r.lng&&r.lat).forEach(r=>markers.push(map.addMarker({position:[r.lng,r.lat],html:'<div class="night-live '+(r.status==='stale'?'stale':'')+'">'+esc(r.name)+' '+r.cpDone+'/3</div>'})));
            $('#na-runs').innerHTML=runs.data.map(r=>'<button data-run="'+r.id+'">#'+r.id+' '+esc(r.name)+' · '+esc(r.group)+' · '+esc(r.status)+' · '+r.cpDone+'/3</button>').join('');
            el.querySelectorAll('[data-run]').forEach(b=>b.onclick=action(async()=>{$('#na-id').value=b.dataset.run;await detail();}));
            $('#na-alerts').innerHTML=alerts.data.map(a=>'<p>#'+a.run_id+' '+esc(a.name)+' '+esc(a.type)+' <button data-alert="'+a.id+'">记录复核意见</button></p>').join('')||'暂无警报';
            el.querySelectorAll('[data-alert]').forEach(b=>b.onclick=action(async()=>{const note=$('#na-note').value.trim();if(!note)throw Error('请填写复核依据');await API.patch('/api/anomalies/'+b.dataset.alert,{reviewed:true,resolution:note});await refresh();}));
          }catch(e){$('#na-error').textContent=e.message;}finally{refreshing=false;}
        }
        try{plan=(await API.get('/api/night-plan')).data;map=await MapEngine.create($('#na-map'),{zoom:16});if(dead){map.destroy();return;}await loadCourse();}catch(e){$('#na-error').textContent=e.message||e.title;}
        await refresh();timer=setInterval(refresh,10000);
      },
      unmount(){dead=true;clearInterval(timer);if(map)map.destroy();}
    };
  };
})();
