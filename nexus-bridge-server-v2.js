/**
 * NEXUS Bridge Server v3.0
 * Upgraded from v2.2.0. All v2.2 fixes retained.
 * New: DeepSeek API, Ollama/LM Studio direct, Open WebUI, intent mapping,
 *      Firefox profile detection, human behavior generator, external persistence.
 */
'use strict';

const http  = require('http');
const https = require('https');
const { URL } = require('url');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const crypto= require('crypto');
const { EventEmitter } = require('events');
const BridgeModules = require('./nexus-bridge-modules');

// ─── Config ───────────────────────────────────────────────────────────────────
function getArg(f) { const a=process.argv.find(x=>x.startsWith(`--${f}=`)); return a?a.split('=').slice(1).join('='):null; }

const VERSION         = '3.0.0';
const PORT            = parseInt(process.env.NEXUS_PORT    || getArg('port')    || '3747');
const HOST            = process.env.NEXUS_HOST             || getArg('host')    || '127.0.0.1';
const API_KEY         = process.env.NEXUS_API_KEY          || getArg('api-key') || null;
const REQUEST_TIMEOUT = parseInt(process.env.NEXUS_TIMEOUT || '150000');
const MAX_BODY        = 10*1024*1024;

const DATA_DIR     = process.env.DATA_DIR      || getArg('data-dir')     || path.join(process.cwd(),'data');
const PROFILES_DIR = process.env.PROFILES_DIR  || getArg('profiles-dir') || path.join(process.cwd(),'profiles');

[DATA_DIR, PROFILES_DIR, path.join(DATA_DIR,'intent-maps'), path.join(DATA_DIR,'scans')]
  .forEach(d => { try { fs.mkdirSync(d,{recursive:true}); } catch {} });

// ─── Event Bus ────────────────────────────────────────────────────────────────
const BUS = new EventEmitter(); BUS.setMaxListeners(100);
let _seq=0; const EVENTS=[];
function busEmit(type,data={},level='INFO'){
  const e={id:crypto.randomBytes(4).toString('hex'),seq:_seq++,ts:Date.now(),type,level,data};
  EVENTS.push(e); if(EVENTS.length>5000) EVENTS.shift();
  BUS.emit(type,e); BUS.emit('*',e);
  setImmediate(()=>{ try{fs.appendFileSync(path.join(DATA_DIR,'bridge-events.jsonl'),JSON.stringify(e)+'\n');}catch{} });
  return e;
}

// ─── Config Store ─────────────────────────────────────────────────────────────
const CFG_FILE = path.join(DATA_DIR,'bridge-config.json');
let _cfg = {};
try{ if(fs.existsSync(CFG_FILE)) _cfg=JSON.parse(fs.readFileSync(CFG_FILE,'utf8')); }catch{}
function saveCfg(patch){ _cfg={..._cfg,...patch}; try{fs.writeFileSync(CFG_FILE,JSON.stringify(_cfg,null,2));}catch{} return _cfg; }

// ─── Wire PlaywrightController (needs BUS, busEmit, saveCfg, detectProfiles) ─
// detectProfiles is defined later in this file; we pass a thunk so it resolves at call-time
setImmediate(() => PlaywrightController.install(BUS, busEmit, DATA_DIR, saveCfg, detectProfiles, _extensionSessions));
// ── All standalone modules (SNR, Keys, Hosts, Ports, Canvas) ─────────────────
setImmediate(() => BridgeModules.install(DATA_DIR, busEmit, saveCfg));

// ─── Extension Session Store ──────────────────────────────────────────────────
const _extensionSessions = {}; // sessionId → registration data
let _pwPage = null;            // legacy ref — lifecycle owned by PlaywrightController
let _pwLaunchConfig = null;    // legacy ref — kept for compat

// ─── Playwright Controller (real implementation) ───────────────────────────────
const PlaywrightController = require('./nexus-playwright-controller');

// ─── Ollama Gate Model Map ────────────────────────────────────────────────────
const OLLAMA_GATE_DEFAULTS = {
  code:         ['deepseek-r1:8b', 'codellama', 'codellama:7b', 'deepseek-coder', 'llama3'],
  analysis:     ['deepseek-r1:8b', 'deepseek-r1:14b', 'llama3', 'mistral'],
  reasoning:    ['deepseek-r1:8b', 'deepseek-r1:14b', 'phi3', 'llama3'],
  creative:     ['llama3', 'mistral', 'deepseek-r1:8b'],
  research:     ['deepseek-r1:8b', 'llama3', 'mistral'],
  fast:         ['phi3', 'llama3:8b', 'deepseek-r1:8b', 'mistral:7b'],
  local:        ['deepseek-r1:8b', 'codellama', 'llama3'],
  summarize:    ['llama3', 'mistral', 'deepseek-r1:8b'],
  translate:    ['llama3', 'mistral', 'deepseek-r1:8b'],
  math:         ['deepseek-r1:8b', 'deepseek-r1:14b', 'phi3', 'llama3'],
  adversarial:  ['deepseek-r1:8b', 'llama3', 'mistral'],
  default:      ['deepseek-r1:8b', 'codellama', 'llama3', 'mistral'],
};

function buildOllamaGateMap(available=[]) {
  const map = {};
  for (const gate of Object.keys(OLLAMA_GATE_DEFAULTS)) {
    map[gate] = selectOllamaModel(gate, available, null);
  }
  return map;
}

function selectOllamaModel(gate='default', available=[], explicitModel=null) {
  if (explicitModel && available.includes(explicitModel)) return explicitModel;
  if (explicitModel) return explicitModel;
  const preferred = OLLAMA_GATE_DEFAULTS[gate] || OLLAMA_GATE_DEFAULTS.default;
  for (const p of preferred) {
    if (available.includes(p)) return p;
  }
  for (const p of preferred) {
    const found = available.find(a => a.startsWith(p.split(':')[0]));
    if (found) return found;
  }
  return available[0] || 'deepseek-r1:8b';
}

// ─── Intent Map ───────────────────────────────────────────────────────────────
const INTENT_FILE = path.join(DATA_DIR,'intent-maps','intent-map.json');
const DEFAULT_INTENT = {
  code:        {providers:['deepseek','claude','chatgpt'],       desc:'Code generation & review'},
  analysis:    {providers:['deepseek','claude','gemini'],        desc:'Architecture & analysis'},
  reasoning:   {providers:['deepseek','claude','chatgpt'],       desc:'Deep reasoning'},
  creative:    {providers:['claude','chatgpt','gemini'],         desc:'Creative writing'},
  research:    {providers:['perplexity','deepseek','claude'],    desc:'Research + citations'},
  fast:        {providers:['gemini','grok','chatgpt'],           desc:'Quick responses'},
  local:       {providers:['ollama','lmstudio'],                 desc:'Local models only'},
  summarize:   {providers:['gemini','claude','chatgpt'],         desc:'Summarization'},
  translate:   {providers:['chatgpt','gemini','claude'],         desc:'Translation'},
  math:        {providers:['deepseek','claude','chatgpt'],       desc:'Math & logic'},
  adversarial: {providers:['deepseek','claude'],                 desc:'Security & red-team'},
  default:     {providers:['claude','chatgpt','deepseek'],       desc:'General purpose'},
  _providers:{
    deepseek:{ preferred:['code','analysis','reasoning','adversarial','math'],
      api_models:{
        'deepseek-chat':    {ctx:64000,  strengths:['code','analysis','general']},
        'deepseek-reasoner':{ctx:64000,  strengths:['reasoning','math','adversarial']},
        'deepseek-coder':   {ctx:16000,  strengths:['code']},
      }, default_model:'deepseek-chat', api_url:'https://api.deepseek.com/v1' },
    claude:{ preferred:['creative','analysis','code','reasoning'],
      api_models:{
        'claude-sonnet-4-20250514':{ctx:200000, strengths:['code','analysis','creative']},
        'claude-opus-4-20250514':  {ctx:200000, strengths:['reasoning','analysis']},
        'claude-haiku-4-5-20251001':{ctx:200000,strengths:['fast','summarize']},
      }, default_model:'claude-sonnet-4-20250514' },
    chatgpt:{ preferred:['creative','fast','translate'],
      api_models:{
        'gpt-4o':      {ctx:128000, strengths:['general','code','creative']},
        'gpt-4o-mini': {ctx:128000, strengths:['fast','general']},
        'o1-mini':     {ctx:128000, strengths:['reasoning','math']},
      }, default_model:'gpt-4o-mini' },
    gemini:{ preferred:['fast','summarize','translate'],
      api_models:{
        'gemini-1.5-pro':  {ctx:1000000, strengths:['analysis','long-context']},
        'gemini-1.5-flash':{ctx:1000000, strengths:['fast','summarize']},
      }, default_model:'gemini-1.5-flash' },
    ollama:{  preferred:['local','code'],     note:'Direct API — no bridge needed', direct:true, default_url:'http://localhost:11434' },
    lmstudio:{preferred:['local','code'],     note:'Direct API — no bridge needed', direct:true, default_url:'http://localhost:1234'  },
    perplexity:{preferred:['research','fast'],note:'Web search + AI'},
    grok:{    preferred:['fast','general'],   note:'X.ai Grok'},
  }
};
let _intentMap = {...DEFAULT_INTENT};
try{ if(fs.existsSync(INTENT_FILE)) _intentMap={...DEFAULT_INTENT,...JSON.parse(fs.readFileSync(INTENT_FILE,'utf8'))}; }catch{}
function saveIntentMap(){ try{fs.writeFileSync(INTENT_FILE,JSON.stringify(_intentMap,null,2));}catch{} }

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function httpReq(url,opts={},body=null){
  return new Promise((resolve,reject)=>{
    const u=new URL(url), lib=u.protocol==='https:'?https:http;
    const r=lib.request({hostname:u.hostname,port:u.port||(u.protocol==='https:'?443:80),
      path:u.pathname+u.search,method:opts.method||'GET',headers:opts.headers||{}},res=>{
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{resolve({status:res.statusCode,data:JSON.parse(d),raw:d});}
                          catch{resolve({status:res.statusCode,data:null,raw:d}); } });
    });
    r.on('error',reject);
    setTimeout(()=>{r.destroy();reject(new Error('timeout'));},opts.timeout||120000);
    if(body) r.write(typeof body==='string'?body:JSON.stringify(body));
    r.end();
  });
}

