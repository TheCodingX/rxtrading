#!/usr/bin/env node
'use strict';
// Download Yahoo Finance: SPX (^GSPC), VIX (^VIX), DXY (DX-Y.NYB), Gold (GC=F), US10Y (^TNX)
// Daily history 2y. Saved to /tmp/tradfi-*.json
const fs=require('fs');const https=require('https');
const now=Math.floor(Date.now()/1000);
const start=now-730*86400; // 2y
const SYMBOLS=[
  {key:'spx',yahoo:'^GSPC'},
  {key:'vix',yahoo:'^VIX'},
  {key:'dxy',yahoo:'DX-Y.NYB'},
  {key:'gold',yahoo:'GC=F'},
  {key:'tnx',yahoo:'^TNX'}
];
function hg(u){return new Promise((r,j)=>{const req=https.request(u,{headers:{'User-Agent':'Mozilla/5.0'}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{r({status:res.statusCode,data:d});}catch(e){j(e);}});});req.on('error',j);req.end();});}
async function getYahoo(sym){
  const u=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${start}&period2=${now}&interval=1d`;
  const r=await hg(u);
  if(r.status!==200)return null;
  try{const j=JSON.parse(r.data);const result=j.chart&&j.chart.result&&j.chart.result[0];if(!result)return null;const ts=result.timestamp||[];const q=result.indicators&&result.indicators.quote&&result.indicators.quote[0]||{};const out=[];for(let i=0;i<ts.length;i++){if(q.close&&q.close[i]!=null)out.push({t:ts[i]*1000,c:q.close[i],h:q.high[i],l:q.low[i],o:q.open[i]});}return out;}catch(e){return null;}
}
async function main(){
  console.log('Downloading Yahoo Finance tradfi series (2y daily)...');
  for(const s of SYMBOLS){
    process.stdout.write(s.key+' ');
    const data=await getYahoo(s.yahoo);
    if(!data||!data.length){console.log('✗ fail');continue;}
    fs.writeFileSync(`/tmp/tradfi-${s.key}.json`,JSON.stringify(data));
    console.log(`✓ ${data.length} bars`);
  }
  console.log('Done. Files: /tmp/tradfi-{spx,vix,dxy,gold,tnx}.json');
}
main().catch(e=>{console.error(e);process.exit(1);});
