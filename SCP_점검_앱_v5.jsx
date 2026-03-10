import { useState, useMemo, useCallback } from "react";
import * as XLSX from "xlsx";
import * as Papa from "papaparse";

// ═══════════════════════════════════════════════════════
// 상수
// ═══════════════════════════════════════════════════════
const BIZ_DEFAULT = 22, CAL = 31, Z97 = 1.88, ASM_LT = 2;

const VC = {
  심각부족:   { bg:"#FEE2E2", fg:"#991B1B", bdr:"#FCA5A5", dot:"#EF4444" },
  부족:       { bg:"#FEF3C7", fg:"#92400E", bdr:"#FCD34D", dot:"#F59E0B" },
  적정:       { bg:"#D1FAE5", fg:"#065F46", bdr:"#6EE7B7", dot:"#10B981" },
  과잉:       { bg:"#DBEAFE", fg:"#1E40AF", bdr:"#93C5FD", dot:"#3B82F6" },
  목표미설정: { bg:"#F3F4F6", fg:"#6B7280", bdr:"#D1D5DB", dot:"#9CA3AF" },
  SCP미등재:  { bg:"#F5F3FF", fg:"#5B21B6", bdr:"#C4B5FD", dot:"#8B5CF6" },
};

// 기본값 (Grid00 미업로드 시 fallback)
const LINE_CAPA_DEFAULT = {
  "T40-2_F":100,"TC13(조립5)":200,"T50-2":200,"T80":120,"M02":150,
  "부품포장":400,"T40_FKD":150,"벌크":250,"후레임2":200,"후레임3":180,
  "T50-1":150,"플라이트":120,"도장(외부출고)":300,"가죽":40,"T55":120,"A/S포장":100,
};

// ═══════════════════════════════════════════════════════
// Grid00 XLS/CSV 파싱 → 라인별 일일CAPA 산출
// 방식: 전체 기간 라인별 합산 ÷ 유효 작업월수 ÷ 월평균영업일
// ═══════════════════════════════════════════════════════
function isWeekend(dateStr) {
  const d = new Date(dateStr); return d.getDay()===0||d.getDay()===6;
}

async function parseGrid00Files(files) {
  // BIFF8 XLS 파싱 (브라우저 환경: SheetJS 사용)
  const allRows = [];
  for(const file of files){
    let rows = [];
    const fname = file.name.toLowerCase();
    if(fname.endsWith('.xls')||fname.endsWith('.xlsx')){
      const ab = await new Promise((res,rej)=>{const r=new FileReader();r.onload=e=>res(e.target.result);r.onerror=rej;r.readAsArrayBuffer(file);});
      const wb = XLSX.read(ab,{type:'array',cellDates:true});
      const sh = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sh,{header:1,defval:''});
    } else {
      rows = await new Promise((res,rej)=>Papa.parse(file,{header:false,skipEmptyLines:true,complete:r=>res(r.data),error:rej}));
    }
    allRows.push(...rows);
  }

  // 헤더 탐지
  const hdrIdx = allRows.findIndex(r=>r.some(v=>String(v).includes('생산라인')));
  if(hdrIdx<0) return null;
  const hdr = allRows[hdrIdx].map(v=>String(v).trim());
  const ci = k => hdr.findIndex(h=>h.includes(k));
  const lineCol = ci('생산라인'), qtyCol = ci('계획량'), dateCol = ci('최초포장계획일'), itemCol = ci('품목코드');

  // 라인별 월별 집계
  const lineMonthQty = {}; // line → ym → qty
  const lineItemQty = {};  // line → item → qty (품목별)
  const allDates = new Set();

  allRows.slice(hdrIdx+1).forEach(r=>{
    if(!r[lineCol]) return;
    const line = String(r[lineCol]).trim().replace('라인]','');
    const qty = parseFloat(String(r[qtyCol]).replace(/,/g,''))||0;
    const dateRaw = r[dateCol];
    let ym = '';
    if(dateRaw instanceof Date) {
      ym = `${dateRaw.getFullYear()}-${String(dateRaw.getMonth()+1).padStart(2,'0')}`;
      allDates.add(dateRaw.toISOString().slice(0,10));
    } else if(dateRaw) {
      const s = String(dateRaw).trim();
      ym = s.slice(0,7);
      if(s.length>=10) allDates.add(s.slice(0,10));
    }
    if(!line||qty<=0||!ym) return;

    if(!lineMonthQty[line]) lineMonthQty[line]={};
    lineMonthQty[line][ym] = (lineMonthQty[line][ym]||0)+qty;

    const item = String(r[itemCol]||'').trim().split('-')[0];
    if(item){
      if(!lineItemQty[line]) lineItemQty[line]={};
      lineItemQty[line][item] = (lineItemQty[line][item]||0)+qty;
    }
  });

  // 라인별 월평균 일일CAPA 계산
  // 각 월의 영업일수를 추정 (해당 월 dates 집합 기준 또는 단순 22일 가정)
  const result = {};
  const itemResult = {};

  Object.entries(lineMonthQty).forEach(([line, monthMap])=>{
    const months = Object.keys(monthMap);
    if(!months.length) return;
    const totQty = months.reduce((a,ym)=>a+monthMap[ym],0);
    // 월별 영업일 추정: 22일 고정 (또는 나중에 공휴일 반영)
    const avgMonthQty = totQty / months.length;
    const dailyCapa = Math.round(avgMonthQty / 22);
    result[line] = { dailyCapa, monthCount:months.length, totalQty:Math.round(totQty),
                     avgMonthQty:Math.round(avgMonthQty), months };

    // 품목별 기여도
    if(lineItemQty[line]){
      itemResult[line] = Object.entries(lineItemQty[line])
        .map(([item,q])=>({item,qty:Math.round(q),pct:Math.round(q/totQty*100)}))
        .sort((a,b)=>b.qty-a.qty);
    }
  });

  return {capaByLine:result, itemByLine:itemResult, months:[...new Set(Object.values(lineMonthQty).flatMap(m=>Object.keys(m)))].sort()};
}

// ═══════════════════════════════════════════════════════
// 파일 파싱 유틸
// ═══════════════════════════════════════════════════════
const toN = v => { const n = parseFloat(String(v||"").replace(/,/g,"")); return isNaN(n)?null:n; };

function readXlsx(file) {
  return new Promise((res,rej) => {
    const r = new FileReader();
    r.onload = e => { try { res(XLSX.read(e.target.result,{type:"array"})); } catch(err){rej(err);} };
    r.onerror = rej;
    r.readAsArrayBuffer(file);
  });
}

function readCsvAuto(file) {
  return new Promise((res,rej) => {
    const r = new FileReader();
    r.onload = e => {
      const raw = e.target.result;
      const bytes = new Uint8Array(raw.slice(0,2));
      if ((bytes[0]===0xFF&&bytes[1]===0xFE)||(bytes[0]===0xFE&&bytes[1]===0xFF)) {
        const text = new TextDecoder("utf-16").decode(raw);
        Papa.parse(text,{header:false,skipEmptyLines:true,delimiter:"\t",complete:r2=>res(r2.data),error:rej});
      } else {
        Papa.parse(file,{header:false,skipEmptyLines:true,complete:r2=>res(r2.data),error:rej});
      }
    };
    r.onerror = rej;
    r.readAsArrayBuffer(file);
  });
}

// ═══════════════════════════════════════════════════════
// 파일 파싱
// ═══════════════════════════════════════════════════════

function buildLtMaps(rows) {
  const hi=rows.findIndex(r=>String(r[0]||"").trim()==="CODE");
  const data=hi>=0?rows.slice(hi+1):rows;
  let ltCol=6;
  if(hi>=0){ const h=rows[hi].map(v=>String(v||"").trim()); const fc=h.findIndex(v=>v==="리드타임"); if(fc>=0) ltCol=fc; }
  const combo={},code={},c3={};
  data.forEach(r=>{
    const c=String(r[0]||"").trim(); if(!c||c==="nan") return;
    const v=toN(r[ltCol]); if(v==null) return;
    combo[c]=v;
    const k=c.split("-")[0]; if(!code[k])code[k]=[]; code[k].push(v);
    const a=c.slice(0,3); if(!c3[a])c3[a]=[]; c3[a].push(v);
  });
  const avg=arr=>arr.reduce((a,b)=>a+b,0)/arr.length;
  return { combo, codeAvg:Object.fromEntries(Object.entries(code).map(([k,v])=>[k,avg(v)])),
           c3Avg:Object.fromEntries(Object.entries(c3).map(([k,v])=>[k,avg(v)])) };
}

function getLt(maps,combo) {
  const k=combo.split("-")[0],a=combo.slice(0,3);
  if(maps.combo[combo]!=null) return [maps.combo[combo],"combo직접"];
  if(maps.codeAvg[k]!=null)   return [maps.codeAvg[k],"단품코드평균"];
  if(maps.c3Avg[a]!=null)     return [maps.c3Avg[a],  "앞3글자평균"];
  return [6,"기본값(6)"];
}

function buildDemand(rows) {
  const hdr=rows[0].map(v=>String(v||"").trim());
  const supCol=hdr.findIndex(h=>h.includes("공급처")), codeCol=hdr.findIndex(h=>h==="CODE");
  const mCols=hdr.reduce((a,h,i)=>{ if(h.includes("년"))a.push(i); return a; },[]);
  const comboMap={},codeMap={};
  rows.slice(1).forEach(r=>{
    if(String(r[supCol]||"").trim()!=="평택의자") return;
    const raw=String(r[codeCol]||"").trim(); if(!raw) return;
    const pts=raw.split("-"), combo=pts.slice(0,2).join("-"), code=pts[0];
    const vals=mCols.map(i=>toN(String(r[i]||"").replace(/,/g,""))||0);
    if(!comboMap[combo])comboMap[combo]=new Array(vals.length).fill(0);
    if(!codeMap[code])codeMap[code]=new Array(vals.length).fill(0);
    vals.forEach((v,i)=>{ comboMap[combo][i]+=v; codeMap[code][i]+=v; });
  });
  return {comboMap,codeMap};
}

function calcStats(arr) {
  if(!arr||!arr.length) return {mu:0,sd:0,n:0,eff:[]};
  const fnz=arr.findIndex(v=>v>0), eff=fnz>=0?arr.slice(fnz):[0];
  const mu=eff.slice(-3).reduce((a,b)=>a+b,0)/Math.min(3,eff.length);
  let sd=0;
  if(eff.length>1){ const m=eff.reduce((a,b)=>a+b,0)/eff.length; sd=Math.sqrt(eff.reduce((a,b)=>a+(b-m)**2,0)/(eff.length-1)); }
  return {mu,sd,n:eff.length,eff};
}

function calcCapa(eff,codeArr,comboMu,totCal) {
  if(!codeArr||!codeArr.length) return 0;
  const fnz=codeArr.findIndex(v=>v>0), ce=fnz>=0?codeArr.slice(fnz):[0];
  const capD=Math.max(...ce)/CAL, mu3=ce.slice(-3).reduce((a,b)=>a+b,0)/Math.min(3,ce.length);
  const ratio=mu3>0?Math.min(comboMu/mu3,1):1, capaM=capD*ratio*CAL;
  const ov=eff.filter(v=>v>capaM); if(!ov.length) return 0;
  const ovAvg=ov.reduce((a,b)=>a+(b-capaM),0)/ov.length;
  return (ov.length/eff.length)*(ovAvg/CAL)*totCal;
}