// ─── Direct AI Clients ────────────────────────────────────────────────────────
async function ollamaChat({url='http://localhost:11434',model='llama3',messages}){
  const r=await httpReq(url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},timeout:120000},{model,messages,stream:false});
  if(r.status!==200) throw new Error(`Ollama ${r.status}: ${r.raw?.slice(0,200)}`);
  return {content:[{type:'text',text:r.data?.message?.content||r.data?.response||''}],_meta:{provider:'ollama',model}};
}

async function lmStudioChat({url='http://localhost:1234',model='',messages,apiKey='lm-studio'}){
  const r=await httpReq(url+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},timeout:120000},{model:model||undefined,messages,max_tokens:4096});
  if(r.status!==200) throw new Error(`LM Studio ${r.status}: ${r.raw?.slice(0,200)}`);
  return {content:[{type:'text',text:r.data?.choices?.[0]?.message?.content||''}],_meta:{provider:'lmstudio',model}};
}

async function deepSeekChat({apiKey,model='deepseek-chat',messages,baseUrl='https://api.deepseek.com/v1'}){
  if(!apiKey) throw new Error('DeepSeek API key required. POST /config {deepseekKey:"sk-..."}');
  const r=await httpReq(baseUrl+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},timeout:120000},{model,messages,max_tokens:4096});
  if(r.status!==200) throw new Error(`DeepSeek ${r.status}: ${JSON.stringify(r.data?.error)||r.raw?.slice(0,200)}`);
  return {content:[{type:'text',text:r.data?.choices?.[0]?.message?.content||''}],_meta:{provider:'deepseek',model}};
}

async function openAIChat({apiKey,model='gpt-4o-mini',messages,baseUrl='https://api.openai.com/v1'}){
  if(!apiKey) throw new Error('OpenAI API key required');
  const r=await httpReq(baseUrl+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},timeout:120000},{model,messages,max_tokens:4096});
  if(r.status!==200) throw new Error(`OpenAI ${r.status}: ${JSON.stringify(r.data?.error)||r.raw?.slice(0,200)}`);
  return {content:[{type:'text',text:r.data?.choices?.[0]?.message?.content||''}],_meta:{provider:'openai',model}};
}

async function claudeAPIChat({apiKey,model='claude-sonnet-4-20250514',messages}){
  if(!apiKey) throw new Error('Claude API key required');
  const sys=messages.find(m=>m.role==='system'), msgs=messages.filter(m=>m.role!=='system');
  const r=await httpReq('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},timeout:120000},{model,max_tokens:4096,system:sys?.content,messages:msgs});
  if(r.status!==200) throw new Error(`Claude API ${r.status}: ${JSON.stringify(r.data?.error)||r.raw?.slice(0,200)}`);
  return {content:[{type:'text',text:r.data?.content?.[0]?.text||''}],_meta:{provider:'claude',model}};
}

async function webUIChat({url='http://localhost:3000',apiKey='',model,messages}){
  const r=await httpReq(url+'/api/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',...(apiKey?{'Authorization':`Bearer ${apiKey}`}:{})},timeout:120000},{model:model||'auto',messages});
  if(r.status!==200) throw new Error(`WebUI ${r.status}: ${r.raw?.slice(0,200)}`);
  return {content:[{type:'text',text:r.data?.choices?.[0]?.message?.content||r.data?.message?.content||''}],_meta:{provider:'webui',model}};
}

// ─── Profile Detection ────────────────────────────────────────────────────────
function detectProfiles(){
  const home=os.homedir(), plat=process.platform; const found=[];
  // Firefox
  const ffBases = plat==='win32'?[
    path.join(home,'AppData','Roaming','Mozilla','Firefox','Profiles'),
    path.join(home,'AppData','Local','Mozilla','Firefox','Profiles'),
  ]:plat==='darwin'?[
    path.join(home,'Library','Application Support','Firefox','Profiles'),
  ]:[path.join(home,'.mozilla','firefox')];
  const envDir=process.env.NEXUS_PROFILE_DIR||getArg('profile-dir');
  if(envDir) ffBases.unshift(envDir);
  for(const base of ffBases){
    try{
      if(!fs.existsSync(base)) continue;
      fs.readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory()).forEach(e=>{
        const pp=path.join(base,e.name);
        found.push({id:e.name,name:e.name,path:pp,browser:'Firefox',type:'firefox',
          isDefault:e.name.includes('default')||e.name.includes('Default'),
          hasPrefs:fs.existsSync(path.join(pp,'prefs.js')),base});
      });
    }catch{}
  }
  // Chrome family
  const chromeBases=plat==='win32'?[
    {browser:'Chrome', base:path.join(home,'AppData','Local','Google','Chrome','User Data')},
    {browser:'Edge',   base:path.join(home,'AppData','Local','Microsoft','Edge','User Data')},
    {browser:'Brave',  base:path.join(home,'AppData','Local','BraveSoftware','Brave-Browser','User Data')},
  ]:plat==='darwin'?[
    {browser:'Chrome', base:path.join(home,'Library','Application Support','Google','Chrome')},
    {browser:'Edge',   base:path.join(home,'Library','Application Support','Microsoft Edge')},
  ]:[
    {browser:'Chrome',   base:path.join(home,'.config','google-chrome')},
    {browser:'Chromium', base:path.join(home,'.config','chromium')},
  ];
  for(const{browser,base}of chromeBases){
    try{
      if(!fs.existsSync(base)) continue;
      fs.readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory()).forEach(e=>{
        const pf=path.join(base,e.name,'Preferences');
        if(!fs.existsSync(pf)) return;
        let name=e.name; try{name=JSON.parse(fs.readFileSync(pf,'utf8'))?.profile?.name||e.name;}catch{}
        found.push({id:e.name,name,path:path.join(base,e.name),browser,type:'chromium',isDefault:e.name==='Default',hasPrefs:true,base});
      });
    }catch{}
  }
  return found;
}

const PROF_STATE_FILE=path.join(DATA_DIR,'active-profile.json');
let _activeProfile=null;
try{if(fs.existsSync(PROF_STATE_FILE))_activeProfile=JSON.parse(fs.readFileSync(PROF_STATE_FILE,'utf8'));}catch{}
function setActiveProfile(p){_activeProfile=p;try{fs.writeFileSync(PROF_STATE_FILE,JSON.stringify(p,null,2));}catch{}}

// ─── Human Profile Generator ──────────────────────────────────────────────────
const FN=['James','Emma','Oliver','Sophia','Liam','Ava','Noah','Isabella','William','Mia','Benjamin','Charlotte','Lucas','Amelia','Henry','Harper','Alexander','Evelyn','Mason','Abigail','Ethan','Emily','Daniel','Elizabeth'];
const LN=['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Wilson','Martinez','Anderson','Taylor','Thomas','Moore','Jackson','Martin','Lee','Thompson','White','Harris'];
const DOM=['gmail.com','outlook.com','yahoo.com','protonmail.com','icloud.com','hotmail.com','me.com'];
const STR=['Main St','Oak Ave','Maple Dr','Cedar Ln','Pine Rd','Elm St','Park Blvd','Lake Dr','River Rd','Hill St'];
const CTY=['Austin','Denver','Portland','Nashville','Raleigh','Minneapolis','Tampa','Phoenix','Columbus','Charlotte','Seattle'];
const STS=['TX','CO','OR','TN','NC','MN','FL','AZ','OH','NC','WA'];
const UAS=['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36','Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36','Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0','Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15'];
const TZ=['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Phoenix'];
function rc(a){return a[Math.floor(Math.random()*a.length)];}
function ri(a,b){return Math.floor(Math.random()*(b-a+1))+a;}
function p2(n){return String(n).padStart(2,'0');}

function genHumanProfile(count=1){
  const profiles=Array.from({length:count},()=>{
    const fn=rc(FN),ln=rc(LN),sep=rc(['','_','.','']);
    const scr=rc([{w:1920,h:1080},{w:2560,h:1440},{w:1440,h:900},{w:1366,h:768},{w:1280,h:800}]);
    const si=ri(0,STS.length-1);
    return {
      _id:crypto.randomBytes(4).toString('hex'), _ts:new Date().toISOString(),
      name:{first:fn,last:ln,full:`${fn} ${ln}`},
      email:`${fn.toLowerCase()}${sep}${ln.toLowerCase()}${ri(1,9999)}@${rc(DOM)}`,
      dob:`${ri(1975,2000)}-${p2(ri(1,12))}-${p2(ri(1,28))}`,
      phone:`+1${ri(200,999)}${ri(200,999)}${ri(1000,9999)}`,
      address:{street:`${ri(100,9999)} ${rc(STR)}`,city:rc(CTY),state:STS[si],zip:String(ri(10000,99999)),country:'US'},
      username:`${fn.toLowerCase()}${sep}${ln.toLowerCase()}${ri(10,99)}`,
      password:crypto.randomBytes(10).toString('base64').replace(/[^a-zA-Z0-9]/g,'').slice(0,14)+'!1',
      userAgent:rc(UAS),
      screen:{width:scr.w,height:scr.h,colorDepth:24,pixelRatio:rc([1,1.25,1.5,2])},
      timezone:rc(TZ), locale:'en-US', languages:['en-US','en'],
      fingerprint:crypto.randomBytes(8).toString('hex'),
      // Behavior for Playwright human simulation
      typing:{
        baseWpm:ri(45,95),          // words per minute
        errorRate:Math.random()*0.03,  // 0-3% typo rate
        burstSpeed:ri(80,140),       // fast typing wpm
        thinkPauseMsMin:ri(500,1500), // pre-response pause
        thinkPauseMsMax:ri(2000,5000),
        copyPasteRate:Math.random()*0.15,
        misclickRate:Math.random()*0.05,
      },
      session:{
        avgSessionMin:ri(8,45),
        breakFreqMin:ri(15,90),      // how often they step away
        breakDurationMin:ri(2,30),
        tabSwitchPerHour:ri(3,20),
        scrollBehavior:rc(['smooth','fast','erratic']),
        closeBrowserFreqPerDay:ri(1,5),
        idleTimeoutMin:ri(5,20),
      },
      mouse:{
        speed:rc(['slow','medium','fast']),
        overshotRate:Math.random()*0.2,
        doubleClickRate:Math.random()*0.08,
        rightClickRate:Math.random()*0.03,
      },
    };
  });
  return count===1?profiles[0]:profiles;
}

// ─── DeepScan ─────────────────────────────────────────────────────────────────
const SCAN_HIST=path.join(DATA_DIR,'scans','history.jsonl');
const SCANS=new Map();

async function runDeepScan({type='code',code,lang,depth,apiKey,model}){
  const scanId=crypto.randomBytes(6).toString('hex');
  const scan={scanId,ts:new Date().toISOString(),type,status:'running',findings:[],verdict:null};
  SCANS.set(scanId,scan);
  busEmit('deepscan:start',{scanId,type});
  try{
    if(type==='code'){
      const prompt=`You are ADVERSARY — a hostile code review engine. Analyze this code for ALL vulnerabilities, logic errors, security risks, and performance issues.
Language: ${lang||'auto-detect'}, Depth: ${depth||'standard'}
Code:\n\`\`\`\n${(code||'').slice(0,6000)}\n\`\`\`
Return ONLY valid JSON: {"verdict":"BLOCK|WARN|PASS","summary":"...","findings":[{"category":"SECURITY|LOGIC|PERFORMANCE|DEPENDENCY","severity":"CRITICAL|HIGH|MEDIUM|LOW","location":"...","description":"...","fix":"..."}]${depth==='deep'?',"adversarial_inputs":["..."]':''}}`;
      let text='';
      const key=apiKey||_cfg.deepseekKey;
      if(key){
        const r=await deepSeekChat({apiKey:key,model:model||'deepseek-chat',messages:[{role:'user',content:prompt}]});
        text=r.content[0].text;
      }else{
        try{ const r=await ollamaChat({messages:[{role:'user',content:prompt}]}); text=r.content[0].text; }
        catch{ throw new Error('DeepScan requires DeepSeek API key or Ollama. POST /config {deepseekKey:"sk-..."}'); }
      }
      try{
        const p=JSON.parse(text.replace(/```json|```/g,'').trim());
        scan.findings=p.findings||[]; scan.verdict=p.verdict||'WARN'; scan.summary=p.summary||'';
        scan.adversarialInputs=p.adversarial_inputs||[];
      }catch{ scan.verdict='WARN'; scan.summary=text.slice(0,500); }
    }
    scan.status='complete'; scan.completedAt=new Date().toISOString();
    try{fs.appendFileSync(SCAN_HIST,JSON.stringify(scan)+'\n');}catch{}
    busEmit('deepscan:complete',{scanId,verdict:scan.verdict,findings:scan.findings.length},'OK');
  }catch(err){
    scan.status='error'; scan.error=err.message;
    busEmit('deepscan:error',{scanId,error:err.message},'ERROR');
  }
  return scan;
}

// ─── Lazy v2.2 compat ─────────────────────────────────────────────────────────
let AccountMgr,routeRequest,getChainStatus,Delta;
function initV22(){
  try{AccountMgr=require('./account-manager');}catch(e){console.warn('[v3] account-manager:',e.message);}
  try{const r=require('./router');routeRequest=r.routeRequest;getChainStatus=r.getChainStatus;}catch(e){console.warn('[v3] router:',e.message);}
  try{const d=require('./delta');Delta=d.Delta;}catch(e){console.warn('[v3] delta:',e.message);}
}
try{initV22();}catch{}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function readBody(req){
  return new Promise((resolve,reject)=>{
    let d='',sz=0;
    req.on('data',c=>{sz+=c.length;if(sz>MAX_BODY){req.destroy();return reject(Object.assign(new Error('Body too large'),{status:413}));}d+=c;});
    req.on('end',()=>{try{resolve(d?JSON.parse(d):{});}catch{reject(Object.assign(new Error('Invalid JSON'),{status:400}));}});
    req.on('error',reject);
  });
}

function jsonRes(res,status,data){
  if(res.headersSent) return;
  res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,PATCH,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,X-API-Key,X-Request-ID'});
  res.end(JSON.stringify(data,null,2));
}

function withTO(p,ms){return Promise.race([p,new Promise((_,r)=>setTimeout(()=>r(new Error(`Timeout ${ms}ms`)),ms))]);}