function calcTarget(ltMaps,demand,combo,bizDays) {
  const BIZ=bizDays||BIZ_DEFAULT, B2C=CAL/BIZ;
  const code=combo.split("-")[0];
  const [pl,plMatch]=getLt(ltMaps,combo);
  const totBiz=pl+ASM_LT, totCal=parseFloat((totBiz*B2C).toFixed(2));
  const {mu,sd,n,eff}=calcStats(demand.comboMap[combo]);
  const codeArr=demand.codeMap[code]||[];
  const muD=mu/CAL, sdD=sd/CAL;
  const ltd=muD*totCal, ss=Z97*sdD*Math.sqrt(totCal), cb=calcCapa(eff,codeArr,mu,totCal);
  const tgt97=Math.max(1,Math.round(ltd+ss+cb));
  const cv=mu>0?parseFloat((sd/mu).toFixed(2)):null;
  const cvLabel=cv==null?"없음":cv<0.3?"낮음":cv<0.7?"보통":cv<1.2?"높음":"매우높음";
  return {
    totBiz,totCal,mu월:parseFloat(mu.toFixed(1)),월σ:parseFloat(sd.toFixed(1)),
    cv,cvLabel,n,일μ:parseFloat(muD.toFixed(3)),일σ:parseFloat(sdD.toFixed(3)),
    ltd:parseFloat(ltd.toFixed(1)),ss:parseFloat(ss.toFixed(1)),cb:parseFloat(cb.toFixed(1)),
    tgt97,pl:parseFloat(pl.toFixed(1)),plMatch,
    s월σ:`STDEV(유효 ${n}개월)`,
    sCV:mu>0?`${parseFloat(sd.toFixed(1))}÷${parseFloat(mu.toFixed(1))}=${cv}`:"-",
    s일μ:`${parseFloat(mu.toFixed(1))}÷${CAL}=${parseFloat(muD.toFixed(3))}`,
    s일σ:`${parseFloat(sd.toFixed(1))}÷${CAL}=${parseFloat(sdD.toFixed(3))}`,
    s합LT:`${parseFloat(pl.toFixed(1))}+${ASM_LT}=${parseFloat(totBiz.toFixed(1))}영업일`,
    s달력:`${parseFloat(totBiz.toFixed(1))}×(${CAL}÷${BIZ})=${totCal}일`,
    sLTd:`${parseFloat(muD.toFixed(3))}×${totCal}=${parseFloat(ltd.toFixed(1))}`,
    sSS:`1.88×${parseFloat(sdD.toFixed(3))}×√${totCal}=${parseFloat(ss.toFixed(1))}`,
    sCB:`${parseFloat(cb.toFixed(1))}`,
    sTgt:`${parseFloat(ltd.toFixed(1))}+${parseFloat(ss.toFixed(1))}+${parseFloat(cb.toFixed(1))}=${tgt97}`,
  };
}

// parseScp: scpMap만 반환 (내부용)
function parseScp(wb) {
  const {scpMap}=parseScpFull(wb);
  return scpMap;
}
// parseScpFull: scpMap + allCombos(품목 전체 목록) 반환
function parseScpFull(wb) {
  // 시디즈 의자 SCP 시트 우선, 없으면 첫 번째 시트
  const shName=wb.SheetNames.find(s=>s.includes("시디즈")&&s.includes("SCP"))
             ||wb.SheetNames.find(s=>s.includes("SCP"))
             ||wb.SheetNames[0];
  const arr=XLSX.utils.sheet_to_json(wb.Sheets[shName],{header:1,defval:""});
  const scpMap={};
  const allCombos=[];
  for(let i=3;i<arr.length;i++){
    const r=arr[i], combo=String(r[4]||"").trim();
    if(!combo||combo.length<3) continue;
    const name=String(r[5]||"").trim();
    const sell=toN(r[22]), stock=toN(r[24]);
    scpMap[combo]={sell, stock, name};
    allCombos.push({combo, name});
  }
  return {scpMap, allCombos};
}

// ═══════════════════════════════════════════════════════
// 판정
// ═══════════════════════════════════════════════════════
function judgeStock(scpStock,tgt97) {
  if(scpStock==null) return "SCP미등재";
  if(scpStock===0)   return "목표미설정";
  const r=scpStock/tgt97;
  return r>=1.2?"과잉":r>=1.0?"적정":r>=0.7?"부족":"심각부족";
}
function judgeSell(scpSell,mu월) {
  if(scpSell==null||mu월===0) return "SCP미등재";
  const r=scpSell/mu월;
  return r>=1.3?"과잉":r>=0.8?"적정":r>=0.5?"부족":"심각부족";
}
function getCapaSt(pct) {
  if(pct==null) return {color:"#9CA3AF",label:"CAPA미등록",icon:"—"};
  if(pct>=100)  return {color:"#DC2626",label:"CAPA초과",  icon:"🚨"};
  if(pct>=90)   return {color:"#F97316",label:"위험",      icon:"⚠️"};
  if(pct>=75)   return {color:"#D97706",label:"주의",      icon:"🟡"};
  return            {color:"#16A34A",label:"여유",      icon:"🟢"};
}

// ═══════════════════════════════════════════════════════
// 공통 UI
// ═══════════════════════════════════════════════════════
function Badge({v,sm}) {
  const c=VC[v]||VC["SCP미등재"];
  return <span style={{display:"inline-block",padding:sm?"1px 7px":"2px 10px",borderRadius:99,
    background:c.bg,color:c.fg,border:`1px solid ${c.bdr}`,fontSize:sm?10:11,fontWeight:700,whiteSpace:"nowrap"}}>{v}</span>;
}

function Diff({scp,base,pctOf}) {
  if(scp==null) return <span style={{color:"#9CA3AF",fontSize:10}}>—</span>;
  const diff=scp-base, pct=pctOf>0?Math.round((scp/pctOf)*100):0;
  const col=diff<0?"#DC2626":diff===0?"#059669":"#1D4ED8";
  return <span style={{color:col,fontSize:11,fontWeight:600}}>
    {diff>=0?"+":""}{diff} <span style={{color:"#9CA3AF",fontWeight:400}}>({pct}%)</span>
  </span>;
}

function KpiCard({label,value,urgent}) {
  return <div style={{background:urgent?"#FEF2F2":"#fff",borderRadius:12,padding:"14px 18px",
    border:`1px solid ${urgent?"#FCA5A5":"#E5E7EB"}`,boxShadow:"0 1px 4px rgba(0,0,0,.06)",
    minWidth:100,textAlign:"center"}}>
    <div style={{fontSize:26,fontWeight:900,color:urgent?"#B91C1C":"#1E3A5F",lineHeight:1}}>{value}</div>
    <div style={{fontSize:11,color:"#374151",fontWeight:700,marginTop:4}}>{label}</div>
  </div>;
}

function UploadZone({label,icon,hint,file,onFile}) {
  const [drag,setDrag]=useState(false);
  return <label style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6,padding:"16px 12px",
    border:`2px dashed ${file?"#059669":drag?"#3B82F6":"#CBD5E1"}`,borderRadius:12,cursor:"pointer",
    background:file?"#F0FDF4":drag?"#EFF6FF":"#FAFAFA",flex:1,minWidth:130}}
    onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)}
    onDrop={e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files[0];if(f)onFile(f);}}>
    <input type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}} onChange={e=>{const f=e.target.files[0];if(f)onFile(f);}}/>
    <span style={{fontSize:22}}>{file?"✅":icon}</span>
    <span style={{fontSize:11,fontWeight:700,color:file?"#065F46":"#1F2937",textAlign:"center"}}>{label}</span>
    <span style={{fontSize:10,color:file?"#065F46":"#9CA3AF",textAlign:"center",wordBreak:"break-all"}}>
      {file?file.name:hint}
    </span>
  </label>;
}

function Tabs({items,active,onChange}) {
  return <div style={{display:"flex",borderBottom:"2px solid #E5E7EB",marginBottom:16,overflowX:"auto"}}>
    {items.map(t=><button key={t.key} onClick={()=>onChange(t.key)} style={{padding:"9px 16px",border:"none",
      background:"none",cursor:"pointer",fontWeight:700,fontSize:12,whiteSpace:"nowrap",
      color:active===t.key?"#1E3A5F":"#6B7280",
      borderBottom:active===t.key?"2px solid #1E3A5F":"2px solid transparent",marginBottom:-2}}>{t.label}</button>)}
  </div>;
}