// ─── Route Handler ────────────────────────────────────────────────────────────
async function handleRequest(req,res){
  const u=new URL(req.url,`http://${HOST}:${PORT}`);
  const method=req.method.toUpperCase();
  const parts=u.pathname.replace(/^\/+|\/+$/g,'').split('/');

  if(method==='OPTIONS'){
    res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,PATCH,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,X-API-Key,X-Request-ID'});
    return res.end();
  }
  if(API_KEY&&u.pathname!=='/health'){
    const auth=req.headers['authorization']||req.headers['x-api-key']||'';
    if((auth.startsWith('Bearer ')?auth.slice(7):auth)!==API_KEY) return jsonRes(res,401,{error:'Unauthorized'});
  }

  busEmit('http:req',{method,path:u.pathname});

  try{

    // GET /health
    if(method==='GET'&&parts[0]==='health'){
      return jsonRes(res,200,{ok:true,version:VERSION,host:HOST,port:PORT,uptime:Math.floor(process.uptime()),
        memory:process.memoryUsage(),dataDir:DATA_DIR,profilesDir:PROFILES_DIR,
        activeProfile:_activeProfile?.name||null,
        providers:{direct:['deepseek','claude','chatgpt','ollama','lmstudio','gemini','webui'],
          browser:AccountMgr?Object.keys(AccountMgr.BUILTIN_PROVIDERS||{}):[],},ts:Date.now()});
    }

    // POST /v1/messages
    if(method==='POST'&&parts[0]==='v1'&&parts[1]==='messages'){
      const b=await readBody(req);
      const{messages,provider='auto',intent,model,api_key,base_url,timeout_ms,...rest}=b;
      if(!messages?.length) return jsonRes(res,400,{error:'messages[] required'});

      const intentChain=intent?(_intentMap[intent]?.providers||_intentMap.default.providers):null;
      const eff=provider!=='auto'?provider:(intentChain?.[0]||'auto');
      const key=api_key;

      let response;
      if(eff==='deepseek'||(eff==='auto'&&(key||_cfg.deepseekKey)&&!(key||'').startsWith('sk-ant'))){
        response=await withTO(deepSeekChat({apiKey:key||_cfg.deepseekKey,model:model||_cfg.deepseekModel||'deepseek-chat',messages,baseUrl:base_url||_cfg.deepseekUrl}),timeout_ms||REQUEST_TIMEOUT);
      }else if(eff==='ollama'){
        // Smart gate-aware model selection: probe available models, pick best for this gate/intent
        const ollamaUrl=base_url||_cfg.ollamaUrl||'http://localhost:11434';
        let availableModels=[];
        try{const r=await httpReq(ollamaUrl+'/api/tags',{},null);availableModels=(r.data?.models||[]).map(m=>m.name);}catch{}
        const smartModel=selectOllamaModel(intent||'default',availableModels,model||_cfg.ollamaModel||null);
        response=await withTO(ollamaChat({url:ollamaUrl,model:smartModel,messages}),timeout_ms||REQUEST_TIMEOUT);
        response._meta.gateModel=smartModel; response._meta.gate=intent||'default'; response._meta.autoSelected=!model&&!_cfg.ollamaModel;
      }else if(eff==='lmstudio'){
        response=await withTO(lmStudioChat({url:base_url||_cfg.lmstudioUrl||'http://localhost:1234',model:model||_cfg.lmstudioModel||'',messages,apiKey:key||_cfg.lmstudioKey||'lm-studio'}),timeout_ms||REQUEST_TIMEOUT);
      }else if(eff==='webui'){
        response=await withTO(webUIChat({url:base_url||_cfg.webuiUrl||'http://localhost:3000',apiKey:key||_cfg.webuiKey||'',model,messages}),timeout_ms||REQUEST_TIMEOUT);
      }else if((eff==='claude'||(key||'').startsWith('sk-ant'))&&(key||_cfg.claudeKey)){
        response=await withTO(claudeAPIChat({apiKey:key||_cfg.claudeKey,model:model||_cfg.claudeModel||'claude-sonnet-4-20250514',messages}),timeout_ms||REQUEST_TIMEOUT);
      }else if((eff==='chatgpt'||eff==='openai')&&(key||_cfg.chatgptKey)){
        response=await withTO(openAIChat({apiKey:key||_cfg.chatgptKey,model:model||_cfg.chatgptModel||'gpt-4o-mini',messages,baseUrl:base_url}),timeout_ms||REQUEST_TIMEOUT);
      }else if(routeRequest){
        response=await withTO(routeRequest({messages,provider:eff,intent,...rest}),timeout_ms||REQUEST_TIMEOUT+5000);
      }else{
        return jsonRes(res,503,{error:'No AI provider configured.',hint:'POST /config with {deepseekKey, ollamaUrl, claudeKey, chatgptKey}'});
      }

      busEmit('ai:response',{provider:response._meta?.provider||eff,model:response._meta?.model||model,intent},'LLM');
      try{Delta?.log?.({provider:eff,success:true,input:messages,output:response,intent});}catch{}
      return jsonRes(res,200,response);
    }

    // GET/POST /config
    if(parts[0]==='config'){
      if(method==='GET') return jsonRes(res,200,{config:{..._cfg,deepseekKey:_cfg.deepseekKey?'***':undefined,claudeKey:_cfg.claudeKey?'***':undefined,chatgptKey:_cfg.chatgptKey?'***':undefined}});
      if(method==='POST'){const b=await readBody(req);saveCfg(b);busEmit('config:updated',{keys:Object.keys(b)});return jsonRes(res,200,{ok:true,keys:Object.keys(b)});}
    }

    // /intent
    if(parts[0]==='intent'){
      if(method==='GET'&&!parts[1]) return jsonRes(res,200,{intentMap:_intentMap});
      if(method==='GET'&&parts[1]) return jsonRes(res,200,{intent:parts[1],...(_intentMap[parts[1]]||{error:'not found'})});
      if(method==='PUT'&&parts[1]){const b=await readBody(req);_intentMap[parts[1]]={..._intentMap[parts[1]],...b};saveIntentMap();return jsonRes(res,200,{ok:true,intent:parts[1]});}
      if(method==='POST'&&parts[1]==='reset'){_intentMap={...DEFAULT_INTENT};saveIntentMap();return jsonRes(res,200,{ok:true});}
    }

    // /profiles
    if(parts[0]==='profiles'){
      if(method==='GET'&&parts[1]==='detect') return jsonRes(res,200,{ok:true,profiles:detectProfiles()});
      if(method==='GET'&&parts[1]==='active') return jsonRes(res,200,{ok:true,profile:_activeProfile});
      if(method==='POST'&&parts[1]==='activate'){
        const b=await readBody(req);
        if(!b.path) return jsonRes(res,400,{error:'path required'});
        setActiveProfile({name:b.name||path.basename(b.path),path:b.path,browser:b.browser||'Firefox',type:b.type||'firefox',activatedAt:new Date().toISOString()});
        busEmit('profile:activated',{name:_activeProfile.name});
        return jsonRes(res,200,{ok:true,profile:_activeProfile});
      }
      if(method==='POST'&&parts[1]==='mirror'){
        const b=await readBody(req);
        if(!b.src) return jsonRes(res,400,{error:'src required'});
        const dest=path.join(PROFILES_DIR,b.dest||path.basename(b.src)+'-mirror');
        try{
          if(fs.existsSync(dest)) fs.rmSync(dest,{recursive:true,force:true});
          try{fs.symlinkSync(b.src,dest,process.platform==='win32'?'junction':'dir');return jsonRes(res,200,{ok:true,method:'symlink',dest});}
          catch{
            fs.mkdirSync(dest,{recursive:true});
            ['prefs.js','cookies.sqlite','key4.db','logins.json','places.sqlite','Preferences','Bookmarks','History','Cookies'].forEach(f=>{
              try{if(fs.existsSync(path.join(b.src,f)))fs.copyFileSync(path.join(b.src,f),path.join(dest,f));}catch{}
            });
            return jsonRes(res,200,{ok:true,method:'copy',dest});
          }
        }catch(e){return jsonRes(res,500,{error:e.message});}
      }
      if(method==='GET'){
        const dirs=[];
        try{fs.readdirSync(PROFILES_DIR,{withFileTypes:true}).filter(e=>e.isDirectory()||e.isSymbolicLink()).forEach(e=>{
          dirs.push({name:e.name,path:path.join(PROFILES_DIR,e.name),isActive:_activeProfile?.path===path.join(PROFILES_DIR,e.name)});
        });}catch{}
        return jsonRes(res,200,{profiles:dirs});
      }
    }

    // /gen/human-profile
    if(parts[0]==='gen'&&(parts[1]==='human-profile'||parts[1]==='fake-user')){
      let count=1;
      if(method==='POST'){const b=await readBody(req);count=Math.min(b.count||1,100);}
      else count=Math.min(parseInt(u.searchParams.get('count')||'1'),100);
      return jsonRes(res,200,{ok:true,count,profiles:Array.isArray(genHumanProfile(count))?genHumanProfile(count):[genHumanProfile(1)]});
    }

    // /deepscan
    if(parts[0]==='deepscan'){
      if(method==='POST'&&parts[1]==='run'){const b=await readBody(req);return jsonRes(res,200,await runDeepScan({...b,apiKey:b.api_key||_cfg.deepseekKey}));}
      if(method==='GET'&&parts[1]==='history') return jsonRes(res,200,{scans:[...SCANS.values()].slice(-50)});
      if(method==='GET'&&parts[1]){const s=SCANS.get(parts[1]);return s?jsonRes(res,200,s):jsonRes(res,404,{error:'Not found'});}
    }

    // /direct/* — test direct connections
    if(parts[0]==='direct'){
      if(parts[1]==='ollama'){try{const r=await httpReq((_cfg.ollamaUrl||'http://localhost:11434')+'/api/tags',{},null);return jsonRes(res,200,{ok:r.status===200,models:r.data?.models||[],url:_cfg.ollamaUrl||'http://localhost:11434'});}catch(e){return jsonRes(res,503,{ok:false,error:e.message,hint:'Install Ollama from https://ollama.ai'});}}
      if(parts[1]==='lmstudio'){try{const r=await httpReq((_cfg.lmstudioUrl||'http://localhost:1234')+'/v1/models',{headers:{Authorization:`Bearer ${_cfg.lmstudioKey||'lm-studio'}`}},null);return jsonRes(res,200,{ok:r.status===200,models:r.data?.data||[],url:_cfg.lmstudioUrl||'http://localhost:1234'});}catch(e){return jsonRes(res,503,{ok:false,error:e.message,hint:'Install LM Studio from https://lmstudio.ai'});}}
      if(parts[1]==='webui'){try{const r=await httpReq((_cfg.webuiUrl||'http://localhost:3000')+'/api/models',{headers:{Authorization:`Bearer ${_cfg.webuiKey||''}`}},null);return jsonRes(res,200,{ok:r.status===200,models:r.data?.data||r.data||[],url:_cfg.webuiUrl||'http://localhost:3000'});}catch(e){return jsonRes(res,503,{ok:false,error:e.message,hint:'Install Open WebUI from https://openwebui.com'});}}
      if(parts[1]==='deepseek'){try{const r=await httpReq('https://api.deepseek.com/v1/models',{headers:{Authorization:`Bearer ${_cfg.deepseekKey||''}`}},null);return jsonRes(res,200,{ok:r.status===200,models:r.data?.data||[],hint:r.status===401?'Add DeepSeek API key: POST /config {deepseekKey:"sk-..."}':`Status: ${r.status}`});}catch(e){return jsonRes(res,503,{ok:false,error:e.message});}}
    }

    // /events SSE
    if(method==='GET'&&parts[0]==='events'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
      const h=e=>res.write(`data: ${JSON.stringify(e)}\n\n`);
      BUS.on('*',h); req.on('close',()=>BUS.removeListener('*',h)); return;
    }

    // v2.2 compat: /accounts, /chain, /delta
    if(parts[0]==='accounts'){
      // POST /accounts/manual-import — manual cookie paste fallback
      if(method==='POST'&&parts[1]==='manual-import'){
        const b=await readBody(req);
        const prov=b.provider||'unknown', aid=b.accountId||'main';
        // Parse cookies — accept JSON array, JSON object, or "key=val; key2=val2" string
        let parsedCookies=[];
        if(Array.isArray(b.cookies)) {
          parsedCookies=b.cookies;
        } else if(typeof b.cookies==='string') {
          const raw=b.cookies.trim();
          if(raw.startsWith('[')) {
            try{parsedCookies=JSON.parse(raw);}catch{}
          } else if(raw.startsWith('{')) {
            try{const o=JSON.parse(raw);parsedCookies=Object.entries(o).map(([name,value])=>({name,value,domain:'.'+prov+'.com'}));}catch{}
          } else {
            // "name=value; name2=value2" format
            parsedCookies=raw.split(';').map(p=>{const[n,...v]=p.trim().split('=');return{name:n?.trim(),value:v.join('=')?.trim()};}).filter(c=>c.name);
          }
        }
        if(AccountMgr){
          try{
            await AccountMgr.upsertAccount(prov,aid,{status:'active',cookieCount:parsedCookies.length,cookies:parsedCookies.slice(0,200),manualImport:true,importedAt:Date.now()});
          }catch{}
        }
        busEmit('account:manual-import',{provider:prov,accountId:aid,cookieCount:parsedCookies.length});
        return jsonRes(res,200,{ok:true,provider:prov,accountId:aid,method:'manual-import',cookieCount:parsedCookies.length});
      }
      // POST /accounts/:provider/extract-cookies — read directly from Firefox SQLite profile
      if(method==='POST'&&parts[2]==='extract-cookies'&&AccountMgr){
        const b=await readBody(req);
        const provider=parts[1], accountId=b.accountId||'main';
        try{
          const result=await AccountMgr.connectAccountViaCookies(provider,accountId,{profilePath:b.profilePath});
          busEmit('account:cookies-extracted',{provider,accountId,cookieCount:result.cookieCount},'OK');
          return jsonRes(res,200,result);
        }catch(e){
          return jsonRes(res,200,{ok:false,error:e.message,provider,accountId,hint:'Open Firefox, log into '+provider+', then retry.'});
        }
      }
      if(!AccountMgr) return jsonRes(res,503,{error:'AccountManager not loaded'});
      if(method==='GET'&&!parts[1]) return jsonRes(res,200,{accounts:AccountMgr.listAllAccounts()});
      if(method==='GET'&&parts[1]&&!parts[2]) return jsonRes(res,200,{accounts:AccountMgr.listAccounts(parts[1])});
      // POST /accounts/:provider/connect       (3-part: parts[2]==='connect', no accountId → default 'main')
      // POST /accounts/:provider/:id/connect   (4-part: parts[3]==='connect')
      if(method==='POST'&&(parts[2]==='connect'||parts[3]==='connect')){
        const b=await readBody(req);
        const provider=parts[1];
        const accountId=parts[3]==='connect'?parts[2]:(b.accountId||'main');
        return jsonRes(res,200,await withTO(AccountMgr.connectAccount(provider,accountId,b),REQUEST_TIMEOUT));
      }
      if(method==='DELETE'&&parts[2]){AccountMgr.removeAccount(parts[1],parts[2]);return jsonRes(res,200,{ok:true});}
    }
    if(method==='GET'&&parts[0]==='chain'&&getChainStatus) return jsonRes(res,200,{chain:getChainStatus()});
    if(parts[0]==='delta'&&Delta){
      if(method==='GET'&&parts[1]==='recent') return jsonRes(res,200,{deltas:Delta.recent(parseInt(u.searchParams.get('limit')||'50'))});
      if(method==='GET'&&parts[1]==='stats')  return jsonRes(res,200,{stats:Delta.stats()});
      if(method==='GET'&&parts[1]==='failures') return jsonRes(res,200,{failures:Delta.failures(50)});
      if(method==='POST'&&parts[1]==='idea'){const b=await readBody(req);return jsonRes(res,200,{ok:true,id:await Delta.logIdea(b)});}
    }

    // ─── /extension — Firefox Web Extension endpoints ──────────────────────────
    if(parts[0]==='extension'){
      // POST /extension/register — extension announces itself
      if(method==='POST'&&parts[1]==='register'){
        const b=await readBody(req);
        const reg={...b,connectedAt:new Date().toISOString(),ip:req.socket.remoteAddress};
        _extensionSessions[b.sessionId||'default']=reg;
        saveCfg({activeExtension:reg});
        busEmit('extension:connected',reg,'INFO');
        // Forward CDP port to PlaywrightController so it can attach to the live browser
        PlaywrightController.onExtensionRegister(reg);
        // Tell NEXUS UI
        BUS.emit('nexus:extension_connected',reg);
        return jsonRes(res,200,{ok:true,hookId:b.hookId,bridgeVersion:VERSION,acknowledged:true});
      }
      // POST /extension/profile — receive Firefox profile data
      if(method==='POST'&&parts[1]==='profile'){
        const b=await readBody(req);
        const profileFile=path.join(DATA_DIR,'extension-profile.json');
        try{fs.writeFileSync(profileFile,JSON.stringify({...b,savedAt:new Date().toISOString()},null,2));}catch{}
        busEmit('extension:profile',{sessionId:b.sessionId,tabCount:b.profile?.tabs?.count},'INFO');
        // Mark Playwright to prefer Firefox profile if available
        if(b.profile?.tabs?.activeUrl) _cfg.pwLastActiveUrl=b.profile.tabs.activeUrl;
        saveCfg({extensionProfileAt:Date.now()});
        return jsonRes(res,200,{ok:true,received:true,playwright:'firefox-profile-queued'});
      }
      // GET /extension/status
      if(method==='GET'&&parts[1]==='status'){
        return jsonRes(res,200,{
          ok:true,
          sessions:Object.keys(_extensionSessions).length,
          activeExtension:_cfg.activeExtension||null,
          profileFile:path.join(DATA_DIR,'extension-profile.json'),
          profileExists:fs.existsSync(path.join(DATA_DIR,'extension-profile.json')),
        });
      }
      // GET /extension/sessions
      if(method==='GET'&&parts[1]==='sessions'){
        return jsonRes(res,200,{ok:true,sessions:Object.values(_extensionSessions)});
      }
      return jsonRes(res,404,{error:'Unknown extension endpoint'});
    }

    // ─── /playwright — routed to PlaywrightController (real implementation) ───
    if(parts[0]==='playwright'){
      const b = ['POST','PUT','PATCH'].includes(method) ? await readBody(req) : {};
      return PlaywrightController.route(parts, method, b, req, res);
    }

    // ─── /ollama/smart — Ollama gate-aware model selection ────────────────────
    if(parts[0]==='ollama'&&parts[1]==='smart'){
      // GET /ollama/smart/models — list available models with gate affinities
      if(method==='GET'&&parts[2]==='models'){
        try{
          const r=await httpReq((_cfg.ollamaUrl||'http://localhost:11434')+'/api/tags',{},null);
          const available=(r.data?.models||[]).map(m=>m.name);
          const gateMap=buildOllamaGateMap(available);
          return jsonRes(res,200,{ok:true,available,gateMap,defaults:OLLAMA_GATE_DEFAULTS});
        }catch(e){return jsonRes(res,503,{ok:false,error:e.message,hint:'Ollama not running on '+(_cfg.ollamaUrl||'http://localhost:11434')});}
      }
      // POST /ollama/smart/chat — auto-select best model for gate/intent
      if(method==='POST'&&parts[2]==='chat'){
        const b=await readBody(req);
        const gate=b.gate||b.intent||'default';
        const url=b.url||_cfg.ollamaUrl||'http://localhost:11434';
        // Get available models
        let available=[];
        try{const r=await httpReq(url+'/api/tags',{},null);available=(r.data?.models||[]).map(m=>m.name);}catch{}
        const model=selectOllamaModel(gate,available,b.model);
        const response=await withTO(ollamaChat({url,model,messages:b.messages}),b.timeout_ms||REQUEST_TIMEOUT);
        response._meta.selectedGate=gate;
        response._meta.modelSelectionAuto=!b.model;
        busEmit('ollama:smart',{gate,model,auto:!b.model},'LLM');
        return jsonRes(res,200,response);
      }
      return jsonRes(res,404,{error:'Unknown ollama/smart endpoint'});
    }

    // ── Extension layer (Hub proxy, SNR, CLI, Gate, etc.) ──────────────────
    const extResult = await handleBridgeExtension(req, res, parts, method, u);
    if (extResult !== null) return extResult;

    // ── Standalone modules routing (/snr/* /keys/* /hosts/* /ports/* /canvas/* /modules/*) ─
    const modResult = await BridgeModules.handle(req, res, parts, method, u);
    if (modResult !== null) return;

    return jsonRes(res,404,{error:'Not found',path:u.pathname,hint:`GET http://${HOST}:${PORT}/health`});

  }catch(err){
    const st=err.status||500;
    busEmit('http:error',{path:u.pathname,error:err.message},'ERROR');
    return jsonRes(res,st,{error:err.message});
  }
}

// ─── Start/Stop ───────────────────────────────────────────────────────────────
let _server=null;
function start(){
  if(_server) return _server;
  _server=http.createServer(handleRequest);
  _server.on('error',err=>{
    if(err.code==='EADDRINUSE'){console.error(`\n[Bridge v${VERSION}] Port ${PORT} in use.`);process.exit(1);}
    console.error('[Bridge]',err.message);
  });
  _server.listen(PORT,HOST,()=>{
    console.log(`\n🧠 NEXUS Bridge v${VERSION}  →  http://${HOST}:${PORT}`);
    console.log(`📁 Data: ${DATA_DIR}  |  Profiles: ${PROFILES_DIR}`);
    if(_activeProfile) console.log(`🦊 Active profile: ${_activeProfile.name}`);
    console.log(`\nDirect (no browser):  POST /v1/messages {provider:"deepseek|ollama|lmstudio|claude|chatgpt|webui"}`);
    console.log(`Browser sessions:     POST /accounts/:provider/:id/connect`);
    console.log(`Profile detection:    GET  /profiles/detect`);
    console.log(`Intent maps:          GET  /intent  |  PUT /intent/:name`);
    console.log(`Fake user data:       GET  /gen/human-profile?count=5`);
    console.log(`DeepScan:             POST /deepscan/run {type:"code",code:"...",api_key:"sk-..."}`);
    console.log(`Direct test:          GET  /direct/ollama  |  /direct/lmstudio  |  /direct/deepseek`);
    console.log(`Events SSE:           GET  /events`);
    console.log(`Config:               POST /config {deepseekKey,claudeKey,ollamaUrl,...}\n`);
  });
  return _server;
}
function stop(){return new Promise(r=>{if(_server){_server.close(r);_server=null;}else r();});}
module.exports={start,stop,get server(){return _server;},VERSION,PORT,HOST,DATA_DIR,busEmit,genHumanProfile,detectProfiles,runDeepScan,ADAPTERS_DIRECT:{ollamaChat,lmStudioChat,deepSeekChat,openAIChat,claudeAPIChat,webUIChat}};
if(require.main===module) start();

// ═══════════════════════════════════════════════════════════════════════════════
// NEXUS BRIDGE v3.1 — EXTENSION LAYER
// Hub API proxy, SNR gate, CLI layer, JAA/PHP, mutual gate permissions
// UUID/hook addresses for every feature. All Hub API calltos routed here.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── SNR Filter integration ───────────────────────────────────────────────────
let _snr = null;
try {
  const SNRFilter = require('./snr-filter.js');
  _snr = new SNRFilter({ name:'bridge-snr', logFile: path.join(DATA_DIR,'snr-log.jsonl') });
  // Load default presets
  SNRFilter.PRESETS.adblocker(_snr);
  SNRFilter.PRESETS.privacy(_snr);
  // Load persisted rules if exist
  const snrPersist = path.join(DATA_DIR,'snr-rules.json');
  if (fs.existsSync(snrPersist)) {
    try { const d=JSON.parse(fs.readFileSync(snrPersist,'utf8')); (d.rules||[]).forEach(r=>_snr.addRule(r)); } catch {}
  }
  busEmit('snr:init',{rules:_snr.rules.size});
} catch(e) { console.warn('[Bridge] SNR filter not loaded:',e.message); }

// ─── Hub API proxy config ─────────────────────────────────────────────────────
// All Hub calltos routed through bridge. Hub URL configurable.
const getHubUrl   = () => _cfg.hubUrl  || 'http://127.0.0.1:3748';
const getHubToken = () => _cfg.hubToken || '';

async function hubProxy(path2, method='GET', body=null) {
  const url  = getHubUrl() + path2;
  const opts = { method, headers:{ 'Content-Type':'application/json', 'X-Hub-Token':getHubToken() } };
  if (body) opts.body = JSON.stringify(body);
  const r = await httpReq(url, {}, body, { method: opts.method, headers: opts.headers });
  return r;
}

// ─── Mutual gate permission store ─────────────────────────────────────────────
// Each bridge can require the remote bridge to present a valid gate key
const _gatePermissions = new Map(); // gateId → { key, allowedUUIDs, fidelity }
const GATE_UUID = 'bridge.gate.mutual:' + crypto.randomBytes(4).toString('hex');

function issueGateKey(opts = {}) {
  const gateId  = 'gate:' + crypto.randomUUID().slice(0,12);
  const key     = crypto.randomBytes(32).toString('hex');
  const perm    = { gateId, key, allowedUUIDs: opts.allowedUUIDs||[], fidelity:opts.fidelity||7, created:Date.now(), expires:opts.ttl?(Date.now()+opts.ttl*1000):null };
  _gatePermissions.set(gateId, perm);
  busEmit('gate:issued',{gateId,fidelity:perm.fidelity});
  return { gateId, key };
}

function verifyGateKey(gateId, key, callerUUID) {
  const perm = _gatePermissions.get(gateId);
  if (!perm) return { ok:false, reason:'Gate not found' };
  if (perm.expires && Date.now() > perm.expires) { _gatePermissions.delete(gateId); return { ok:false, reason:'Gate expired' }; }
  if (perm.key !== key) return { ok:false, reason:'Invalid key' };
  if (callerUUID && perm.allowedUUIDs.length && !perm.allowedUUIDs.includes(callerUUID)) return { ok:false, reason:'UUID not permitted' };
  return { ok:true, fidelity:perm.fidelity, gateId };
}

// ─── CLI layer (spawn system commands, return structured output) ────────────────
const { execFile, spawn: spawnProc } = require('child_process');