// ═══════════════════════════════════════════════════════
// 탭1: 목표재고·판매예측
// ═══════════════════════════════════════════════════════
function TabMain({rows,filter,setFilter,sortKey,setSortKey}) {
  const filtered=useMemo(()=>{
    let r=[...rows];
    if(filter!=="전체") r=r.filter(x=>x.stockVerdict===filter||x.sellVerdict===filter);
    const o={심각부족:0,부족:1,적정:2,과잉:3,목표미설정:4,SCP미등재:5};
    if(sortKey==="판정순") r.sort((a,b)=>(o[a.stockVerdict]??9)-(o[b.stockVerdict]??9)||a.combo.localeCompare(b.combo));
    else r.sort((a,b)=>a.line.localeCompare(b.line)||a.combo.localeCompare(b.combo));
    return r;
  },[rows,filter,sortKey]);

  const TH=({t,w,left})=><th style={{padding:"7px 6px",background:"#1E3A5F",color:"#fff",fontSize:10,
    fontWeight:700,textAlign:left?"left":"center",whiteSpace:"pre-line",lineHeight:1.3,width:w,
    borderRight:"1px solid #2D4E7E",position:"sticky",top:0,zIndex:1}}>{t}</th>;

  const CV_BG={낮음:"transparent",보통:"#D1FAE5",높음:"#FEF3C7",매우높음:"#FEE2E2",없음:"#F3F4F6"};

  return <>
    <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
      <span style={{fontSize:11,color:"#6B7280"}}>{filtered.length}개 품목</span>
      <div style={{marginLeft:"auto",display:"flex",gap:4,flexWrap:"wrap"}}>
        {["전체","심각부족","부족","적정","과잉","목표미설정","SCP미등재"].map(v=>
          <button key={v} onClick={()=>setFilter(v)} style={{padding:"3px 9px",borderRadius:99,
            border:"1.5px solid",borderColor:filter===v?"#1E3A5F":"#E5E7EB",
            background:filter===v?"#1E3A5F":"#fff",color:filter===v?"#fff":"#374151",
            fontSize:10,fontWeight:600,cursor:"pointer"}}>{v}</button>)}
      </div>
      <select value={sortKey} onChange={e=>setSortKey(e.target.value)}
        style={{padding:"3px 8px",borderRadius:8,border:"1.5px solid #E5E7EB",fontSize:10,cursor:"pointer"}}>
        <option>라인순</option><option>판정순</option>
      </select>
    </div>
    <div style={{overflowX:"auto",borderRadius:10,border:"1px solid #E5E7EB"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
        <thead><tr>
          <TH t="포장라인" w={72}/><TH t="조합코드" w={150} left/><TH t="품목명" w={170} left/>
          <TH t={"최근3개월\n평균(월)"} w={68}/><TH t="월σ" w={52}/><TH t={"CV(월)"} w={72}/><TH t={"사용\n월수"} w={44}/>
          <TH t={"품목LT\n(영업일)"} w={56}/><TH t={"조립LT\n(2일)"} w={46}/><TH t={"합계LT\n(영업일)"} w={56}/><TH t={"합계LT\n(달력일)"} w={56}/>
          <TH t="LT수요" w={52}/><TH t={"안전재고\n(97%)"} w={58}/><TH t={"CAPA\n버퍼"} w={46}/><TH t={"권장\n97%"} w={52}/>
          <TH t={"SCP\n목표재고"} w={64}/><TH t={"SCP목표재고\nvs 권장97%"} w={88}/><TH t={"목표재고\n판정"} w={80}/>
          <TH t={"SCP\n판매예측(수량)"} w={80}/><TH t={"SCP판매예측\nvs 평균출고"} w={88}/><TH t={"판매예측\n판정"} w={80}/>
        </tr></thead>
        <tbody>
          {filtered.map((row,i)=>{
            const bg=i%2===0?"#F9FAFB":"#fff";
            const stk=VC[row.stockVerdict]||{}, sel=VC[row.sellVerdict]||{};
            const td=(v,opt={})=><td style={{padding:"5px 6px",fontSize:11,textAlign:opt.left?"left":"center",
              color:opt.c||"#374151",fontWeight:opt.b?700:400,background:opt.bg||bg,
              borderRight:"1px solid #F3F4F6",whiteSpace:"nowrap"}}>{v}</td>;
            return <tr key={row.combo} style={{borderBottom:"1px solid #F3F4F6"}}>
              {td(row.line,{b:true,c:"#1E3A5F"})}
              <td style={{padding:"5px 6px",fontSize:10,fontFamily:"monospace",color:"#374151",
                background:bg,borderRight:"1px solid #F3F4F6",whiteSpace:"nowrap"}}>{row.combo}</td>
              <td style={{padding:"5px 8px",fontSize:10,color:"#374151",background:bg,maxWidth:170,
                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",borderRight:"1px solid #F3F4F6"}}>{row.name}</td>
              {td(row.mu월,{bg:"#EFF6FF"})}{td(row.월σ,{bg:"#EFF6FF"})}
              <td style={{padding:"5px 6px",textAlign:"center",fontSize:10,borderRight:"1px solid #F3F4F6",
                background:CV_BG[row.cvLabel]||bg}}>
                {row.cv!=null?`${row.cv}(${row.cvLabel})`:"없음"}
              </td>
              {td(row.n,{c:"#9CA3AF"})}
              {td(row.pl.toFixed(1))}{td(ASM_LT,{c:"#9CA3AF"})}{td(row.totBiz.toFixed(1))}{td(row.totCal.toFixed(2))}
              {td(row.ltd,{bg:"#EBF5FB"})}{td(row.ss,{bg:"#EBF5FB"})}{td(row.cb,{bg:"#EBF5FB"})}
              <td style={{padding:"5px 6px",textAlign:"center",background:"#DBEAFE",fontWeight:700,
                color:"#1E40AF",borderRight:"1px solid #F3F4F6"}}>{row.tgt97}</td>
              {td(row.scpStock!=null?row.scpStock:"-")}
              <td style={{padding:"5px 6px",textAlign:"center",background:bg,borderRight:"1px solid #F3F4F6"}}>
                <Diff scp={row.scpStock} base={row.tgt97} pctOf={row.tgt97}/>
              </td>
              <td style={{padding:"5px 6px",textAlign:"center",background:stk.bg||bg,borderRight:"1px solid #F3F4F6"}}>
                <Badge v={row.stockVerdict} sm/>
              </td>
              {td(row.scpSell!=null?row.scpSell:"-")}
              <td style={{padding:"5px 6px",textAlign:"center",background:bg,borderRight:"1px solid #F3F4F6"}}>
                <Diff scp={row.scpSell} base={Math.round(row.mu월)} pctOf={row.mu월}/>
              </td>
              <td style={{padding:"5px 6px",textAlign:"center",background:sel.bg||bg}}>
                <Badge v={row.sellVerdict} sm/>
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  </>;
}

// ═══════════════════════════════════════════════════════
// 탭2: 품목별 계산식
// ═══════════════════════════════════════════════════════
function TabCalc({rows}) {
  const TH=({t})=><th style={{padding:"7px 8px",background:"#1E3A5F",color:"#fff",fontSize:10,fontWeight:700,
    whiteSpace:"pre-line",lineHeight:1.3,borderRight:"1px solid #2D4E7E",textAlign:"left",position:"sticky",top:0}}>{t}</th>;
  return <div style={{overflowX:"auto",borderRadius:10,border:"1px solid #E5E7EB"}}>
    <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
      <thead><tr>
        <TH t="포장라인"/><TH t="조합코드"/><TH t="품목명"/>
        <TH t="월σ"/><TH t="CV"/><TH t="일평균μ"/><TH t="일σ"/>
        <TH t={"합계LT\n(영업일)"}/><TH t={"합계LT\n(달력일)"}/>
        <TH t="LT수요"/><TH t={"안전재고\n(97%)"}/><TH t="CAPA버퍼"/><TH t="권장97%"/>
      </tr></thead>
      <tbody>{rows.map((row,i)=>{
        const bg=i%2===0?"#F9FAFB":"#fff";
        const td=(v,hi)=><td style={{padding:"5px 8px",color:"#374151",background:hi?"#EBF5FB":bg,
          whiteSpace:"nowrap",borderRight:"1px solid #F3F4F6",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis"}}>{v||"—"}</td>;
        return <tr key={row.combo} style={{borderBottom:"1px solid #F3F4F6"}}>
          {td(row.line)}{td(row.combo)}{td(row.name)}
          {td(row.s월σ)}{td(row.sCV)}{td(row.s일μ)}{td(row.s일σ)}
          {td(row.s합LT)}{td(row.s달력)}
          {td(row.sLTd,true)}{td(row.sSS,true)}{td(row.sCB,true)}
          <td style={{padding:"5px 8px",fontWeight:700,color:"#1E40AF",background:"#DBEAFE",whiteSpace:"nowrap"}}>{row.sTgt}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

// ═══════════════════════════════════════════════════════
// 탭3: 용어·계산식
// ═══════════════════════════════════════════════════════
const TERMS=[
  { title:"① 수요 변동성 지표", color:"#EFF6FF", hdr:["용어","정의","계산식","비고/예시"],
    rows:[
      ["최근3개월평균(월)","최근 3개월 월별 출고량 평균","= (최근 3개월 합계) ÷ 3","예) 90÷3=30개/월"],
      ["월σ","월별 출고량 표준편차 — 클수록 불규칙","= STDEV(유효월 출고량, 0 제외)","σ 크면 안전재고↑"],
      ["CV (변동계수)","수요 불규칙성 — 낮음<0.3 / 보통 0.3~0.7\n높음 0.7~1.2 / 매우높음≥1.2","= 월σ ÷ 최근3개월평균","예) σ=15,평균=30 → CV=0.50"],
      ["사용월수","변동성 계산에 쓰인 유효 월 수","= 첫출고월~최근월 개수","월수 적으면 CV 신뢰도↓"],
      ["일평균 μ","하루 평균 출고량 (달력일 기준)","= 최근3개월평균 ÷ 31일","월평균 31개 → μ=1.0/일"],
      ["일σ","하루 출고량의 표준편차","= 월σ ÷ 31일","월σ=15.5 → 일σ=0.5"],
    ]},
  { title:"② 리드타임 구성  (합계LT = 품목LT + 조립LT 2일)", color:"#F0F7FF", hdr:["용어","정의","계산식","비고"],
    rows:[
      ["품목LT (영업일)","품목별 생산 소요 영업일","매칭: ①combo직접 ②단품코드평균\n③앞3글자평균 ④기본값6","2~6영업일"],
      ["조립LT (2일)","조립 소요 영업일 — 전 품목 고정","= 2영업일","전 라인 공통"],
      ["합계LT (영업일)","= 품목LT + 조립LT","예) 품목LT=3 → 합계 5영업일",""],
      ["합계LT (달력일)","영업일 → 달력일 환산","= 합계LT(영업일) × (31÷해당월영업일)","5영업일×1.409=7.0달력일"],
    ]},
  { title:"③ 목표재고 구성  (= LT수요 + 안전재고 + CAPA버퍼)", color:"#FFF9F0", hdr:["항목","정의","계산식","예시"],
    rows:[
      ["LT수요","리드타임 기간 예상 출고","= 일평균(μ) × 합계LT(달력일)","μ=1.0,LT=7.0 → 7.0"],
      ["안전재고(97%)","97% 서비스율 수요 변동 버퍼","= 1.88 × 일σ × √합계LT(달력일)","일σ=0.5,LT=7.0 → 2.5"],
      ["CAPA 버퍼","과거 CAPA 초과 이력 대응 추가량","= (초과월수÷유효월수)×(평균초과량÷31)×LT(달력일)","초과 없으면 0"],
      ["권장97%","3요소 합산 반올림","= LT수요+안전재고+CAPA버퍼","7.0+2.5+0.0=9.5 → 10"],
    ]},
  { title:"④ 목표재고 판정  (SCP목표재고 vs 권장97%)", color:"#fff", hdr:["판정","조건","기준식","조치"],
    rows:[
      ["심각부족","SCP < 권장×70%","SCP÷권장 < 70%","즉시 상향"],
      ["부족","SCP = 권장 70~99%","70%~100%","이번 SCP 조정"],
      ["적정","SCP = 권장 100~119%","100%~120%","현행 유지"],
      ["과잉","SCP ≥ 권장×120%","SCP÷권장 ≥ 120%","재고 부담"],
      ["목표미설정","SCP = 0","SCP=0","즉시 설정"],
      ["SCP미등재","SCP 시트 없음","—","등재 확인"],
    ]},
  { title:"⑤ 판매예측 판정  (SCP판매예측 수량 vs 최근3개월 평균출고)", color:"#fff", hdr:["판정","조건","기준식","비고"],
    rows:[
      ["심각부족","SCP < 평균×50%","SCP÷평균 < 50%","과소 예측 가능성"],
      ["부족","SCP = 평균 50~79%","50%~80%","재검토 권장"],
      ["적정","SCP = 평균 80~129%","80%~130%","합리적 범위"],
      ["과잉","SCP ≥ 평균×130%","SCP÷평균 ≥ 130%","공격적 예측"],
      ["SCP미등재","판매예측 없음","—","등재 확인"],
    ]},
];
const VROW={심각부족:"#FEE2E2",부족:"#FEF3C7",적정:"#D1FAE5",과잉:"#DBEAFE",목표미설정:"#F3F4F6",SCP미등재:"#F5F3FF"};

function TabTerms() {
  return <div style={{display:"flex",flexDirection:"column",gap:18}}>
    {TERMS.map((sec,si)=><div key={si} style={{borderRadius:12,border:"1px solid #E5E7EB",overflow:"hidden"}}>
      <div style={{padding:"9px 16px",background:"#1E3A5F",color:"#fff",fontWeight:700,fontSize:12}}>{sec.title}</div>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
        <thead><tr>
          {sec.hdr.map((h,hi)=><th key={hi} style={{padding:"6px 12px",background:"#2D4E7E",color:"#fff",
            fontSize:10,fontWeight:700,textAlign:"left",
            width:hi===0?"14%":hi===1?"30%":hi===2?"34%":"22%"}}>{h}</th>)}
        </tr></thead>
        <tbody>{sec.rows.map((row,ri)=>{
          const rb=VROW[row[0]]||(ri%2===0?sec.color:"#fff");
          return <tr key={ri} style={{background:rb,borderBottom:"1px solid #F3F4F6"}}>
            {row.map((cell,ci)=><td key={ci} style={{padding:"8px 12px",fontSize:11,verticalAlign:"top",
              fontWeight:ci===0?700:400,color:ci===0?"#1E3A5F":"#374151",whiteSpace:"pre-line",lineHeight:1.6}}>{cell||"—"}</td>)}
          </tr>;
        })}</tbody>
      </table>
    </div>)}
  </div>;
}

// ═══════════════════════════════════════════════════════
// 탭4: 라인별 요약
// ═══════════════════════════════════════════════════════
function TabLine({rows}) {
  const VLIST=["심각부족","부족","적정","과잉","목표미설정","SCP미등재"];
  const lineMap=useMemo(()=>{
    const m={};
    rows.forEach(r=>{ if(!m[r.line])m[r.line]={items:[],ltMin:99,ltMax:0};
      m[r.line].items.push(r);
      m[r.line].ltMin=Math.min(m[r.line].ltMin,r.totBiz);
      m[r.line].ltMax=Math.max(m[r.line].ltMax,r.totBiz); });
    return m;
  },[rows]);
  return <div style={{display:"flex",flexDirection:"column",gap:16}}>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(250px,1fr))",gap:12}}>
      {Object.entries(lineMap).map(([line,{items,ltMin,ltMax}])=>{
        const cnt=Object.fromEntries(VLIST.map(v=>[v,items.filter(r=>r.stockVerdict===v).length]));
        const urgent=(cnt.심각부족||0)+(cnt.부족||0);
        const lack=items.filter(r=>r.stockVerdict==="심각부족"||r.stockVerdict==="부족")
          .reduce((a,r)=>a+(r.scpStock!=null?Math.max(0,r.tgt97-r.scpStock):0),0);
        return <div key={line} style={{background:"#fff",borderRadius:12,padding:16,
          border:urgent>0?"1.5px solid #FCA5A5":"1px solid #E5E7EB",boxShadow:"0 1px 4px rgba(0,0,0,.06)"}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
            <div style={{fontWeight:800,fontSize:14,color:"#1E3A5F"}}>{line}</div>
            <div style={{fontSize:10,color:"#6B7280",textAlign:"right"}}>
              {items.length}개 품목<br/>LT {ltMin===ltMax?`${ltMin}일`:`${ltMin}~${ltMax}일`}
            </div>
          </div>
          <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:10}}>
            {VLIST.filter(v=>cnt[v]>0).map(v=>{ const c=VC[v]||{};
              return <div key={v} style={{display:"flex",alignItems:"center",gap:3,padding:"2px 7px",
                borderRadius:99,background:c.bg,border:`1px solid ${c.bdr}`}}>
                <span style={{width:6,height:6,borderRadius:99,background:c.dot,display:"inline-block"}}/>
                <span style={{fontSize:10,color:c.fg,fontWeight:600}}>{v} {cnt[v]}</span>
              </div>; })}
          </div>
          <div style={{fontSize:11,color:"#374151",display:"flex",gap:14}}>
            <span>SCP부족 <b style={{color:"#DC2626"}}>{urgent}건</b></span>
            <span>부족량 <b style={{color:"#DC2626"}}>{lack}</b></span>
          </div>
        </div>;
      })}
    </div>
    <div style={{background:"#fff",borderRadius:12,border:"1px solid #E5E7EB",overflow:"hidden"}}>
      <div style={{padding:"10px 16px",background:"#1E3A5F",color:"#fff",fontWeight:700,fontSize:12}}>라인별 SCP 적정성 현황</div>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
        <thead><tr style={{background:"#2D4E7E"}}>
          {["포장라인","품목수","합계LT범위","심각부족","부족","적정","과잉","SCP미등재","목표미설정","부족량합"].map(h=>
            <th key={h} style={{padding:"7px 10px",color:"#fff",fontSize:10,fontWeight:700,textAlign:"center",borderRight:"1px solid #3D5E8E"}}>{h}</th>)}
        </tr></thead>
        <tbody>{Object.entries(lineMap).map(([line,{items,ltMin,ltMax}],i)=>{
          const cnt=Object.fromEntries(VLIST.map(v=>[v,items.filter(r=>r.stockVerdict===v).length]));
          const lack=items.filter(r=>r.stockVerdict==="심각부족"||r.stockVerdict==="부족")
            .reduce((a,r)=>a+(r.scpStock!=null?Math.max(0,r.tgt97-r.scpStock):0),0);
          const bg=i%2===0?"#F9FAFB":"#fff";
          return <tr key={line} style={{borderBottom:"1px solid #F3F4F6"}}>
            <td style={{padding:"6px 10px",fontWeight:700,color:"#1E3A5F",background:bg}}>{line}</td>
            <td style={{padding:"6px 10px",textAlign:"center",background:bg}}>{items.length}</td>
            <td style={{padding:"6px 10px",textAlign:"center",color:"#6B7280",background:bg}}>
              {ltMin===ltMax?`${ltMin}일`:`${ltMin}~${ltMax}일`}
            </td>
            {VLIST.map(v=>{ const n=cnt[v]||0,c=VC[v]||{};
              return <td key={v} style={{padding:"6px 10px",textAlign:"center",
                background:n>0?c.bg:bg,color:n>0?c.fg:"#9CA3AF",fontWeight:n>0?700:400}}>{n}</td>; })}
            <td style={{padding:"6px 10px",textAlign:"center",fontWeight:lack>0?700:400,
              color:lack>0?"#DC2626":"#9CA3AF",background:bg}}>{lack>0?`-${lack}`:"—"}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </div>;
}

// ═══════════════════════════════════════════════════════
// ⚙️ CAPA 설정 탭  — 방식 C
//   Grid00 자동산출 + 수동보정 + JSON 저장/불러오기
//   품목별 점유율 분석 포함
// ═══════════════════════════════════════════════════════
function TabCapaSettings({capaMap, setCapaMap, gridResult, setGridResult}) {
  const [gridFiles,  setGridFiles]  = useState([]);
  const [jsonStatus, setJsonStatus] = useState('');   // 저장/불러오기 상태 메시지
  const [loading,    setLoading]    = useState(false);
  const [editRow,    setEditRow]    = useState(null);
  const [editVal,    setEditVal]    = useState('');
  const [newLine,    setNewLine]    = useState('');
  const [newCapa,    setNewCapa]    = useState('');
  const [expandLine, setExpandLine] = useState(null);
  const [viewMode,   setViewMode]   = useState('line'); // 'line' | 'item'
  const [itemSearch, setItemSearch] = useState('');

  // ── Grid00 산출 ──────────────────────────────────────
  const runGrid = async () => {
    if(!gridFiles.length){ setJsonStatus('⚠️ Grid00 파일을 먼저 선택하세요'); return; }
    setLoading(true); setJsonStatus('');
    try {
      const res = await parseGrid00Files(gridFiles);
      if(!res){ setJsonStatus('⚠️ 생산라인/계획량/최초포장계획일 컬럼을 찾지 못했습니다.'); setLoading(false); return; }
      setGridResult(res);
      setCapaMap(prev => {
        const next = {...prev};
        Object.entries(res.capaByLine).forEach(([line,v]) => {
          // 기존 수동 보정값 있으면 dailyCapa만 Grid00값으로 갱신, 나머지 메타 추가
          const existing = next[line];
          next[line] = {
            dailyCapa:  v.dailyCapa,
            avgMonthQty:v.avgMonthQty,
            totalQty:   v.totalQty,
            monthCount: v.monthCount,
            months:     v.months,
            source:     (existing?.source==='수동') ? '수동' : 'grid00',
            manualCapa: existing?.manualCapa ?? null,  // 수동 보정값 별도 보존
            updatedAt:  new Date().toISOString().slice(0,10),
          };
        });
        return next;
      });
      setJsonStatus(`✅ ${Object.keys(res.capaByLine).length}개 라인 산출 완료 (${res.months[0]}~${res.months[res.months.length-1]})`);
    } catch(e) { setJsonStatus('❌ 오류: '+e.message); }
    setLoading(false);
  };

  // ── JSON 저장 ────────────────────────────────────────
  const saveJson = () => {
    if(!Object.keys(capaMap).length){ setJsonStatus('⚠️ 저장할 CAPA 데이터가 없습니다.'); return; }
    const payload = {
      _meta: {
        version: '1.0',
        savedAt: new Date().toISOString().slice(0,10),
        description: '시디즈 평택 포장라인 일일 CAPA 설정 (SCP 점검 앱 연동)',
        lineCount: Object.keys(capaMap).length,
      },
      lines: capaMap,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `CAPA_설정_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    setJsonStatus(`✅ JSON 저장 완료 — ${Object.keys(capaMap).length}개 라인`);
  };

  // ── JSON 불러오기 ─────────────────────────────────────
  const loadJson = async (e) => {
    const file = e.target.files[0]; if(!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      // 구버전 호환: lines 키 있으면 사용, 없으면 전체가 lines
      const lines = parsed.lines || parsed;
      // 유효성 검사
      const valid = Object.entries(lines).every(([,v])=>
        typeof v === 'object' && v.dailyCapa > 0);
      if(!valid) { setJsonStatus('❌ 파일 형식이 올바르지 않습니다.'); return; }
      setCapaMap(lines);
      const meta = parsed._meta;
      setJsonStatus(`✅ 불러오기 완료 — ${Object.keys(lines).length}개 라인${meta?' (저장일: '+meta.savedAt+')':''}`);
    } catch(e) { setJsonStatus('❌ JSON 파싱 오류: '+e.message); }
    e.target.value = '';
  };

  // ── 편집 헬퍼 ────────────────────────────────────────
  const getCapaVal = line => {
    const v = capaMap[line];
    if(v) return typeof v==='object' ? (v.manualCapa??v.dailyCapa) : v;
    return LINE_CAPA_DEFAULT[line]??null;
  };
  const getSource = line => {
    const v = capaMap[line];
    if(!v) return 'default';
    if(typeof v==='object') return v.source||'수동';
    return '수동';
  };
  const saveEdit = (line) => {
    const n = parseInt(editVal);
    if(isNaN(n)||n<=0) { setJsonStatus('⚠️ 올바른 숫자를 입력하세요'); return; }
    setCapaMap(prev => {
      const existing = typeof prev[line]==='object' ? prev[line] : {};
      return {...prev, [line]: {...existing, dailyCapa:n, manualCapa:n, source:'수동',
        updatedAt: new Date().toISOString().slice(0,10)}};
    });
    setEditRow(null);
    setJsonStatus(`✅ ${line} → ${n}/일 수동 보정 저장됨. JSON 저장 버튼으로 파일에 반영하세요.`);
  };
  const addLine = () => {
    const n=parseInt(newCapa);
    if(!newLine.trim()||isNaN(n)||n<=0){ setJsonStatus('⚠️ 라인명과 CAPA 값을 모두 입력하세요'); return; }
    setCapaMap(prev=>({...prev,[newLine.trim()]:{dailyCapa:n,manualCapa:n,source:'수동',
      avgMonthQty:n*22,totalQty:0,monthCount:0,months:[],updatedAt:new Date().toISOString().slice(0,10)}}));
    setNewLine(''); setNewCapa('');
    setJsonStatus(`✅ ${newLine.trim()} 추가됨`);
  };
  const delLine = line => {
    setCapaMap(prev=>{ const n={...prev}; delete n[line]; return n; });
    setJsonStatus(`🗑 ${line} 삭제됨`);
  };
  const resetToDefault = () => {
    if(!window.confirm('현재 CAPA 설정을 모두 지우고 기본값으로 초기화하시겠습니까?')) return;
    setCapaMap({});
    setGridResult(null);
    setJsonStatus('🔄 기본값으로 초기화됨');
  };

  // ── 집계 데이터 ───────────────────────────────────────
  const lines = useMemo(()=>{
    return [...new Set([...Object.keys(capaMap),...Object.keys(LINE_CAPA_DEFAULT)])].sort();
  },[capaMap]);

  // 품목별 뷰 데이터
  const allItemData = useMemo(()=>{
    if(!gridResult) return [];
    const rows = [];
    Object.entries(gridResult.itemByLine).forEach(([line, items])=>{
      const lineCapa = getCapaVal(line)||0;
      const lineTot  = gridResult.capaByLine[line]?.totalQty||0;
      items.forEach(({item,qty,pct})=>{
        const itemDailyCapa = lineCapa>0 ? Math.round(lineCapa*(pct/100)) : null;
        rows.push({line,item,qty,pct,itemDailyCapa,lineTot});
      });
    });
    return rows.sort((a,b)=>b.qty-a.qty);
  },[gridResult,capaMap]);

  const filteredItems = useMemo(()=>{
    if(!itemSearch) return allItemData;
    const q=itemSearch.toLowerCase();
    return allItemData.filter(r=>r.item.toLowerCase().includes(q)||r.line.toLowerCase().includes(q));
  },[allItemData,itemSearch]);

  // ── 배지 ─────────────────────────────────────────────
  const SrcBadge = ({src}) => {
    const cfg = src==='grid00'?{bg:'#D1FAE5',fg:'#065F46',t:'Grid00 자동'}
               :src==='수동'  ?{bg:'#DBEAFE',fg:'#1E40AF',t:'수동 보정'}
               :                {bg:'#F3F4F6',fg:'#6B7280',t:'기본값'};
    return <span style={{padding:'1px 8px',borderRadius:99,fontSize:10,fontWeight:700,
      background:cfg.bg,color:cfg.fg}}>{cfg.t}</span>;
  };

  return <div style={{display:'flex',flexDirection:'column',gap:14}}>

    {/* ── 상단 워크플로 설명 ── */}
    <div style={{background:'#EFF6FF',borderLeft:'4px solid #2563EB',padding:'12px 16px',
      borderRadius:'0 10px 10px 0',fontSize:11,color:'#1E40AF',lineHeight:2}}>
      <b>📌 권장 워크플로 (연 1회)</b><br/>
      <span style={{color:'#374151'}}>
        ① Grid00 파일 1~12월 업로드 → ⚡ CAPA 산출 &nbsp;→&nbsp;
        ② 필요시 수동 보정 (✏️ 클릭) &nbsp;→&nbsp;
        ③ <b>💾 JSON 저장</b>으로 파일 보관<br/>
        <b>매월</b>: 🔃 JSON 불러오기 1번 → 바로 CAPA 분석 탭 반영 (Grid00 재업로드 불필요)
      </span>
    </div>

    {/* ── 액션 버튼 바 ── */}
    <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center',
      background:'#fff',borderRadius:12,padding:'14px 18px',border:'1px solid #E5E7EB'}}>

      {/* Grid00 업로드 + 산출 */}
      <div style={{display:'flex',gap:8,alignItems:'center',flex:1,minWidth:280}}>
        <label style={{display:'flex',alignItems:'center',gap:8,padding:'9px 14px',
          border:'2px dashed #CBD5E1',borderRadius:10,cursor:'pointer',background:'#FAFAFA',flex:1}}>
          <input type="file" accept=".xls,.xlsx,.csv" multiple style={{display:'none'}}
            onChange={e=>setGridFiles(Array.from(e.target.files))}/>
          <span style={{fontSize:18}}>🏭</span>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:'#1F2937'}}>Grid00 파일 선택</div>
            <div style={{fontSize:10,color:'#9CA3AF'}}>
              {gridFiles.length>0?`${gridFiles.length}개 선택 (${gridFiles.map(f=>f.name.slice(0,15)).join(', ')})`
                :'xls/xlsx/csv · 여러 달 한꺼번에 가능'}
            </div>
          </div>
        </label>
        <button onClick={runGrid} disabled={loading||!gridFiles.length}
          style={{padding:'9px 18px',borderRadius:10,border:'none',whiteSpace:'nowrap',
            background:(!gridFiles.length||loading)?'#CBD5E1':'#059669',
            color:'#fff',fontWeight:800,fontSize:12,cursor:'pointer'}}>
          {loading?'⏳':'⚡'} CAPA 산출
        </button>
      </div>

      <div style={{width:1,height:36,background:'#E5E7EB'}}/>

      {/* JSON 저장 / 불러오기 */}
      <button onClick={saveJson}
        style={{padding:'9px 18px',borderRadius:10,border:'1.5px solid #2563EB',background:'#EFF6FF',
          color:'#1E40AF',fontWeight:800,fontSize:12,cursor:'pointer',whiteSpace:'nowrap'}}>
        💾 JSON 저장
      </button>
      <label style={{padding:'9px 18px',borderRadius:10,border:'1.5px solid #059669',background:'#F0FDF4',
        color:'#065F46',fontWeight:800,fontSize:12,cursor:'pointer',whiteSpace:'nowrap'}}>
        <input type="file" accept=".json" style={{display:'none'}} onChange={loadJson}/>
        🔃 JSON 불러오기
      </label>

      <div style={{width:1,height:36,background:'#E5E7EB'}}/>

      <button onClick={resetToDefault}
        style={{padding:'9px 14px',borderRadius:10,border:'1px solid #FCA5A5',background:'#FEF2F2',
          color:'#DC2626',fontWeight:700,fontSize:11,cursor:'pointer',whiteSpace:'nowrap'}}>
        🔄 초기화
      </button>

      {/* 상태 메시지 */}
      {jsonStatus&&<div style={{fontSize:11,color:'#374151',padding:'6px 12px',
        background:'#F8FAFC',borderRadius:8,border:'1px solid #E5E7EB',maxWidth:400}}>
        {jsonStatus}
      </div>}
    </div>

    {/* ── 뷰 전환 탭 ── */}
    <div style={{display:'flex',gap:0,borderBottom:'2px solid #E5E7EB'}}>
      {[['line','🏭 라인별 CAPA'],['item','📦 품목별 점유율']].map(([k,l])=>
        <button key={k} onClick={()=>setViewMode(k)} style={{padding:'8px 20px',border:'none',
          background:'none',cursor:'pointer',fontWeight:700,fontSize:12,
          color:viewMode===k?'#1E3A5F':'#6B7280',
          borderBottom:viewMode===k?'2px solid #1E3A5F':'2px solid transparent',marginBottom:-2}}>
          {l}
        </button>)}
    </div>

    {/* ══ 라인별 뷰 ══ */}
    {viewMode==='line'&&<div style={{background:'#fff',borderRadius:12,border:'1px solid #E5E7EB',overflow:'hidden'}}>
      <div style={{background:'#1E3A5F',padding:'10px 16px',display:'flex',alignItems:'center'}}>
        <span style={{color:'#fff',fontWeight:800,fontSize:13}}>⚙️ 라인별 일일 CAPA</span>
        <span style={{color:'#93C5FD',fontSize:10,marginLeft:'auto'}}>
          {Object.keys(capaMap).length>0?`${Object.keys(capaMap).length}개 라인 설정됨`:'기본값 사용 중'} · ✏️ 클릭하여 수동 보정
        </span>
      </div>
      <div style={{overflowX:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
        <thead><tr style={{background:'#F8FAFC'}}>
          {['포장라인','일일 CAPA (확정값)','월평균 계획량','Grid00 분석 월수','최종 업데이트','출처','품목 점유율','액션'].map(h=>
            <th key={h} style={{padding:'8px 12px',textAlign:'left',color:'#475569',fontWeight:700,
              fontSize:10,borderBottom:'2px solid #E2E8F0',whiteSpace:'nowrap'}}>{h}</th>)}
        </tr></thead>
        <tbody>
          {lines.map((line,i)=>{
            const capa=getCapaVal(line), src=getSource(line);
            const v=capaMap[line];
            const gd = typeof v==='object'?v:null;
            const items=gridResult?.itemByLine[line];
            const isEdit=editRow===line, isExpand=expandLine===line;
            const bg=i%2===0?'#F9FAFB':'#fff';
            const hasManual = gd?.manualCapa&&gd.manualCapa!==gd.dailyCapa;
            return [
              <tr key={line} style={{borderBottom:'1px solid #F3F4F6',background:bg}}>
                <td style={{padding:'9px 12px',fontWeight:700,color:'#1E3A5F'}}>{line}</td>
                <td style={{padding:'9px 12px',minWidth:160}}>
                  {isEdit
                    ?<div style={{display:'flex',gap:6,alignItems:'center'}}>
                      <input type="number" value={editVal} autoFocus
                        onChange={e=>setEditVal(e.target.value)}
                        onKeyDown={e=>{if(e.key==='Enter')saveEdit(line);if(e.key==='Escape')setEditRow(null);}}
                        style={{width:72,padding:'4px 8px',borderRadius:6,border:'2px solid #3B82F6',
                          fontSize:13,fontWeight:800,textAlign:'center'}}/>
                      <span style={{fontSize:11,color:'#6B7280'}}>/일</span>
                      <button onClick={()=>saveEdit(line)} style={{padding:'4px 10px',borderRadius:6,
                        border:'none',background:'#059669',color:'#fff',fontWeight:700,fontSize:11,cursor:'pointer'}}>저장</button>
                      <button onClick={()=>setEditRow(null)} style={{padding:'4px 10px',borderRadius:6,
                        border:'none',background:'#E5E7EB',color:'#374151',fontWeight:700,fontSize:11,cursor:'pointer'}}>취소</button>
                    </div>
                    :<div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span style={{fontWeight:900,fontSize:16,color:'#1E3A5F',cursor:'pointer',
                        textDecoration:'underline dotted',textDecorationColor:'#93C5FD'}}
                        onClick={()=>{setEditRow(line);setEditVal(String(capa||''));}}>
                        {capa!=null?`${capa}`:<span style={{color:'#9CA3AF',fontSize:12}}>미설정</span>}
                      </span>
                      {capa!=null&&<span style={{fontSize:11,color:'#6B7280'}}>/일</span>}
                      {hasManual&&<span style={{fontSize:9,color:'#F97316',fontWeight:700}}>
                        ✏️보정({gd.manualCapa}←{gd.dailyCapa})
                      </span>}
                      <span style={{fontSize:11,color:'#3B82F6',cursor:'pointer',marginLeft:2}}
                        onClick={()=>{setEditRow(line);setEditVal(String(capa||''));}}>✏️</span>
                    </div>}
                </td>
                <td style={{padding:'9px 12px',color:'#6B7280',textAlign:'right'}}>
                  {gd?.avgMonthQty!=null?gd.avgMonthQty.toLocaleString():'—'}
                </td>
                <td style={{padding:'9px 12px',color:'#6B7280',textAlign:'center'}}>
                  {gd?.monthCount?`${gd.monthCount}개월`:'—'}
                  {gd?.months?.length>0&&<div style={{fontSize:9,color:'#9CA3AF'}}>
                    {gd.months[0]}~{gd.months[gd.months.length-1]}
                  </div>}
                </td>
                <td style={{padding:'9px 12px',color:'#9CA3AF',fontSize:10}}>
                  {gd?.updatedAt||'—'}
                </td>
                <td style={{padding:'9px 12px'}}><SrcBadge src={src}/></td>
                <td style={{padding:'9px 12px'}}>
                  {items?.length>0
                    ?<button onClick={()=>setExpandLine(isExpand?null:line)}
                       style={{fontSize:11,color:'#7C3AED',background:'none',border:'none',
                         cursor:'pointer',fontWeight:700,padding:0}}>
                       {isExpand?'▲ 닫기':
                         <span>▼ {items.length}개 품목 &nbsp;
                           <span style={{color:'#9CA3AF',fontWeight:400,fontSize:10}}>
                             TOP: {items[0].item}({items[0].pct}%)
                           </span>
                         </span>}
                     </button>
                    :<span style={{color:'#9CA3AF',fontSize:10}}>Grid00 필요</span>}
                </td>
                <td style={{padding:'9px 12px'}}>
                  <button onClick={()=>delLine(line)} style={{padding:'3px 10px',borderRadius:6,
                    border:'1px solid #FCA5A5',background:'#FEF2F2',color:'#DC2626',
                    fontSize:10,fontWeight:600,cursor:'pointer'}}>삭제</button>
                </td>
              </tr>,
              isExpand&&items&&
              <tr key={line+'_exp'} style={{background:'#F5F3FF'}}>
                <td colSpan={8} style={{padding:'10px 20px'}}>
                  <div style={{fontSize:11,fontWeight:700,color:'#5B21B6',marginBottom:8}}>
                    📊 {line} 품목별 점유율 (총 {items.length}개 품목)
                    {capa&&<span style={{color:'#9CA3AF',fontWeight:400,marginLeft:8}}>라인 CAPA {capa}/일 기준</span>}
                  </div>
                  {/* 점유율 바 차트 */}
                  <div style={{display:'flex',flexDirection:'column',gap:4,maxWidth:700}}>
                    {items.slice(0,15).map(({item,qty,pct})=>{
                      const itemCapa = capa?Math.round(capa*(pct/100)):null;
                      return <div key={item} style={{display:'flex',alignItems:'center',gap:10}}>
                        <span style={{width:100,fontSize:10,fontFamily:'monospace',fontWeight:700,
                          color:'#374151',textAlign:'right',flexShrink:0}}>{item}</span>
                        <div style={{flex:1,background:'#E9D5FF',borderRadius:4,height:14,overflow:'hidden'}}>
                          <div style={{width:`${pct}%`,background:'#7C3AED',height:'100%',borderRadius:4,
                            minWidth:2,transition:'width .3s'}}/>
                        </div>
                        <span style={{width:36,fontSize:11,fontWeight:700,color:'#5B21B6',flexShrink:0}}>
                          {pct}%
                        </span>
                        <span style={{fontSize:10,color:'#6B7280',width:80,flexShrink:0}}>
                          {qty.toLocaleString()}건
                        </span>
                        {itemCapa&&<span style={{fontSize:10,color:'#059669',fontWeight:700,
                          background:'#D1FAE5',padding:'1px 6px',borderRadius:99,flexShrink:0}}>
                          ~{itemCapa}/일
                        </span>}
                      </div>;
                    })}
                    {items.length>15&&<div style={{fontSize:10,color:'#9CA3AF',paddingLeft:110}}>
                      + {items.length-15}개 품목 더 있음 (품목별 뷰에서 전체 확인)
                    </div>}
                  </div>
                </td>
              </tr>
            ];
          })}
        </tbody>
      </table>
      </div>

      {/* 라인 추가 행 */}
      <div style={{padding:'12px 16px',borderTop:'2px solid #E5E7EB',background:'#F8FAFC',
        display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
        <span style={{fontSize:11,fontWeight:700,color:'#374151',flexShrink:0}}>+ 라인 직접 추가</span>
        <input value={newLine} onChange={e=>setNewLine(e.target.value)} placeholder="라인명 (예: T40-2_F)"
          style={{flex:1,minWidth:150,padding:'6px 10px',borderRadius:8,border:'1.5px solid #E5E7EB',fontSize:11}}/>
        <input type="number" value={newCapa} onChange={e=>setNewCapa(e.target.value)} placeholder="일일 CAPA"
          style={{width:100,padding:'6px 10px',borderRadius:8,border:'1.5px solid #E5E7EB',
            fontSize:12,fontWeight:700,textAlign:'center'}}
          onKeyDown={e=>e.key==='Enter'&&addLine()}/>
        <span style={{fontSize:11,color:'#9CA3AF',flexShrink:0}}>/일</span>
        <button onClick={addLine} style={{padding:'6px 18px',borderRadius:8,border:'none',
          background:'#1E3A5F',color:'#fff',fontWeight:700,fontSize:11,cursor:'pointer'}}>추가</button>
      </div>
    </div>}

    {/* ══ 품목별 점유율 뷰 ══ */}
    {viewMode==='item'&&<div style={{background:'#fff',borderRadius:12,border:'1px solid #E5E7EB',overflow:'hidden'}}>
      <div style={{background:'#5B21B6',padding:'10px 16px',display:'flex',alignItems:'center',gap:10}}>
        <span style={{color:'#fff',fontWeight:800,fontSize:13}}>📦 품목별 라인 점유율 전체</span>
        <span style={{color:'#DDD6FE',fontSize:10,marginLeft:'auto'}}>
          Grid00 분석 기반 | 일일CAPA 추정 = 라인CAPA × 점유율%
        </span>
      </div>
      {!gridResult
        ?<div style={{padding:40,textAlign:'center',color:'#9CA3AF',fontSize:12}}>
           Grid00 파일을 업로드하고 CAPA 산출을 먼저 실행하세요.
         </div>
        :<>
          <div style={{padding:'10px 16px',borderBottom:'1px solid #E5E7EB',display:'flex',gap:10,alignItems:'center'}}>
            <input value={itemSearch} onChange={e=>setItemSearch(e.target.value)}
              placeholder="품목코드 또는 라인명 검색…"
              style={{flex:1,maxWidth:320,padding:'6px 12px',borderRadius:8,border:'1.5px solid #E5E7EB',fontSize:12}}/>
            <span style={{fontSize:11,color:'#6B7280'}}>{filteredItems.length}개</span>
          </div>
          <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
            <thead><tr style={{background:'#F5F3FF'}}>
              {['포장라인','품목코드(단품)','계획량 합계','라인 점유율','추정 일일CAPA','점유율 바'].map(h=>
                <th key={h} style={{padding:'8px 12px',textAlign:h==='점유율 바'?'left':'center',
                  color:'#5B21B6',fontWeight:700,fontSize:10,borderBottom:'2px solid #DDD6FE'}}>{h}</th>)}
            </tr></thead>
            <tbody>
              {filteredItems.map((r,i)=>{
                const bg=i%2===0?'#FAF8FF':'#fff';
                return <tr key={`${r.line}-${r.item}`} style={{borderBottom:'1px solid #F3F4F6',background:bg}}>
                  <td style={{padding:'7px 12px',fontWeight:700,color:'#5B21B6'}}>{r.line}</td>
                  <td style={{padding:'7px 12px',fontFamily:'monospace',fontWeight:700,
                    textAlign:'center',color:'#374151'}}>{r.item}</td>
                  <td style={{padding:'7px 12px',textAlign:'right',color:'#374151'}}>
                    {r.qty.toLocaleString()}
                  </td>
                  <td style={{padding:'7px 12px',textAlign:'center',fontWeight:700,
                    color: r.pct>=30?'#DC2626':r.pct>=15?'#D97706':'#374151'}}>
                    {r.pct}%
                  </td>
                  <td style={{padding:'7px 12px',textAlign:'center',fontWeight:700,color:'#059669'}}>
                    {r.itemDailyCapa!=null?`~${r.itemDailyCapa}/일`:'—'}
                  </td>
                  <td style={{padding:'7px 16px',minWidth:180}}>
                    <div style={{background:'#E9D5FF',borderRadius:4,height:12,overflow:'hidden'}}>
                      <div style={{width:`${Math.min(r.pct,100)}%`,background:'#7C3AED',
                        height:'100%',borderRadius:4,minWidth:2}}/>
                    </div>
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
          </div>
        </>}
    </div>}

  </div>;
}


function UtilBar({pct,color}) {
  return <div style={{flex:1,background:"#F1F5F9",borderRadius:3,height:11,position:"relative",overflow:"hidden"}}>
    <div style={{background:color,height:"100%",width:`${Math.min(pct||0,100)}%`,borderRadius:3}}/>
    {[75,90,100].map(x=><div key={x} style={{position:"absolute",top:0,left:`${x}%`,height:"100%",
      borderLeft:`1.5px dashed ${x===100?"#DC2626":x===90?"#F97316":"#D97706"}`}}/>)}
  </div>;
}

function TabCapa({rows,bizDays,capaMap}) {
  const BIZ=bizDays||BIZ_DEFAULT;
  // capaMap이 없으면 DEFAULT 사용
  const LINE_CAPA = capaMap && Object.keys(capaMap).length>0
    ? Object.fromEntries(Object.entries(capaMap).map(([k,v])=>[k, typeof v==='object'?v.dailyCapa:v]))
    : LINE_CAPA_DEFAULT;
  const lineMap=useMemo(()=>{
    const m={};
    rows.forEach(r=>{ const l=r.line||"기타";
      if(!m[l])m[l]={scpSellSum:0,mu월Sum:0,items:[]};
      m[l].items.push(r);
      if(r.scpSell!=null)m[l].scpSellSum+=r.scpSell;
      m[l].mu월Sum+=r.mu월||0; });
    return m;
  },[rows]);

  const lineData=useMemo(()=>{
    return Object.entries(lineMap).map(([line,d])=>{
      const capa=LINE_CAPA[line]||null;
      const scpDailyPart=d.scpSellSum/BIZ, prevDailyEst=d.mu월Sum/31;
      const utilScp=capa?(scpDailyPart/capa)*100:null;
      const utilPrev=capa?(prevDailyEst/capa)*100:null;
      return {line,capa,scpSellSum:d.scpSellSum,scpDailyPart,prevDailyEst,
              utilScp,utilPrev,items:d.items,capaExItems:d.items.filter(r=>r.cb>0)};
    }).sort((a,b)=>{ const r=x=>(x.utilScp??0)>=100?0:(x.utilScp??0)>=90?1:(x.utilScp??0)>=75?2:3;
      return r(a)-r(b)||a.line.localeCompare(b.line); });
  },[lineMap,BIZ]);

  const overCount=lineData.filter(d=>d.utilScp!=null&&d.utilScp>=100).length;
  const warnCount=lineData.filter(d=>d.utilScp!=null&&d.utilScp>=75&&d.utilScp<100).length;
  const cbCount=rows.filter(r=>r.cb>0).length;

  return <div style={{display:"flex",flexDirection:"column",gap:16}}>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
      {[{label:"CAPA 초과 라인",value:overCount,color:"#DC2626",bg:"#FEE2E2"},
        {label:"위험/주의 라인", value:warnCount, color:"#F97316",bg:"#FFF7ED"},
        {label:"CAPA버퍼 발생 품목",value:cbCount,color:"#7C3AED",bg:"#F5F3FF"},
        {label:"분석 기준",value:`${BIZ}영업일`,color:"#1E3A5F",bg:"#EFF6FF"},
      ].map((k,i)=><div key={i} style={{background:k.bg,borderRadius:12,padding:"14px 16px",border:`1px solid ${k.color}30`}}>
        <div style={{fontSize:22,fontWeight:900,color:k.color,lineHeight:1}}>{k.value}</div>
        <div style={{fontSize:11,color:"#374151",fontWeight:600,marginTop:4}}>{k.label}</div>
      </div>)}
    </div>
    <div style={{background:"#EFF6FF",borderLeft:"4px solid #2563EB",padding:"10px 14px",
      borderRadius:"0 8px 8px 0",fontSize:11,color:"#1E40AF",lineHeight:1.7}}>
      💡 <b>계산 방식</b>: 과소품목 SCP 판매예상(수량) ÷ 영업일({BIZ}일) = 라인 일일 부하 (과소품목 기여분).
      전월 부하 = 최근3개월평균 ÷ 31일. CAPA 값은 기존 분석 확정값 기준.
    </div>
    {/* 상세 테이블 */}
    <div style={{background:"#fff",borderRadius:12,border:"1px solid #E5E7EB",overflow:"hidden"}}>
      <div style={{background:"#1E3A5F",padding:"10px 16px",display:"flex",alignItems:"center"}}>
        <span style={{color:"#fff",fontWeight:800,fontSize:13}}>📋 포장라인별 CAPA 상세</span>
        <span style={{color:"#93C5FD",fontSize:10,marginLeft:"auto"}}>과소품목 기여분 기준 | 기준선 75%/90%/100%</span>
      </div>
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
          <thead><tr style={{background:"#F8FAFC"}}>
            {[["포장라인","left",100],["품목수","center",60],["SCP판매예상\n합산(수량)","right",90],
              ["일일부하\n(과소기여)","right",80],["전월일일\n평균부하","right",80],["일일\nCAPA","right",70],
              ["SCP 부하율","center",155],["전월 부하율","center",155],["상태","center",80],["CAPA버퍼\n발생품목","center",80],
            ].map(([t,al,w])=><th key={t} style={{padding:"8px 10px",textAlign:al,color:"#475569",fontWeight:700,
              fontSize:10,whiteSpace:"pre-line",lineHeight:1.3,borderBottom:"2px solid #E2E8F0",width:w}}>{t}</th>)}
          </tr></thead>
          <tbody>{lineData.map((d,i)=>{
            const ut=getCapaSt(d.utilScp), utP=getCapaSt(d.utilPrev);
            const rowBg=d.utilScp>=100?"#FFF5F5":d.utilScp>=90?"#FFF8F0":"#fff";
            const bdrL=d.utilScp>=100?"4px solid #DC2626":d.utilScp>=90?"3px solid #F97316":"none";
            return <tr key={d.line} style={{borderLeft:bdrL,borderBottom:"1px solid #F3F4F6",background:rowBg}}>
              <td style={{padding:"9px 12px",fontWeight:700,color:d.capa==null?"#9CA3AF":"#1E3A5F",
                fontStyle:d.capa==null?"italic":"normal"}}>{d.line}</td>
              <td style={{padding:"9px 10px",textAlign:"center"}}>{d.items.length}</td>
              <td style={{padding:"9px 12px",textAlign:"right",fontWeight:600,color:"#2563EB"}}>
                {d.scpSellSum>0?d.scpSellSum.toLocaleString():"—"}
              </td>
              <td style={{padding:"9px 12px",textAlign:"right",fontWeight:700,color:"#7C3AED"}}>
                {d.scpDailyPart>0?d.scpDailyPart.toFixed(1):"—"}
              </td>
              <td style={{padding:"9px 12px",textAlign:"right",color:"#64748B"}}>{d.prevDailyEst.toFixed(1)}</td>
              <td style={{padding:"9px 12px",textAlign:"right",fontWeight:600}}>
                {d.capa!=null?d.capa:"미등록"}
              </td>
              <td style={{padding:"6px 10px",minWidth:140}}>
                {d.utilScp!=null
                  ?<div style={{display:"flex",alignItems:"center",gap:6}}>
                    <UtilBar pct={d.utilScp} color={ut.color}/>
                    <span style={{fontSize:11,fontWeight:700,color:ut.color,width:52,textAlign:"right"}}>
                      {ut.icon}{d.utilScp.toFixed(1)}%
                    </span>
                  </div>
                  :<span style={{color:"#9CA3AF",fontSize:10}}>—</span>}
              </td>
              <td style={{padding:"6px 10px",minWidth:140}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <UtilBar pct={d.utilPrev||0} color={utP.color}/>
                  <span style={{fontSize:11,fontWeight:700,color:utP.color,width:52,textAlign:"right"}}>
                    {(d.utilPrev||0).toFixed(1)}%
                  </span>
                </div>
              </td>
              <td style={{padding:"9px 10px",textAlign:"center"}}>
                <span style={{padding:"2px 7px",borderRadius:99,fontSize:10,fontWeight:700,
                  background:ut.color+"20",color:ut.color}}>{ut.icon} {ut.label}</span>
              </td>
              <td style={{padding:"9px 10px",textAlign:"center",
                fontWeight:d.capaExItems.length>0?700:400,
                color:d.capaExItems.length>0?"#7C3AED":"#9CA3AF"}}>
                {d.capaExItems.length>0?`${d.capaExItems.length}개`:"없음"}
              </td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </div>
    {/* 가동률 바 차트 */}
    <div style={{background:"#fff",borderRadius:12,padding:18,border:"1px solid #E5E7EB"}}>
      <div style={{fontWeight:800,color:"#1E3A5F",fontSize:13,marginBottom:4,borderLeft:"3px solid #2563EB",paddingLeft:8}}>
        🏭 라인별 CAPA 가동률 — 전월 평균 vs SCP 계획
      </div>
      <div style={{fontSize:10,color:"#64748B",marginBottom:14,paddingLeft:11}}>기준선: 🟡 75% / ⚠️ 90% / 🚨 100%</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(230px,1fr))",gap:10}}>
        {lineData.filter(d=>d.capa!=null).map(d=>{
          const ut=getCapaSt(d.utilScp), utP=getCapaSt(d.utilPrev);
          const cbg=d.utilScp>=100?"#FFF5F5":d.utilScp>=90?"#FFF8F0":"#fff";
          const cbdr=d.utilScp>=100?"#FCA5A5":d.utilScp>=90?"#FDBA74":"#E2E8F0";
          return <div key={d.line} style={{border:`1px solid ${cbdr}`,borderRadius:8,padding:"10px 14px",background:cbg}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
              <span style={{fontWeight:700,fontSize:12}}>{d.line}</span>
              <span style={{fontSize:10,color:"#64748B"}}>CAPA {d.capa}/일</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
              <span style={{fontSize:10,color:"#64748B",width:36}}>전월</span>
              <UtilBar pct={d.utilPrev||0} color={utP.color}/>
              <span style={{fontSize:11,fontWeight:700,color:utP.color,width:42,textAlign:"right"}}>{(d.utilPrev||0).toFixed(1)}%</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:10,color:"#7C3AED",width:36,fontWeight:700}}>SCP↓</span>
              <UtilBar pct={d.utilScp||0} color={ut.color}/>
              <span style={{fontSize:11,fontWeight:700,color:ut.color,width:42,textAlign:"right"}}>
                {d.utilScp!=null?`${d.utilScp.toFixed(1)}%`:"—"}
              </span>
            </div>
          </div>;
        })}
      </div>
    </div>
    {/* CAPA 버퍼 품목 */}
    {rows.filter(r=>r.cb>0).length>0&&
      <div style={{background:"#fff",borderRadius:12,border:"1px solid #E5E7EB",overflow:"hidden"}}>
        <div style={{background:"#5B21B6",padding:"10px 16px",color:"#fff",fontWeight:700,fontSize:12}}>
          📊 CAPA 버퍼 발생 품목 상세
        </div>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
          <thead><tr style={{background:"#F5F3FF"}}>
            {["포장라인","조합코드","품목명","월평균(μ)","CAPA버퍼","권장97%","SCP목표재고","판정"].map(h=>
              <th key={h} style={{padding:"7px 10px",color:"#5B21B6",fontSize:10,fontWeight:700,
                textAlign:"center",borderBottom:"1px solid #DDD6FE"}}>{h}</th>)}
          </tr></thead>
          <tbody>{rows.filter(r=>r.cb>0).map((r,i)=>{
            const bg=i%2===0?"#FAF8FF":"#fff", c=VC[r.stockVerdict]||{};
            return <tr key={r.combo} style={{borderBottom:"1px solid #F3F4F6"}}>
              <td style={{padding:"6px 10px",fontWeight:700,color:"#5B21B6",background:bg}}>{r.line}</td>
              <td style={{padding:"6px 10px",fontSize:10,fontFamily:"monospace",background:bg}}>{r.combo}</td>
              <td style={{padding:"6px 10px",fontSize:10,background:bg,maxWidth:180,
                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.name}</td>
              <td style={{padding:"6px 10px",textAlign:"center",background:bg}}>{r.mu월}</td>
              <td style={{padding:"6px 10px",textAlign:"center",fontWeight:700,color:"#7C3AED",background:"#F5F3FF"}}>{r.cb}</td>
              <td style={{padding:"6px 10px",textAlign:"center",fontWeight:700,color:"#1E40AF",background:"#DBEAFE"}}>{r.tgt97}</td>
              <td style={{padding:"6px 10px",textAlign:"center",background:bg}}>
                {r.scpStock!=null?r.scpStock:"—"}
              </td>
              <td style={{padding:"6px 10px",textAlign:"center",background:c.bg||bg}}>
                <Badge v={r.stockVerdict} sm/>
              </td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
  </div>;
}

// ═══════════════════════════════════════════════════════
// 메인 앱
// ═══════════════════════════════════════════════════════
export default function App() {
  const [ltFile,     setLtFile]    = useState(null);
  const [scpFile,    setScpFile]   = useState(null);
  const [outFile,    setOutFile]   = useState(null);
  const [lineFile,   setLineFile]  = useState(null);  // 포장라인 매핑 (선택)
  const [rows,       setRows]      = useState(null);
  const [bizDays,    setBizDays]   = useState(22);
  const [loading,    setLoading]   = useState(false);
  const [error,      setError]     = useState("");
  const [tab,        setTab]       = useState("main");
  const [filter,     setFilter]    = useState("전체");
  const [sortKey,    setSortKey]   = useState("라인순");
  const [month,      setMonth]     = useState("3월");
  const [capaMap,    setCapaMap]   = useState({});
  const [gridResult, setGridResult]= useState(null);

  // ── 포장라인 매핑 파싱: combo → line ───────────────────
  async function parseLineMap(file) {
    if(!file) return {};
    let rows2;
    if(file.name.toLowerCase().endsWith(".csv"))
      rows2=await new Promise((res,rej)=>Papa.parse(file,{header:false,skipEmptyLines:true,complete:r=>res(r.data),error:rej}));
    else { const wb=await readXlsx(file); rows2=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:""}); }
    // 헤더 탐지: combo/조합코드 컬럼, line/포장라인 컬럼
    const hi=rows2.findIndex(r=>r.some(v=>String(v).includes("조합")||String(v).toLowerCase().includes("combo")));
    const data=hi>=0?rows2.slice(hi+1):rows2.slice(1);
    const hdr=hi>=0?rows2[hi].map(v=>String(v).trim()):[];
    const ci=k=>hdr.findIndex(h=>h.includes(k));
    const comboC = hi>=0?(ci("조합")>=0?ci("조합"):ci("combo")>=0?ci("combo"):0):0;
    const lineC  = hi>=0?(ci("라인")>=0?ci("라인"):ci("line")>=0?ci("line"):1):1;
    const map={};
    data.forEach(r=>{ const c=String(r[comboC]||"").trim(), l=String(r[lineC]||"").trim(); if(c&&l)map[c]=l; });
    return map;
  }

  const run = useCallback(async () => {
    if (!ltFile||!scpFile||!outFile) { setError("③ SCP·② 제조LT·④ 출고내역 3개 파일을 업로드하세요."); return; }
    setLoading(true); setError("");
    try {
      // LT 파싱
      let ltRows;
      if(ltFile.name.toLowerCase().endsWith(".csv"))
        ltRows=await new Promise((res,rej)=>Papa.parse(ltFile,{header:false,skipEmptyLines:true,complete:r=>res(r.data),error:rej}));
      else { const wb=await readXlsx(ltFile); ltRows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:""}); }
      const ltMaps=buildLtMaps(ltRows);

      // 출고내역 파싱
      let outRows;
      if(outFile.name.toLowerCase().endsWith(".csv")) outRows=await readCsvAuto(outFile);
      else { const wb=await readXlsx(outFile); outRows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:""}); }
      const demand=buildDemand(outRows);

      // SCP 파싱 → 전체 품목 자동 추출
      const scpWb=await readXlsx(scpFile);
      const {scpMap, allCombos}=parseScpFull(scpWb);
      if(!allCombos.length) throw new Error("SCP 파일에서 품목을 읽지 못했습니다. 시트명에 'SCP'가 포함되어야 합니다.");

      // 포장라인 매핑 (선택 파일)
      const lineMap = await parseLineMap(lineFile);

      const result=allCombos.map(({combo, name})=>{
        const stat=calcTarget(ltMaps,demand,combo,bizDays);
        const scp=scpMap[combo]||{};
        const line=lineMap[combo]||"—";
        return { combo, line, name: name||scp.name||"",
          ...stat, scpStock:scp.stock??null, scpSell:scp.sell??null,
          stockVerdict:judgeStock(scp.stock,stat.tgt97), sellVerdict:judgeSell(scp.sell,stat.mu월) };
      });
      result.sort((a,b)=>a.line.localeCompare(b.line)||a.combo.localeCompare(b.combo));
      setRows(result); setTab("main");
    } catch(e) { console.error(e); setError("오류: "+e.message); }
    setLoading(false);
  },[ltFile,scpFile,outFile,lineFile,bizDays]);

  const summary=useMemo(()=>{
    if(!rows) return null;
    const cnt=(k,v)=>rows.filter(r=>r[k]===v).length;
    return {
      stock:Object.fromEntries(["심각부족","부족","적정","과잉","목표미설정","SCP미등재"].map(v=>[v,cnt("stockVerdict",v)])),
      sell: Object.fromEntries(["심각부족","부족","적정","과잉","SCP미등재"].map(v=>[v,cnt("sellVerdict",v)])),
      total:rows.length,
      stockLack:rows.filter(r=>r.stockVerdict==="심각부족"||r.stockVerdict==="부족")
        .reduce((a,r)=>a+(r.scpStock!=null?Math.max(0,r.tgt97-r.scpStock):0),0),
    };
  },[rows]);

  const TABS=[
    {key:"main",   label:"📋 목표재고·판매예측"},
    {key:"calc",   label:"🔢 품목별 계산식"},
    {key:"terms",  label:"📖 용어·계산식"},
    {key:"line",   label:"🏭 라인별 요약"},
    {key:"capaset",label:"⚙️ CAPA 설정"},
  ];
  const allReady=ltFile&&scpFile&&outFile;

  return (
    <div style={{fontFamily:"'Malgun Gothic','Apple SD Gothic Neo',sans-serif",minHeight:"100vh",background:"#F1F5F9"}}>
      <div style={{background:"#1E3A5F",padding:"13px 24px",display:"flex",alignItems:"center",
        gap:16,boxShadow:"0 2px 8px rgba(0,0,0,.25)"}}>
        <div>
          <div style={{fontWeight:800,fontSize:15,color:"#fff"}}>시디즈 평택 SCP 적정성 점검</div>
          <div style={{fontSize:10,color:"#93C5FD",marginTop:1}}>
            제조LT + 출고실적 기반 권장값 vs SCP 목표재고·판매예측(수량) | SCP 전체 품목 기준
          </div>
        </div>
        <select value={month} onChange={e=>setMonth(e.target.value)} style={{marginLeft:"auto",
          padding:"5px 10px",borderRadius:8,border:"none",fontSize:12,fontWeight:700,background:"#2D4E7E",color:"#fff",cursor:"pointer"}}>
          {["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"].map(m=><option key={m}>{m}</option>)}
        </select>
      </div>

      <div style={{maxWidth:1700,margin:"0 auto",padding:"16px"}}>

        {/* ── 업로드 & 실행 패널 ── */}
        <div style={{background:"#fff",borderRadius:12,padding:18,marginBottom:14,boxShadow:"0 1px 4px rgba(0,0,0,.07)"}}>
          <div style={{fontWeight:700,fontSize:12,color:"#374151",marginBottom:4}}>📁 분석 파일 업로드 ({month} 기준)</div>
          <div style={{fontSize:10,color:"#6B7280",marginBottom:12,background:"#F8FAFC",padding:"6px 10px",borderRadius:8}}>
            💡 <b>SCP 파일의 전체 품목을 자동으로 분석합니다.</b>
            포장라인 정보가 필요하면 ④ 포장라인 매핑 파일을 추가하세요 (선택).
          </div>
          <div style={{display:"flex",gap:10,alignItems:"flex-end",flexWrap:"wrap"}}>

            {/* ① 제조 LT */}
            <UploadZone label="① 품목별 제조 LT" icon="⚙️"
              hint="CODE·리드타임 컬럼 포함 CSV/XLSX" file={ltFile} onFile={setLtFile}/>

            {/* ② SCP */}
            <UploadZone label={`② SCP 자료 (${month})`} icon="📅"
              hint="시디즈 의자 SCP 시트 포함 XLSX" file={scpFile} onFile={setScpFile}/>

            {/* ③ 출고내역 */}
            <UploadZone label="③ 과거 출고 내역" icon="📦"
              hint="평택의자 출고량 CSV/XLSX" file={outFile} onFile={setOutFile}/>

            {/* ④ 포장라인 매핑 (선택) */}
            <div style={{display:"flex",flexDirection:"column",gap:4,flex:1,minWidth:130}}>
              <UploadZone label="④ 포장라인 매핑 (선택)" icon="🏭"
                hint={"조합코드, 포장라인\nCSV/XLSX (없으면 '—')"} file={lineFile} onFile={setLineFile}/>
              {lineFile&&<button onClick={()=>setLineFile(null)}
                style={{fontSize:10,padding:"2px 8px",borderRadius:6,border:"1px solid #FCA5A5",
                  background:"#FEF2F2",color:"#DC2626",cursor:"pointer",alignSelf:"flex-end"}}>
                ✕ 제거
              </button>}
            </div>

            {/* 실행 버튼 */}
            <div style={{flexShrink:0,display:"flex",flexDirection:"column",gap:8,minWidth:120}}>
              <div style={{display:"flex",gap:6,alignItems:"center",justifyContent:"center"}}>
                <label style={{fontSize:11,color:"#374151",fontWeight:600}}>영업일</label>
                <input type="number" value={bizDays} min={1} max={31}
                  onChange={e=>setBizDays(Number(e.target.value))}
                  style={{width:50,padding:"4px 6px",borderRadius:8,border:"1.5px solid #E5E7EB",
                    fontSize:12,fontWeight:700,textAlign:"center"}}/>
                <span style={{fontSize:11,color:"#9CA3AF"}}>일</span>
              </div>
              <button onClick={run} disabled={loading||!allReady}
                style={{padding:"12px 20px",borderRadius:10,border:"none",
                  background:!allReady?"#CBD5E1":"#1E3A5F",color:"#fff",
                  fontWeight:800,fontSize:13,cursor:"pointer",whiteSpace:"nowrap"}}>
                {loading?"⏳ 분석 중…":"▶ 분석 실행"}
              </button>
              <div style={{fontSize:10,textAlign:"center",color:allReady?"#059669":"#9CA3AF"}}>
                {allReady?"✓ 준비 완료":"① ② ③ 필수"}
              </div>
            </div>
          </div>
          {error&&<div style={{marginTop:10,padding:"8px 12px",background:"#FEF2F2",borderRadius:8,
            fontSize:11,color:"#B91C1C",border:"1px solid #FCA5A5"}}>⚠️ {error}</div>}
        </div>

        {summary&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:12,marginBottom:14}}>
          {[{title:"목표재고 적정성 — SCP목표재고 vs 권장97%",key:"stock",
             vlist:["심각부족","부족","적정","과잉","목표미설정","SCP미등재"]},
            {title:"판매예측 적정성 — SCP판매예측(수량) vs 최근3개월평균",key:"sell",
             vlist:["심각부족","부족","적정","과잉","SCP미등재"]},
          ].map(({title,key,vlist})=><div key={key} style={{background:"#fff",borderRadius:12,padding:16,boxShadow:"0 1px 4px rgba(0,0,0,.07)"}}>
            <div style={{fontWeight:700,fontSize:11,color:"#374151",marginBottom:10}}>{title} — {summary.total}개 품목</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {vlist.map(v=>summary[key][v]>0&&<KpiCard key={v} label={v} value={summary[key][v]} urgent={v==="심각부족"}/>)}
            </div>
          </div>)}
          <div style={{background:"#1E3A5F",borderRadius:12,padding:16,display:"flex",
            flexDirection:"column",justifyContent:"center",alignItems:"center",minWidth:120}}>
            <div style={{fontSize:30,fontWeight:900,color:"#FCA5A5",lineHeight:1}}>{summary.stockLack}</div>
            <div style={{fontSize:11,color:"#93C5FD",fontWeight:600,marginTop:4}}>SCP 부족량 합계</div>
            <div style={{fontSize:9,color:"#6B9EC8",marginTop:2}}>심각부족+부족 기준</div>
          </div>
        </div>}

        {/* ── 탭 패널: CAPA 설정은 항상, 나머지는 분석 후 ── */}
        <div style={{background:"#fff",borderRadius:12,padding:20,boxShadow:"0 1px 4px rgba(0,0,0,.07)"}}>
          <Tabs items={TABS} active={tab} onChange={setTab}/>
          {tab==="capaset"
            ? <TabCapaSettings capaMap={capaMap} setCapaMap={setCapaMap}
                gridResult={gridResult} setGridResult={setGridResult}/>
            : rows
              ? <>
                  {tab==="main"  && <TabMain rows={rows} filter={filter} setFilter={setFilter} sortKey={sortKey} setSortKey={setSortKey}/>}
                  {tab==="calc"  && <TabCalc rows={rows}/>}
                  {tab==="terms" && <TabTerms/>}
                  {tab==="line"  && <TabLine rows={rows}/>}
                </>
              : tab==="terms"
                ? <TabTerms/>
                : <div style={{padding:"48px 0",textAlign:"center",color:"#9CA3AF"}}>
                    <div style={{fontSize:40,marginBottom:12}}>📊</div>
                    <div style={{fontWeight:700,fontSize:14,color:"#374151",marginBottom:8}}>
                      ① ② ③ 파일 업로드 후 분석을 실행하세요
                    </div>
                    <div style={{fontSize:11,lineHeight:2,color:"#6B7280"}}>
                      <b>① 품목별 제조 LT</b> — CODE·리드타임 컬럼 포함 CSV/XLSX<br/>
                      <b>② SCP 자료</b> — 시디즈 의자 SCP 시트 포함 XLSX (전체 품목 자동 추출)<br/>
                      <b>③ 과거 출고 내역</b> — 평택의자 출고량 CSV/XLSX<br/>
                      <b>④ 포장라인 매핑</b> — 조합코드↔포장라인 CSV/XLSX <span style={{color:"#9CA3AF"}}>(선택)</span>
                    </div>
                    <div style={{marginTop:12,display:"inline-flex",gap:8,flexWrap:"wrap",
                      justifyContent:"center",fontSize:10,color:"#374151"}}>
                      <span style={{padding:"4px 12px",borderRadius:99,background:"#EFF6FF",color:"#1E40AF",fontWeight:700}}>
                        LT 매핑: combo 직접 → 단품코드 평균 → 앞 3글자 평균 → 기본값 6일
                      </span>
                      <span style={{padding:"4px 12px",borderRadius:99,background:"#F0FDF4",color:"#065F46",fontWeight:700}}>
                        ⚙️ CAPA 설정은 지금 바로 사용 가능
                      </span>
                    </div>
                  </div>}
        </div>
      </div>
    </div>
  );
}