function runCLI(cmd, args=[], opts={}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(opts.env||{}) };
    let out='', err='';
    const proc = spawnProc(cmd, args, { cwd:opts.cwd||process.cwd(), env, shell:true, timeout:opts.timeout||30000 });
    proc.stdout?.on('data', d => out+=d.toString());
    proc.stderr?.on('data', d => err+=d.toString());
    proc.on('error', e => resolve({ ok:false, code:-1, stdout:'', stderr:e.message }));
    proc.on('close', code => resolve({ ok:code===0, code, stdout:out, stderr:err }));
  });
}

// ─── JAA / PHP / Apache / Nginx bridge ───────────────────────────────────────
async function jaaRequest(endpoint, body={}) {
  const jaaUrl = _cfg.jaaUrl || 'http://127.0.0.1:8080';
  return httpReq(jaaUrl + endpoint, {}, body, { method:'POST', headers:{'Content-Type':'application/json','X-JAA-Key':_cfg.jaaKey||''} });
}

// ─── NOIP / DHCP-style discovery (no port forward required) ──────────────────
function getNoIPUrl() {
  return _cfg.noipUrl || _cfg.ddnsUrl || null;
}

// ─── Build a new route handler section (appended into handleRequest flow) ─────
// This is called from inside handleRequest BEFORE the 404 fallback.
async function handleBridgeExtension(req, res, parts, method, u) {

  // ── SNR gate on every request if enabled ────────────────────────────────────
  if (_snr && _cfg.snrEnabled) {
    const snrResult = _snr.check({ url: u.href, domain: u.hostname || req.headers.host, intent: req.headers['x-intent'], uuid: req.headers['x-caller-uuid'] });
    if (!snrResult.pass) {
      busEmit('snr:block',{url:u.pathname,fidelity:snrResult.fidelity,reason:snrResult.reason},'SNR');
      return jsonRes(res,403,{error:'Blocked by SNR gate',reason:snrResult.reason,fidelity:snrResult.fidelity,gateId:snrResult.gateId});
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /gate — Mutual gate permission management
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0] === 'gate') {
    // POST /gate/issue — issue a gate key
    if (method==='POST' && parts[1]==='issue') {
      const b = await readBody(req);
      const { gateId, key } = issueGateKey(b);
      return jsonRes(res,200,{ok:true,gateId,key,uuid:GATE_UUID});
    }
    // POST /gate/verify — verify a key from remote bridge
    if (method==='POST' && parts[1]==='verify') {
      const b = await readBody(req);
      return jsonRes(res,200,verifyGateKey(b.gateId,b.key,b.callerUUID));
    }
    // GET /gate/list
    if (method==='GET' && parts[1]==='list') {
      return jsonRes(res,200,{gates:[..._gatePermissions.values()].map(({key,...g})=>({...g,keyHash:crypto.createHash('sha256').update(key).digest('hex').slice(0,16)+'…'}))});
    }
    // DELETE /gate/:id
    if (method==='DELETE' && parts[1]) { _gatePermissions.delete(parts[1]); return jsonRes(res,200,{ok:true}); }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /snr — Signal/Noise filter management
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0] === 'snr') {
    if (!_snr) return jsonRes(res,503,{error:'SNR filter not loaded'});
    // GET /snr/stats
    if (method==='GET' && parts[1]==='stats') return jsonRes(res,200,_snr.stats());
    // GET /snr/rules
    if (method==='GET' && parts[1]==='rules') return jsonRes(res,200,{rules:_snr.listRules(Object.fromEntries(u.searchParams))});
    // POST /snr/rules — add rule
    if (method==='POST' && parts[1]==='rules') { const b=await readBody(req); const id=_snr.addRule(b); return jsonRes(res,200,{ok:true,id}); }
    // PATCH /snr/rules/:id — update rule
    if (method==='PATCH' && parts[1]==='rules' && parts[2]) { const b=await readBody(req); const r=_snr.updateRule(parts[2],b); return jsonRes(res,r?200:404,r||{error:'Not found'}); }
    // DELETE /snr/rules/:id
    if (method==='DELETE' && parts[1]==='rules' && parts[2]) { return jsonRes(res,200,{ok:_snr.removeRule(parts[2])}); }
    // POST /snr/check — check a URL/domain/content
    if (method==='POST' && parts[1]==='check') { const b=await readBody(req); return jsonRes(res,200,_snr.check(b)); }
    // POST /snr/import/ublock — import uBlock list
    if (method==='POST' && parts[1]==='import' && parts[2]==='ublock') { const b=await readBody(req); return jsonRes(res,200,_snr.importUBlock(b.list||b.text||'',{fidelity:b.fidelity,source:b.source})); }
    // POST /snr/import/dns
    if (method==='POST' && parts[1]==='import' && parts[2]==='dns') { const b=await readBody(req); return jsonRes(res,200,_snr.importDNSFirewall(b.list||'',b)); }
    // POST /snr/import/antivirus
    if (method==='POST' && parts[1]==='import' && parts[2]==='antivirus') { const b=await readBody(req); return jsonRes(res,200,_snr.importAntivirus(b.list||'',b)); }
    // POST /snr/import/blacklist
    if (method==='POST' && parts[1]==='import' && parts[2]==='blacklist') { const b=await readBody(req); return jsonRes(res,200,_snr.importBlacklist(b.list||[],b)); }
    // POST /snr/import/whitelist
    if (method==='POST' && parts[1]==='import' && parts[2]==='whitelist') { const b=await readBody(req); return jsonRes(res,200,_snr.importWhitelist(b.list||[],b)); }
    // GET /snr/logs
    if (method==='GET' && parts[1]==='logs') return jsonRes(res,200,{logs:_snr.getLogs({limit:parseInt(u.searchParams.get('limit')||'100')})});
    // POST /snr/priority/:id — set priority/fidelity/signal
    if (method==='POST' && parts[1]==='priority' && parts[2]) { const b=await readBody(req); return jsonRes(res,200,{ok:_snr.setPriority(parts[2],b.priority,b.signal)}); }
    // POST /snr/fidelity/:id
    if (method==='POST' && parts[1]==='fidelity' && parts[2]) { const b=await readBody(req); return jsonRes(res,200,{ok:!!_snr.setFidelity(parts[2],b.fidelity)}); }
    // POST /snr/persist
    if (method==='POST' && parts[1]==='persist') { return jsonRes(res,200,{ok:_snr.persist(path.join(DATA_DIR,'snr-rules.json'))}); }
    // GET /snr/enable / /snr/disable
    if (method==='POST' && parts[1]==='enable')  { saveCfg({snrEnabled:true});  return jsonRes(res,200,{ok:true,enabled:true}); }
    if (method==='POST' && parts[1]==='disable') { saveCfg({snrEnabled:false}); return jsonRes(res,200,{ok:true,enabled:false}); }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /hub — Proxy to NEXUS Hub API (all Hub calltos route through here)
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0] === 'hub') {
    // Check gate permission if configured
    const gateId  = req.headers['x-gate-id'];
    const gateKey = req.headers['x-gate-key'];
    if (_cfg.hubRequireGate && gateId) {
      const gv = verifyGateKey(gateId, gateKey, req.headers['x-caller-uuid']);
      if (!gv.ok) return jsonRes(res,403,{error:'Gate check failed',reason:gv.reason});
    }

    const hubPath  = '/' + parts.slice(1).join('/') + (u.search||'');
    const b        = ['POST','PUT','PATCH','DELETE'].includes(method) ? await readBody(req) : null;
    try {
      const r = await hubProxy(hubPath, method, b);
      return jsonRes(res, r.status||200, r.data||r);
    } catch(e) {
      return jsonRes(res,502,{error:'Hub proxy error: '+e.message, hubUrl:getHubUrl(), hint:'Is NEXUS Hub running?'});
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /hub/vault — vault calltos through bridge
  // /hub/auth  — auth calltos through bridge
  // /hub/router — router calltos through bridge
  // /hub/commands — command calltos
  // /hub/connector/:service/:action — connector calltos
  // (all handled by the /hub proxy above — any /hub/* goes to Hub)
  // ══════════════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════════════
  // /cli — Command-line tool execution (Win/Linux/Mac)
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0] === 'cli' || parts[0] === 'bridge') {
    const b = await readBody(req).catch(()=>({}));
    // POST /cli/exec — run arbitrary shell command
    if (parts[1]==='exec' || parts[1]==='run') {
      if (!_cfg.cliEnabled) return jsonRes(res,403,{error:'CLI execution disabled. POST /config {cliEnabled:true} to enable.'});
      const { command, args=[], cwd, env, timeout } = b;
      if (!command) return jsonRes(res,400,{error:'command required'});
      const result = await runCLI(command, Array.isArray(args)?args:[], { cwd, env, timeout });
      busEmit('cli:exec',{command,ok:result.ok,code:result.code});
      return jsonRes(res,200,result);
    }
    // POST /cli/npm — npm install/build/start/test
    if (parts[1]==='npm') {
      if (!_cfg.cliEnabled) return jsonRes(res,403,{error:'CLI disabled'});
      const { command='install', cwd='.', flags=[] } = b;
      const npmBin = process.platform==='win32'?'npm.cmd':'npm';
      const result = await runCLI(npmBin, [command,...flags], { cwd, timeout:300000 });
      busEmit('cli:npm',{command,ok:result.ok});
      return jsonRes(res,200,result);
    }
    // POST /cli/git — git operations
    if (parts[1]==='git') {
      if (!_cfg.cliEnabled) return jsonRes(res,403,{error:'CLI disabled'});
      const { command='status', cwd='.', args:gArgs=[] } = b;
      const result = await runCLI('git', [command,...gArgs], { cwd });
      return jsonRes(res,200,result);
    }
    // POST /cli/apt — apt package management (Linux)
    if (parts[1]==='apt') {
      if (process.platform!=='linux') return jsonRes(res,400,{error:'apt only available on Linux'});
      const { package:pkg, action='install' } = b;
      const result = await runCLI('sudo', ['apt',action,'-y',pkg||''], {});
      busEmit('cli:apt',{pkg,action,ok:result.ok});
      return jsonRes(res,200,result);
    }
    // POST /cli/php — run PHP script
    if (parts[1]==='php') {
      const { script, args:phpArgs=[], cwd } = b;
      const result = await runCLI('php', [script,...phpArgs], { cwd });
      return jsonRes(res,200,result);
    }
    // POST /cli/python
    if (parts[1]==='python') {
      const { script, args:pyArgs=[], cwd } = b;
      const python = process.platform==='win32'?'python':'python3';
      const result = await runCLI(python, [script,...pyArgs], { cwd });
      return jsonRes(res,200,result);
    }
    // POST /cli/docker
    if (parts[1]==='docker') {
      const { command='ps', args:dArgs=[] } = b;
      const result = await runCLI('docker', [command,...dArgs], {});
      return jsonRes(res,200,result);
    }
    // POST /cli/ssh — SSH via CLI
    if (parts[1]==='ssh') {
      const { host, user, command:sshCmd, port=22, key } = b;
      const args = ['-o','StrictHostKeyChecking=no','-p',String(port)];
      if (key) args.push('-i',key);
      args.push(`${user}@${host}`, sshCmd||'echo connected');
      const result = await runCLI('ssh', args, { timeout:30000 });
      return jsonRes(res,200,result);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /jaa — JAA API bridge (PHP/Apache integration)
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0] === 'jaa') {
    const b = await readBody(req).catch(()=>({}));
    const endpoint = '/' + parts.slice(1).join('/');
    try {
      const r = await jaaRequest(endpoint, b);
      return jsonRes(res,200,r.data||r);
    } catch(e) {
      return jsonRes(res,502,{error:'JAA proxy error: '+e.message, jaaUrl:_cfg.jaaUrl||'http://127.0.0.1:8080'});
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /apache — Apache2 / Nginx vhost management via CLI
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0]==='apache' || parts[0]==='nginx') {
    if (!_cfg.cliEnabled) return jsonRes(res,403,{error:'CLI disabled'});
    const b   = await readBody(req).catch(()=>({}));
    const srv = parts[0];
    // POST /apache/restart
    if (parts[1]==='restart') { return jsonRes(res,200,await runCLI('sudo',['service',srv,'restart'],{})); }
    if (parts[1]==='status')  { return jsonRes(res,200,await runCLI('sudo',['service',srv,'status'], {})); }
    if (parts[1]==='reload')  { return jsonRes(res,200,await runCLI('sudo',['service',srv,'reload'], {})); }
    if (parts[1]==='enable' && b.site)  { return jsonRes(res,200,await runCLI('sudo',['a2ensite',b.site],{})); }
    if (parts[1]==='disable' && b.site) { return jsonRes(res,200,await runCLI('sudo',['a2dissite',b.site],{})); }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /webrtc — WebRTC peer signalling relay
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0]==='webrtc') {
    const b = await readBody(req).catch(()=>({}));
    if (parts[1]==='offer')  { const id=crypto.randomUUID().slice(-5); _cfg._webrtcOffers=_cfg._webrtcOffers||{}; _cfg._webrtcOffers[id]=b; return jsonRes(res,200,{ok:true,peerId:id,last5:id}); }
    if (parts[1]==='answer') { const offer=(_cfg._webrtcOffers||{})[b.peerId]; return jsonRes(res,200,{ok:!!offer,offer}); }
    if (parts[1]==='peers')  { return jsonRes(res,200,{peers:Object.keys(_cfg._webrtcOffers||{})}); }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /p2p — P2P connection relay (no port forward via STUN/TURN)
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0]==='p2p') {
    // Announce this bridge as a P2P endpoint
    if (parts[1]==='announce') {
      const noipUrl = getNoIPUrl();
      if (!noipUrl) return jsonRes(res,503,{error:'No DDNS/NoIP URL configured. POST /config {noipUrl:"..."}.'});
      try {
        const r = await httpReq(noipUrl+'/p2p/register',{},{bridgeId:GATE_UUID,port:PORT,host:HOST},{method:'POST',headers:{'Content-Type':'application/json'}});
        return jsonRes(res,200,r);
      } catch(e) { return jsonRes(res,502,{error:e.message}); }
    }
    // GET /p2p/info — info about this bridge for P2P connection
    if (parts[1]==='info') {
      return jsonRes(res,200,{bridgeId:GATE_UUID,port:PORT,host:HOST,noipUrl:getNoIPUrl(),last5:GATE_UUID.slice(-5),version:VERSION});
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /uuid — UUID-addressed callto routing
  // Every feature, hook, and connection has a UUID.
  // POST /uuid/:uuid — route payload to registered UUID handler
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0]==='uuid') {
    const targetUUID = parts[1];
    if (!targetUUID) return jsonRes(res,400,{error:'UUID required'});
    const b = await readBody(req).catch(()=>({}));
    // Apply SNR check on UUID-addressed request
    if (_snr) {
      const snrResult = _snr.check({ uuid:targetUUID, intent:b.intent });
      if (!snrResult.pass) return jsonRes(res,403,{error:'Blocked by SNR gate',fidelity:snrResult.fidelity,gateId:snrResult.gateId});
    }
    // Forward to Hub router if Hub is configured
    if (_cfg.hubUrl) {
      try {
        const r = await hubProxy('/api/router/route',   'POST', { targetUUID, payload:b });
        return jsonRes(res,200,r.data||r);
      } catch(e) { return jsonRes(res,502,{error:'Hub route error: '+e.message}); }
    }
    // Fallback: emit on local bus
    busEmit('uuid:route',{targetUUID,payload:b});
    return jsonRes(res,200,{ok:true,targetUUID,routed:'local-bus'});
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /hooks — Hook registry calltos (list, test, register, deregister)
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0]==='hooks') {
    const b = await readBody(req).catch(()=>({}));
    if (method==='GET' && !parts[1]) return jsonRes(res,200,{hooks:[...EVENTS.slice(-50).filter(e=>e.type.includes('hook'))],uuid:GATE_UUID});
    if (method==='POST' && parts[1]==='test')     { busEmit('hook:test',   b); return jsonRes(res,200,{ok:true,event:b}); }
    if (method==='POST' && parts[1]==='register') { busEmit('hook:register',b); return jsonRes(res,200,{ok:true,hookId:'hook:'+crypto.randomUUID().slice(0,12)}); }
    if (method==='POST' && parts[1]==='emit')     { busEmit(b.type||'hook:custom',b.data||b); return jsonRes(res,200,{ok:true}); }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /log — bridge event log with UUID + hook context
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0]==='log') {
    const limit  = parseInt(u.searchParams.get('limit')||'200');
    const filter = u.searchParams.get('type');
    let logs = EVENTS;
    if (filter) logs = logs.filter(e => e.type.includes(filter));
    return jsonRes(res,200,{logs:logs.slice(-limit), bridgeId:GATE_UUID, version:VERSION});
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /broadcast — BroadcastChannel-style messaging (replaces broadcast:// protocol)
  // broadcast://6xxg12v5mnky86h6 → POST /broadcast/6xxg12v5mnky86h6
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0]==='broadcast') {
    const channelId = parts[1];
    const b = await readBody(req).catch(()=>({}));
    if (!channelId) return jsonRes(res,400,{error:'Channel ID required'});
    busEmit('broadcast:'+channelId, b);
    // Return events for this channel
    const msgs = EVENTS.filter(e => e.type==='broadcast:'+channelId).slice(-50);
    return jsonRes(res,200,{ok:true,channelId,messages:msgs,bridgeUrl:`http://${HOST}:${PORT}/broadcast/${channelId}`});
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /noip — NoIP-style DHCP discovery (connection without port forwarding)
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0]==='noip' || parts[0]==='dhcp') {
    if (parts[1]==='register') {
      const b = await readBody(req).catch(()=>({}));
      saveCfg({noipRegistered:true,noipId:b.id||GATE_UUID.slice(-8),noipRegisteredAt:new Date().toISOString()});
      return jsonRes(res,200,{ok:true,id:_cfg.noipId,bridgeId:GATE_UUID});
    }
    if (parts[1]==='lookup') {
      return jsonRes(res,200,{bridgeId:GATE_UUID,port:PORT,host:HOST,noipId:_cfg.noipId});
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /detect-browser — detect running system browsers via process list
  // Called by nexus.html pwDetectSystemBrowser(). Returns browsers[] with
  // exe, pid, type, profile, dataDir. No psutil dependency — pure Node.
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0] === 'detect-browser') {
    const { execSync } = require('child_process');
    const browsers = [];
    const home = os.homedir();
    const plat = process.platform;

    // Known browser process names per platform
    const browserNames = plat === 'win32'
      ? ['chrome.exe','firefox.exe','msedge.exe','brave.exe','opera.exe']
      : plat === 'darwin'
      ? ['Google Chrome','firefox','Safari','Microsoft Edge','Brave Browser','Opera']
      : ['chrome','chromium','chromium-browser','firefox','firefox-esr','microsoft-edge','brave-browser','opera'];

    try {
      let procList = '';
      if (plat === 'win32') {
        procList = execSync('tasklist /fo csv /nh', { timeout:5000, encoding:'utf8' });
        const lines = procList.split('\n').filter(l => l.trim());
        for (const line of lines) {
          const parts2 = line.replace(/"/g,'').split(',');
          const name = parts2[0]?.trim();
          const pid  = parseInt(parts2[1]||'0');
          if (!name || !pid) continue;
          const matched = browserNames.find(b => name.toLowerCase().includes(b.replace('.exe','').toLowerCase()));
          if (!matched) continue;
          const type = name.toLowerCase().includes('firefox') ? 'firefox'
            : name.toLowerCase().includes('edge') ? 'msedge'
            : name.toLowerCase().includes('brave') ? 'chrome'
            : 'chromium';
          // Find default profile path
          const profileBase = type === 'firefox'
            ? path.join(process.env.APPDATA||'', 'Mozilla','Firefox','Profiles')
            : path.join(process.env.LOCALAPPDATA||'', 'Google','Chrome','User Data');
          let profile = null, dataDir = null;
          try { if (fs.existsSync(profileBase)) { const entries = fs.readdirSync(profileBase); profile = entries[0] ? path.join(profileBase, entries[0]) : null; dataDir = profileBase; } } catch {}
          browsers.push({ name:matched, pid, type, exe:name, profile, dataDir });
        }
      } else {
        const cmd = plat === 'darwin' ? 'ps -ax -o pid,comm' : 'ps -ax -o pid,comm --no-headers 2>/dev/null || ps aux';
        procList = execSync(cmd, { timeout:5000, encoding:'utf8' });
        const lines = procList.split('\n');
        const seen = new Set();
        for (const line of lines) {
          const trimmed = line.trim();
          const spaceIdx = trimmed.indexOf(' ');
          if (spaceIdx < 0) continue;
          const pid = parseInt(trimmed.slice(0, spaceIdx));
          const comm = trimmed.slice(spaceIdx+1).trim();
          if (!pid || seen.has(comm)) continue;
          const matched = browserNames.find(b => comm.toLowerCase().includes(b.toLowerCase().split(' ')[0]));
          if (!matched) continue;
          seen.add(comm);
          const type = comm.toLowerCase().includes('firefox') ? 'firefox'
            : comm.toLowerCase().includes('chromium') ? 'chromium'
            : comm.toLowerCase().includes('edge') ? 'msedge'
            : comm.toLowerCase().includes('brave') ? 'chrome'
            : 'chrome';
          // Default profile paths
          let profileBase = null;
          if (type === 'firefox') {
            profileBase = plat === 'darwin'
              ? path.join(home, 'Library','Application Support','Firefox','Profiles')
              : path.join(home, '.mozilla','firefox');
          } else {
            profileBase = plat === 'darwin'
              ? path.join(home, 'Library','Application Support','Google','Chrome')
              : path.join(home, '.config','google-chrome');
          }
          let profile = null, dataDir = profileBase;
          try { if (profileBase && fs.existsSync(profileBase)) { const entries = fs.readdirSync(profileBase).filter(e => { try { return fs.statSync(path.join(profileBase,e)).isDirectory(); } catch { return false; } }); profile = entries[0] ? path.join(profileBase, entries[0]) : profileBase; } } catch {}
          browsers.push({ name: matched, pid, type, exe: comm, profile, dataDir });
        }
      }
    } catch(e) {
      busEmit('detect-browser:error', { error: e.message }, 'WARN');
    }

    // Also check CDP ports — if browser has remote debug, add cdpPort
    for (const b of browsers) {
      const cdpPort = b.type === 'firefox' ? null : 9222;
      if (cdpPort) {
        const r = await new Promise(res => {
          const req2 = http.get({ hostname:'127.0.0.1', port:cdpPort, path:'/json/version', timeout:500 }, r2 => {
            let d=''; r2.on('data',c=>d+=c); r2.on('end',()=>res({ ok:true, port:cdpPort, info: (() => { try { return JSON.parse(d); } catch { return {}; } })() }));
          }); req2.on('error',()=>res({ ok:false })); req2.on('timeout',()=>{ req2.destroy(); res({ ok:false }); });
        });
        if (r.ok) { b.cdpPort = cdpPort; b.cdpWsUrl = r.info.webSocketDebuggerUrl || `ws://127.0.0.1:${cdpPort}`; }
      }
    }

    busEmit('browser:detected', { count: browsers.length });
    return jsonRes(res, 200, { ok:true, browsers, platform:plat, home });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /browser/open-test — open a test window in the system browser via Playwright
  // Called by nexus.html pwOpenTestWindow(). Delegates to PlaywrightController.
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0] === 'browser' && parts[1] === 'open-test') {
    const b = await readBody(req).catch(() => ({}));
    const testUrl = b.url || 'https://www.google.com';
    // Try to launch via PlaywrightController (uses CDP attach first)
    try {
      const result = await PlaywrightController.route(
        ['playwright', 'launch'], 'POST',
        { profilePath: b.browserConfig?.dataDir, headless: false, forceNew: false },
        req, { headersSent: true, writeHead(){}, end(){} }  // dummy — we capture return value
      );
      // After attach, navigate
      const navResult = await PlaywrightController.route(
        ['playwright', 'send'], 'POST',
        { action: 'navigate', url: testUrl },
        req, { headersSent: true, writeHead(){}, end(){} }
      );
      const st = PlaywrightController.getState();
      return jsonRes(res, 200, { ok:true, url:testUrl, mode:st.mode, sessionUuid:st.sessionUuid, browserType: b.browserConfig?.browserType || 'detected' });
    } catch(e) {
      return jsonRes(res, 503, { ok:false, error: e.message, hint:'Bridge could not open browser: ' + e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /check/ollama — Ollama health check (used by popup and nexus.html)
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0] === 'check' && parts[1] === 'ollama') {
    const url = _cfg.ollamaUrl || 'http://localhost:11434';
    try {
      const t0 = Date.now();
      const r  = await httpReq(url + '/api/tags', {}, null);
      const lat = Date.now() - t0;
      const models = (r.data?.models || []).map(m => m.name);
      return jsonRes(res, 200, { ok: r.status === 200, url, latencyMs: lat, models, count: models.length });
    } catch(e) {
      return jsonRes(res, 200, { ok: false, url, error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /hook/test — test a hook by ID (used by popup diagnostics)
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0] === 'hook' && parts[1] === 'test') {
    const b = await readBody(req).catch(() => ({}));
    const hookId = b.hookId || b.id;
    if (!hookId) return jsonRes(res, 400, { error: 'hookId required' });

    // Run a real health check based on hookId prefix
    let ok = true, detail = 'registered';
    if (hookId.startsWith('bridge.health'))  { try { ok = !!EVENTS.length || process.uptime() > 0; detail = 'uptime: '+Math.floor(process.uptime())+'s'; } catch { ok=false; } }
    if (hookId.startsWith('ext.register'))   { ok = Object.keys(_extensionSessions).length > 0; detail = ok ? Object.keys(_extensionSessions).length+' sessions' : 'no sessions'; }
    if (hookId.startsWith('ext.profile'))    { ok = fs.existsSync(path.join(DATA_DIR,'extension-profile.json')); detail = ok ? 'profile file exists' : 'no profile file'; }
    if (hookId.startsWith('ext.cdp'))        { const cdp = PlaywrightController.getState().cdpSession; ok = !!cdp; detail = cdp ? 'port '+cdp.port : 'no cdp'; }
    if (hookId.startsWith('pw.'))            { const st = PlaywrightController.getState(); ok = st.mode !== 'none' || hookId === 'pw.status'; detail = st.mode; }
    if (hookId.startsWith('bridge.ai'))      { ok = !!((_cfg.claudeKey)||(_cfg.chatgptKey)||(_cfg.deepseekKey)||(_cfg.ollamaUrl)); detail = ok ? 'provider configured' : 'no provider'; }
    if (hookId.startsWith('bridge.snr'))     { ok = !!_snr; detail = _snr ? _snr.rules.size+' rules' : 'snr not loaded'; }
    if (hookId.startsWith('bridge.bc'))      { ok = true; detail = 'bus active, '+EVENTS.length+' events'; }
    if (hookId.startsWith('ollama.health'))  { try { const r=await httpReq((_cfg.ollamaUrl||'http://localhost:11434')+'/api/tags',{},null); ok=r.status===200; detail=ok?'online':'offline'; } catch { ok=false; detail='offline'; } }

    busEmit('hook:test', { hookId, ok, detail });
    return jsonRes(res, 200, { ok, hookId, detail, ts: Date.now() });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /hook/register — register a custom hook (used by popup hooks tab)
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0] === 'hook' && parts[1] === 'register') {
    const b = await readBody(req).catch(() => ({}));
    const hookId = b.hookId || ('hook:' + crypto.randomUUID().slice(0, 12));
    busEmit('hook:registered', { hookId, label: b.label, event: b.event });
    return jsonRes(res, 200, { ok:true, hookId, label: b.label, event: b.event, uuid: GATE_UUID });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /ai — unified AI proxy (intent gate routing) — used by popup AI tab
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0] === 'ai' && method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    const { messages, provider, intent, model } = b;
    if (!messages?.length) return jsonRes(res, 400, { error: 'messages[] required' });
    // Delegate to the /v1/messages handler logic by rewriting parts
    const fakeReq = Object.assign(Object.create(req), {
      method:'POST',
      _cachedBody: b,
    });
    // Build a synthetic request through the main handler
    try {
      const intentChain = intent ? (_intentMap[intent]?.providers || _intentMap.default.providers) : null;
      const eff = provider !== 'auto' && provider ? provider : (intentChain?.[0] || 'auto');
      let response;
      if (eff === 'ollama' || (!eff && _cfg.ollamaUrl && !_cfg.claudeKey && !_cfg.chatgptKey)) {
        const ollamaUrl = _cfg.ollamaUrl || 'http://localhost:11434';
        let available = [];
        try { const r = await httpReq(ollamaUrl+'/api/tags',{},null); available=(r.data?.models||[]).map(m=>m.name); } catch {}
        const m2 = selectOllamaModel(intent||'default', available, model||null);
        response = await withTO(ollamaChat({ url:ollamaUrl, model:m2, messages }), REQUEST_TIMEOUT);
      } else if ((eff==='claude'||(!eff&&_cfg.claudeKey)) && _cfg.claudeKey) {
        response = await withTO(claudeAPIChat({ apiKey:_cfg.claudeKey, model:model||'claude-sonnet-4-20250514', messages }), REQUEST_TIMEOUT);
      } else if ((eff==='chatgpt'||(!eff&&_cfg.chatgptKey)) && _cfg.chatgptKey) {
        response = await withTO(openAIChat({ apiKey:_cfg.chatgptKey, model:model||'gpt-4o-mini', messages }), REQUEST_TIMEOUT);
      } else if ((eff==='deepseek'||(!eff&&_cfg.deepseekKey)) && _cfg.deepseekKey) {
        response = await withTO(deepSeekChat({ apiKey:_cfg.deepseekKey, model:model||'deepseek-chat', messages }), REQUEST_TIMEOUT);
      } else {
        return jsonRes(res, 503, { error:'No AI provider configured. POST /config with {claudeKey, chatgptKey, deepseekKey, ollamaUrl}' });
      }
      busEmit('ai:response', { provider:response._meta?.provider||eff, intent }, 'LLM');
      return jsonRes(res, 200, response);
    } catch(e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // /extension/tab-active — extension reports active tab change
  // ══════════════════════════════════════════════════════════════════════════════
  if (parts[0]==='extension' && parts[1]==='tab-active' && method==='POST') {
    const b = await readBody(req).catch(() => ({}));
    busEmit('extension:tab_active', b, 'INFO');
    PlaywrightController.route(['playwright','tab-active'], 'POST', b, req, res);
    return; // PlaywrightController writes the response
  }

  return null; // signal: not handled by extension, let original 404 fire
}
