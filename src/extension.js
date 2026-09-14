const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { post: postBackend, get: getBackend } = require('./backendClient');

const KEY = 'hypotrace.profile.v1';
const now = () => new Date().toISOString();
const clamp = n => Math.max(0, Math.min(1, n));
const last = items => items && items.length ? items[items.length - 1] : undefined;
const activeAiFindings = new Map();
const inspectionTimers = new Map();
let outcomeQueue = Promise.resolve();
let profileRefreshTimer;
let dashboardRender;
const LEARNING_GENERATION = 'learning-v6';
const BACKEND_REVISION = '0.7.9';
function backendUserId(config=vscode.workspace.getConfiguration('hypotrace')) {
  return `${config.get('backendUserId','local-dev')}:${LEARNING_GENERATION}`;
}

function initialProfile() {
  return {
    version: 7, privacy: 'semantic-only', sessions: [], events: [], episodes: [],
    signatures: [], hypotheses: [], predictions: [], experiments: [],
    transfer: [], retention: [], strengths: [], debt: [],
    milestone: { label: 'First observed learning goal', progress: 0, total: 1 },
    interventionBudget: 3, active: true, ghostMode: false, lastEpisodeEventCount: 0, openSessions: {},
    adaptiveRisk: {bias:0,weights:{editBurst:0,rewrite:0,navigation:0,debug:0,plan:0,priorFailure:0},updates:0,history:[]},
    skills: [], evolution: [], knowledge: [], projectAssessments: {}, professionalProfile: null,
    runEvidence: {},
    observability: { terminalCommands:0, shellIntegratedTerminals:0, backendEpisodes:0, aiInspections:0, lastOutcome:'none', lastBackend:'not contacted' },
    concepts: [], learningModel: null, falseMastery: [], scheduledChecks: [], freshStartAt: null
  };
}

function getProfile(context) {
  const saved = context.globalState.get(KEY);
  if (!saved) return initialProfile();
  const base = initialProfile();
  return {...base, ...saved, openSessions:saved.openSessions || {}, skills:saved.skills || base.skills, evolution:saved.evolution || base.evolution, knowledge:saved.knowledge || base.knowledge, projectAssessments:saved.projectAssessments || base.projectAssessments, professionalProfile:saved.professionalProfile || base.professionalProfile, runEvidence:saved.runEvidence || base.runEvidence, adaptiveRisk:{...base.adaptiveRisk,...(saved.adaptiveRisk || {}),weights:{...base.adaptiveRisk.weights,...(saved.adaptiveRisk?.weights || {})}}, concepts:[], learningModel:saved.learningModel || null, falseMastery:saved.falseMastery || [], scheduledChecks:saved.scheduledChecks || [], freshStartAt:saved.freshStartAt || null};
}
async function save(context, profile) { await context.globalState.update(KEY, profile); }
function isPrivate(doc) {
  const value = doc.uri.fsPath.toLowerCase();
  return value.includes('.env') || value.includes('secret') || value.includes('credential');
}
function sigmoid(value) { return 1 / (1 + Math.exp(-Math.max(-12,Math.min(12,value)))); }
function riskFeatures(profile) {
  const recent=(profile.events || []).filter(event=>Date.now()-Date.parse(event.at || now()) <= 5*60*1000).slice(-40);
  const count=Math.max(1,recent.length);
  const failed=recent.filter(event=>event.type==='DIAGNOSTIC').length;
  return {
    editBurst:recent.filter(event=>event.type==='EDIT_BURST').length / count,
    rewrite:recent.filter(event=>event.type==='REVERT' || (event.type==='EDIT_BURST' && event.charsDelta<0)).length / count,
    navigation:recent.filter(event=>event.type==='NAVIGATION').length / count,
    debug:recent.filter(event=>event.type==='DEBUG_STEP').length / count,
    plan:recent.some(event=>event.type==='REASON_NOTE') ? 0 : 1,
    priorFailure:failed / count
  };
}
function risk(profile) {
  const model=profile.adaptiveRisk || initialProfile().adaptiveRisk;
  if ((model.updates || 0) < 2) return 0;
  const features=riskFeatures(profile);
  const score=Object.entries(features).reduce((sum,[key,value])=>sum+(model.weights?.[key] || 0)*value,model.bias || 0);
  return clamp(sigmoid(score));
}
function updateAdaptiveRisk(profile, didFail) {
  const model=profile.adaptiveRisk || initialProfile().adaptiveRisk;
  const features=riskFeatures(profile); const predicted=(model.updates || 0) < 2 ? .5 : risk(profile);
  const error=(didFail ? 1 : 0)-predicted;
  const rate=1/Math.sqrt((model.updates || 0)+1);
  const weights={...(model.weights || {})};
  for (const [key,value] of Object.entries(features)) weights[key]=(weights[key] || 0)+rate*error*value;
  const next={bias:(model.bias || 0)+rate*error,weights,updates:(model.updates || 0)+1,history:[...(model.history || []).slice(-39),{at:now(),predicted,actual:didFail?1:0,features}]};
  profile.adaptiveRisk=next;
  return next;
}
function titleCase(value) { return String(value).replace(/^runtime-/, '').replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase()); }
function updateRunEvidence(profile, workspaceId, update) {
  if (!workspaceId) return;
  const current=profile.runEvidence?.[workspaceId] || {runs:0,failures:0,recoveries:0,patterns:{},patternStats:{},calibration:{total:0,matched:0,avoided:0,brierTotal:0,history:[]},history:[]};
  const next={...current,...update};
  next.lastRunAt=now();
  if (update.category) {
    next.patterns={...current.patterns,[update.category]:(current.patterns?.[update.category] || 0) + (update.increment ?? 1)};
    const prior=current.patternStats?.[update.category] || {failures:0,recoveries:0,lastFailureAt:null,lastRecoveryAt:null};
    const stat={...prior};
    if (update.outcome==='failure') { stat.failures+=(update.increment ?? 1); stat.lastFailureAt=now(); }
    if (update.outcome==='recovery') { stat.recoveries+=1; stat.lastRecoveryAt=now(); }
    next.patternStats={...current.patternStats,[update.category]:stat};
  }
  next.history=[...(current.history || []).slice(-39),{at:now(),runs:next.runs || 0,failures:next.failures || 0,recoveries:next.recoveries || 0,outcome:update.outcome || 'observed'}];
  profile.runEvidence={...(profile.runEvidence || {}),[workspaceId]:next};
}
function resolveForecast(profile, workspaceId, category, happened, outcome) {
  const prediction=[...(profile.predictions || [])].reverse().find(item=>item.realized===null && item.workspaceId===workspaceId && item.category===category);
  if (!prediction) return;
  prediction.realized=happened; prediction.outcome=outcome; prediction.resolvedAt=now();
  const evidence=profile.runEvidence?.[workspaceId] || {};
  const calibration=evidence.calibration || {total:0,matched:0,avoided:0,brierTotal:0,history:[]};
  const probability=Math.max(0,Math.min(1,Number(prediction.probability || 0)));
  const actual=happened ? 1 : 0;
  const next={total:calibration.total+1,matched:calibration.matched+(happened?1:0),avoided:calibration.avoided+(happened?0:1),brierTotal:calibration.brierTotal+(probability-actual)**2,history:[...(calibration.history || []).slice(-29),{at:now(),category,confidence:probability,actual,outcome}]};
  profile.runEvidence={...(profile.runEvidence || {}),[workspaceId]:{...evidence,calibration:next}};
}
async function persistForecastOutcome(context, category, happened) {
  const config=vscode.workspace.getConfiguration('hypotrace'); const url=String(config.get('backendUrl','')).replace(/\/$/,'');
  if (!url || !category) return;
  try {
    const result=await postBackend(`${url}/v1/forecast-outcomes`,{user_id:backendUserId(config),workspace_id:backendWorkspaceId(),category,happened});
    const p=getProfile(context); const workspaceId=workspaceAssessmentKey(); const evidence=p.runEvidence?.[workspaceId] || {};
    if (result.calibration) {
      p.runEvidence={...(p.runEvidence || {}),[workspaceId]:{...evidence,serverCalibration:{...(evidence.serverCalibration || {}),[category]:result.calibration}}};
    }
    if (result.trial_id) {
      const experiment=(p.experiments || []).find(item=>item.id===result.trial_id);
      if (experiment) { experiment.outcome=happened?'recurred on the next matching run':'recovered on the next matching run'; experiment.measuredAt=now(); }
    }
    for (const type of result.learning_events || []) {
      const event={id:`${type}-${Date.now()}-${category}`,category,at:now(),toWorkspace:workspaceId,evidence:type==='transfer'?'A matching recovery occurred in another workspace.':type==='retention'?'A matching recovery held after a personal time gap.':'The same pattern returned soon after a recovery.'};
      if(type==='transfer') p.transfer=[...(p.transfer||[]).slice(-39),event];
      if(type==='retention') p.retention=[...(p.retention||[]).slice(-39),event];
      if(type==='false_mastery') p.falseMastery=[...(p.falseMastery||[]).slice(-39),event];
    }
    await save(context,p); dashboardRender?.();
  } catch (_) {}
}
function recordLearningOutcomes(profile, workspaceId, category) {
  const timestamp=now();
  const related=(profile.episodes || []).filter(item=>item.categories?.includes(category) && item.kind==='diagnostic');
  const prior=related[related.length-1];
  if (!prior) return;
  const isTransfer=prior.workspaceId && prior.workspaceId!==workspaceId;
  const elapsed=Math.max(0,Date.now()-Date.parse(prior.endedAt || prior.startedAt || timestamp));
  const item={id:`L-${Date.now()}`,category,at:timestamp,fromWorkspace:prior.workspaceId,toWorkspace:workspaceId,result:'passed',evidence:'matching real run completed successfully'};
  if (isTransfer) profile.transfer=[...(profile.transfer || []).slice(-39),{...item,kind:'cross-project transfer'}];
  const stamps=(profile.episodes || []).map(entry=>Date.parse(entry.endedAt || entry.startedAt || '')).filter(Number.isFinite).sort((a,b)=>a-b);
  const gaps=stamps.slice(1).map((stamp,index)=>stamp-stamps[index]).filter(gap=>gap>0).sort((a,b)=>a-b);
  const personalDelay=gaps.length ? gaps[Math.floor(gaps.length/2)] : null;
  if (personalDelay !== null && elapsed>=personalDelay) profile.retention=[...(profile.retention || []).slice(-39),{...item,kind:'delayed successful reuse',elapsedMs:elapsed,score:1,due:null}];
  profile.milestone={label:'Independent successful reuse',progress:(profile.milestone?.progress || 0)+1,total:Math.max(profile.milestone?.total || 1,(profile.milestone?.progress || 0)+1)};
}
function scheduleOutcomeProfileRefresh(context) {
  clearTimeout(profileRefreshTimer);
  profileRefreshTimer=setTimeout(async ()=>{
    await refreshProfessionalProfile(context,{quiet:true});
    await refreshLearningModel(context);
    dashboardRender?.();
  },2500);
}
function analyzeOutcome(context, outcome, language='text', source='IDE') {
  const work=async () => {
    const config=vscode.workspace.getConfiguration('hypotrace'); const url=String(config.get('backendUrl','')).replace(/\/$/,'');
    if(!url || !getProfile(context).active) return;
    try {
      const result=await postBackend(`${url}/v1/outcome`,{user_id:backendUserId(config),language,outcome:String(outcome).slice(0,9000)});
      if(result.state !== 'failure_present' || !result.category || (result.confidence || 0) < .60) return;
      record(context,{type:'DIAGNOSTIC',classes:[result.category],severity:['Error'],source,label:result.label,outcome:'failure'});
    } catch (_) {}
  };
  outcomeQueue=outcomeQueue.then(work,work); return outcomeQueue;
}
async function recordSuccessfulOutcome(context, source='normal run') {
  const editor=vscode.window.activeTextEditor;
  const uri=editor?.document?.uri?.toString(); const finding=uri && activeAiFindings.get(uri);
  if (!finding) {
    const p=getProfile(context); updateRunEvidence(p,workspaceAssessmentKey(),{runs:(p.runEvidence?.[workspaceAssessmentKey()]?.runs || 0)+1,outcome:'pass'}); await save(context,p);
    record(context,{type:'RUN_OR_SAVE',category:'normal-run',outcome:'pass',source});
    return;
  }
  activeAiFindings.delete(uri);
  record(context,{type:'RECOVERY',classes:[finding.category],label:finding.label,outcome:'recovery',source});
}
function installShellExecutionObserver(context) {
  if (!vscode.window.onDidStartTerminalShellExecution || !vscode.window.onDidEndTerminalShellExecution) return false;
  const executions=new Map(); const integratedTerminalIds=new Set();
  const noteIntegration = terminal => {
    if (!terminal) return;
    integratedTerminalIds.add(terminal);
    const p=getProfile(context); const current=p.observability || {};
    p.observability={...current,shellIntegratedTerminals:integratedTerminalIds.size}; save(context,p);
  };
  context.subscriptions.push(vscode.window.onDidChangeTerminalShellIntegration(event => noteIntegration(event.terminal)));
  for (const terminal of vscode.window.terminals) if (terminal.shellIntegration) noteIntegration(terminal);
  context.subscriptions.push(vscode.window.onDidStartTerminalShellExecution(event => {
    if (!getProfile(context).active) return;
    noteIntegration(event.terminal);
    let output='';
    const readPromise=(async () => {
      try {
        for await (const chunk of event.execution.read()) output=(output+chunk).slice(-12000);
      } catch (_) {}
    })();
    executions.set(event.execution,{readPromise,getOutput:()=>output});
  }));
  context.subscriptions.push(vscode.window.onDidEndTerminalShellExecution(async event => {
    const observed=executions.get(event.execution); executions.delete(event.execution);
    if (!observed || !getProfile(context).active) return;
    await observed.readPromise;
    const p=getProfile(context); const status=p.observability || {};
    p.observability={...status,terminalCommands:(status.terminalCommands || 0)+1,lastOutcome:event.exitCode === 0?'pass':'failure'}; save(context,p);
    if (event.exitCode && event.exitCode !== 0) {
      await analyzeOutcome(context,observed.getOutput(),'terminal','VS Code shell integration');
    } else if (event.exitCode === 0) {
      await recordSuccessfulOutcome(context,'VS Code shell integration');
    }
  }));
  return true;
}
function classifyTask(task) {
  const label = String(task?.name || task?.definition?.label || '').toLowerCase();
  if (label.includes('syntax')) return 'syntax';
  if (label.includes('boundary')) return 'boundary';
  if (label.includes('algorithm')) return 'logic';
  return 'logic';
}
function inspectionEpisode(kind, result) {
  return {id:`E-${Date.now()}`,kind,workspaceId:workspaceAssessmentKey(),trace:`episode_kind: ${kind}; semantic_pattern: ${result.category}; decision: ${result.decision}; confidence: ${Math.round((result.confidence || 0)*100)}%`,categories:[result.category],label:result.label,features:[0,0,kind==='diagnostic'?1:0,0,0,0,0]};
}
async function inspectCurrentCode(context, document) {
  const profile=getProfile(context); const config=vscode.workspace.getConfiguration('hypotrace');
  if (!profile.active || isPrivate(document) || !config.get('aiCodeAnalysis',true) || !document.getText().trim()) return;
  const editor=vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== document.uri.toString()) return;
  const uri=document.uri.toString(); const line=editor.selection.active.line;
  try {
    const url=String(config.get('backendUrl','')).replace(/\/$/,''); if (!url) return;
    const result=await postBackend(`${url}/v1/inspect`,{user_id:backendUserId(config),language:document.languageId,cursor_line:line,code:document.getText().slice(0,16000)});
    const p=getProfile(context); const observation=p.observability || {};
    p.observability={...observation,aiInspections:(observation.aiInspections || 0)+1,lastBackend:result.backend === 'openai'?'AI inspection complete':String(result.backend || 'inspection unavailable')}; await save(context,p);
    if (result.state === 'clear') {
      return;
    }
    if (!result.category || (result.confidence || 0) < .60) return;
    const decisionKey=`${result.category}|${uri}|${line}`;
    if (result.state === 'failure_present') {
      return;
    }
    activeAiFindings.set(uri,{category:result.category,label:result.label,decisionKey});
    await syncEpisodeToBackend(context,{...inspectionEpisode('opportunity',result),decisionKeys:{[result.category]:decisionKey}});
  } catch (_) {}
}
function scheduleAiInspection(context, document) {
  const key=document.uri.toString(); clearTimeout(inspectionTimers.get(key));
  inspectionTimers.set(key,setTimeout(()=>inspectCurrentCode(context,document),1200));
}
function updateStatus(context, p) {
  const score = risk(p); const bar = context._hypotraceStatus;
  if (!bar) return;
  const label = score >= .85 ? 'high' : score >= .70 ? 'rising' : score >= .55 ? 'watch' : 'low';
  bar.text = `$(pulse) HypoTrace: ${label} ${Math.round(score*100)}%`;
  bar.tooltip = `Reasoning-failure recurrence risk. ${p.ghostMode ? 'Ghost Mode is recording silently.' : 'Run a 15-second probe if you want a check.'}`;
  bar.color = score >= .85 ? new vscode.ThemeColor('statusBarItem.errorForeground') : undefined;
  bar.show();
}
function showLearningStatus(context) {
  const p=getProfile(context); const counts={};
  for (const event of p.events.filter(e=>e.type==='DIAGNOSTIC')) for (const kind of event.classes || []) counts[kind]=(counts[kind]||0)+1;
  const learned=p.signatures.filter(s=>!s.suppressed).map(s=>s.name).join(', ') || 'none yet';
  const observer=p.observability || {}; const ready=vscode.window.terminals.filter(t=>t.shellIntegration).length;
  vscode.window.showInformationMessage(`HypoTrace live status — session: ${p.active?'on':'off'}; terminal observer: ${observer.terminalCommands || 0} completed commands captured (${ready} shell-integrated terminal${ready===1?'':'s'} now); observed failures: ${Object.entries(counts).map(([k,n])=>`${k} ${n}`).join(', ') || 'none'}; learned signatures: ${learned}.`);
}
async function runActiveFileObserved(context) {
  const editor=vscode.window.activeTextEditor; const p=getProfile(context);
  if (!p.active) return vscode.window.showInformationMessage('Start a HypoTrace session first.');
  if (!editor || editor.document.languageId!=='python' || editor.document.isUntitled) return vscode.window.showWarningMessage('Open and save a Python file before using HypoTrace Run Observed File.');
  await editor.document.save();
  const file=editor.document.uri.fsPath;
  await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'HypoTrace: running current Python file…'}, () => new Promise(resolve => {
    const child=spawn('python3',[file],{cwd:path.dirname(file),shell:false}); let transcript='';
    const collect=data => { transcript=(transcript+String(data)).slice(-12000); };
    child.stdout.on('data',collect); child.stderr.on('data',collect);
    child.on('error',async error => { await analyzeOutcome(context,error.message,'python','observed runner'); vscode.window.showErrorMessage(`HypoTrace could not run Python: ${error.message}`); resolve(); });
    child.on('close',async code => { if(code===0) await recordSuccessfulOutcome(context,'observed runner'); else await analyzeOutcome(context,transcript,'python','observed runner'); vscode.window.showInformationMessage(code===0 ? 'HypoTrace observed a successful run.' : 'HypoTrace analyzed the runtime outcome.'); resolve(); });
  }));
}
async function showForecastAlert(context, p, signature, decisionKey) {
  const enabled = vscode.workspace.getConfiguration('hypotrace').get('liveWarnings', true);
  const alerted=p.alertedDecisionKeys || {}; const alreadyWarned=decisionKey && alerted[decisionKey];
  const currentPatternCount=p.runEvidence?.[workspaceAssessmentKey()]?.patterns?.[signature.sector] || 0;
  const score=risk(p);
  const stillRecurring=currentPatternCount>(signature.recoveries || 0);
  if (!enabled || p.ghostMode || signature.suppressed || !stillRecurring || score<=0 || p.interventionBudget < 1 || p.alertOpen || alreadyWarned) return;
  p.alertOpen = true; p.alertedDecisionKeys={...alerted,[decisionKey || signature.id]:Date.now()}; await save(context,p);
  const choice = await vscode.window.showWarningMessage(
    `HypoTrace reminder: ${signature.name}. Based on ${signature.recurrence || 2} similar run failures; check this decision before you run.`,
    'Quick check', 'Why this reminder?');
  const fresh = getProfile(context); fresh.alertOpen = false; await save(context,fresh);
  if (choice === 'Quick check') await offerProbe(context);
  if (choice === 'Why this reminder?') openDashboard(context);
}
function showLearningReview(context, category, hypotheses) {
  if (!hypotheses?.length) return;
  const esc=value=>String(value || '').replace(/[&<>]/g, char=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]));
  const cards=hypotheses.map((item,index)=>`<article><h2>Possible reason ${index+1}</h2><p>${esc(item.statement)}</p><h3>What HypoTrace will watch for next</h3><p>${esc(item.prediction)}</p><h3>A small check that may help</h3><p>${esc(item.probe)}</p><h3>Agent B's caution</h3><p>${item.state==='supported'?'This matches the evidence so far, but it is not proven.':item.state==='contested'?'This is possible, but there is evidence against it too.':'There is not enough evidence to choose this explanation yet.'}${item.counterevidence?.[0] ? ` ${esc(item.counterevidence[0])}` : ''}</p></article>`).join('');
  const panel=vscode.window.createWebviewPanel('hypotraceLearningReview','HypoTrace: What I learned',vscode.ViewColumn.Beside,{});
  panel.webview.html=`<!doctype html><style>body{font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55;padding:24px;max-width:840px;color:var(--vscode-foreground)}h1,h2{font-family:Georgia,serif}article{border:1px solid var(--vscode-panel-border);border-radius:12px;padding:16px;margin:14px 0;background:var(--vscode-editor-background)}h3{font-size:13px;margin:16px 0 2px;color:var(--vscode-textLink-foreground)}</style><h1>What HypoTrace is learning</h1><p>These are two possible explanations for a repeated <b>${esc(category)}</b> pattern. They are not facts about you. Agent B actively looks for reasons each explanation could be wrong.</p>${cards}<p><small>Only privacy-filtered event summaries and outcomes were used. No source code is stored in your learning record.</small></p>`;
}
function showLatestLearningReview(context) {
  const currentWorkspace=workspaceAssessmentKey();
  const reviews=(getProfile(context).hypotheses || []).filter(item=>item.workspaceId === currentWorkspace);
  const latest=last(reviews);
  if (!latest) return vscode.window.showInformationMessage('No learning insight exists for this project yet. HypoTrace needs two comparable real failures from this workspace; opening files and unrelated failures do not count.');
  const group=reviews.filter(item=>item.category === latest.category).slice(-2);
  showLearningReview(context,latest.category || 'personal pattern',group.length ? group : [latest]);
}
function buildLearningRecords(p, trigger) {
  const diagnostic=trigger?.type==='DIAGNOSTIC'; const recovery=trigger?.type==='RECOVERY';
  const opportunity=Array.isArray(trigger?.forecastClasses) && trigger.forecastClasses.length>0;
  if (!diagnostic && !recovery && !opportunity) return null;
  const workspaceId=workspaceAssessmentKey(); const end=Date.now();
  const recent=p.events.filter(event=>event.workspaceId===workspaceId && end-Date.parse(event.at || now())<=5*60*1000).slice(-60);
  const events=recent.length ? recent : p.events.slice(-24); const counts=type=>events.filter(x=>x.type===type).length;
  const types=events.map(x=>x.type); const diagnostics=events.filter(x=>x.type==='DIAGNOSTIC').flatMap(x=>x.classes||[]);
  const rewrites=events.filter(x=>x.type==='EDIT_BURST' && x.charsDelta<0).length;
  const vector=[counts('EDIT_BURST'),counts('NAVIGATION'),counts('DIAGNOSTIC'),counts('RUN_OR_SAVE'),counts('DEBUG_STEP'),rewrites,counts('REASON_NOTE')];
  const categories=[...new Set(diagnostic || recovery ? (trigger.classes || []) : trigger.forecastClasses)];
  const kind=diagnostic?'diagnostic':recovery?'recovery':'opportunity'; const startedAt=events[0]?.at || now();
  const duration=Math.max(0,Math.round((end-Date.parse(startedAt))/1000));
  const trace=`record_kind: ${kind}; active_window_seconds: ${duration}; sequence: ${types.join(' → ')}; edit_bursts: ${vector[0]}; rewrites: ${rewrites}; navigation: ${vector[1]}; debug_steps: ${vector[4]}; diagnostics: [${diagnostics.join(',')}]; categories: [${categories.join(',')}]; reason_note_seen: ${vector[6]>0}`;
  const base={id:`O-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,kind,trace,categories,label:trigger.label,decisionKeys:trigger.decisionKeys || {},outcome:diagnostic?'failure':recovery?'recovery':'forecast-opportunity',workspaceId,startedAt,endedAt:now(),durationSeconds:duration,features:{vector,editBursts:vector[0],rewrites,navigation:vector[1],debugSteps:vector[4],constraintCheck:vector[6]>0,eventCount:events.length}};
  if (opportunity) return {observation:base,episode:null};
  const sessions=p.openSessions || {}; const session=sessions[workspaceId] || {startedAt,eventCountAtStart:Math.max(0,p.events.length-events.length),outcomes:[]};
  session.outcomes=[...(session.outcomes || []),{kind,categories,at:now()}].slice(-8); session.lastAt=now(); sessions[workspaceId]=session; p.openSessions=sessions;
  const meaningfulActions=vector[0]+vector[1]+vector[4]+vector[6];
  const mature=(duration>=120 && meaningfulActions>=4 && session.outcomes.length>=2) || (duration>=300 && meaningfulActions>=3);
  if (!mature) return {observation:base,episode:null};
  const episode={...base,id:`E-${Date.now()}`,kind:'learning-session',trace:`episode_kind: learning-session; session_start: ${startedAt}; session_end: ${now()}; duration_seconds: ${duration}; completed_outcomes: ${session.outcomes.length}; ${trace}`,outcome:'completed-session'};
  p.episodes.push(episode); p.episodes=p.episodes.slice(-80); p.sessions=[...(p.sessions || []).slice(-79),{id:episode.id,workspaceId,kind:'learning-session',durationSeconds:duration,eventCount:events.length,outcome:'completed-session',at:episode.endedAt}]; delete p.openSessions[workspaceId];
  return {observation:base,episode};
}
async function syncEpisodeToBackend(context, episode, route='/v1/observations') {
  const config=vscode.workspace.getConfiguration('hypotrace'); const url=String(config.get('backendUrl','')).replace(/\/$/,'');
  if (!url || !episode) return;
  try {
    const response=await postBackend(`${url}${route}`,{user_id:backendUserId(config),episode:{id:episode.id,kind:episode.kind,workspace_id:backendWorkspaceId(),trace:episode.trace,categories:episode.categories || [],label:episode.label,features:episode.features?.vector || episode.features || [],started_at:episode.startedAt,ended_at:episode.endedAt,duration_seconds:episode.durationSeconds,outcome:episode.outcome}});
    const p=getProfile(context);
    const observation=p.observability || {};
    p.observability={...observation,backendEpisodes:(observation.backendEpisodes || 0)+1,lastBackend:'episode acknowledged'};
    for (const learned of response.signatures || []) {
      let signature=p.signatures.find(s=>s.id===`FS-${learned.category}`);
      if (!signature) { signature={id:`FS-${learned.category}`,name:learned.name,sector:learned.category,recurrence:0,trend:'candidate',contexts:['backend similarity retrieval'],risk:0}; p.signatures.push(signature); }
      signature.name=learned.name || signature.name; signature.recurrence=learned.count||0; signature.recoveries=learned.recoveries||0; signature.risk=learned.risk ?? signature.risk; signature.lastSeenAt=now(); signature.evidence=learned.evidence || signature.evidence || {};
      signature.trend=learned.learned?'recurring':(signature.recoveries >= 2 ? 'improving' : 'candidate'); signature.suppressed=signature.recoveries >= 2 && !learned.learned;
      for (const [index,h] of (learned.hypotheses || []).entries()) {
        const id=`B-${learned.category}-${index}`;
        const review={id,category:learned.category,workspaceId:episode.workspaceId || workspaceAssessmentKey(),state:h.state || 'insufficient_evidence',statement:h.statement,prediction:h.prediction,probe:h.probe,evidence:h.evidence || [`${learned.count} similar outcomes for this developer`],counterevidence:h.counterevidence || [],updatedAt:now(),discriminatingTest:h.discriminating_test || '',evidenceSessionCount:h.evidence_session_count || learned.evidence?.full_sessions || 0,reviewVersion:h.review_version || learned.evidence?.review_version || 0,evidenceSummary:h.evidence_summary || ''};
        const existing=p.hypotheses.findIndex(x=>x.id===id);
        if (existing === -1) { p.hypotheses.push(review); }
        else p.hypotheses[existing]={...p.hypotheses[existing],...review};
      }
    }
    let createdForecast=null;
    if(response.forecast && episode.kind==='opportunity') {
      const category=response.forecast.category;
      let forecast={probability:response.forecast.risk,calibration:null};
      try { forecast=await postBackend(`${url}/v1/forecasts`,{user_id:backendUserId(config),workspace_id:backendWorkspaceId(),category,decision_context:String(episode.decisionKeys?.[category] || '').slice(0,180)}); } catch (_) {}
      const existing=p.predictions.find(item=>item.realized===null && item.category===category && item.decisionKey===episode.decisionKeys?.[category]);
      if (!existing && !forecast.error) p.predictions=[...(p.predictions || []).slice(-39),{id:forecast.id || `P-${Date.now()}`,at:now(),workspaceId:episode.workspaceId || workspaceAssessmentKey(),category,signature:`FS-${category}`,decisionKey:episode.decisionKeys?.[category],probability:forecast.probability,calibration:forecast.calibration,mode:p.ghostMode?'silent evaluation':'shown reminder',realized:null,outcome:'waiting for the next matching run'}];
      createdForecast=forecast;
    }
    await save(context,p);
    if (episode.kind === 'diagnostic' || episode.kind === 'recovery') scheduleOutcomeProfileRefresh(context);
    if(response.forecast && episode.kind==='opportunity') showForecastAlert(context,p,p.signatures.find(s=>s.id===`FS-${response.forecast.category}`) || {id:`FS-${response.forecast.category}`,name:response.forecast.name,sector:response.forecast.category,risk:createdForecast?.probability ?? response.forecast.risk},episode.decisionKeys?.[response.forecast.category]);
  } catch (_) {}
}
async function hydrateSavedBackendReviews(context) {
  const config=vscode.workspace.getConfiguration('hypotrace'); const url=String(config.get('backendUrl','')).replace(/\/$/,'');
  if (!url) return false;
  try {
    const response=await postBackend(`${url}/v1/learning-state`,{user_id:backendUserId(config)});
    const p=getProfile(context); let changed=false;
    for (const learned of response.signatures || []) {
      for (const [index,h] of (learned.hypotheses || []).entries()) {
        const id=`B-${learned.category}-${index}`;
        const review={id,category:learned.category,workspaceId:workspaceAssessmentKey(),state:h.state || 'insufficient_evidence',statement:h.statement,prediction:h.prediction,probe:h.probe,evidence:h.evidence || [`${learned.count} similar outcomes for this developer`],counterevidence:h.counterevidence || [],updatedAt:now(),discriminatingTest:h.discriminating_test || '',evidenceSessionCount:h.evidence_session_count || 0,reviewVersion:h.review_version || 1,evidenceSummary:h.evidence_summary || ''};
        const existing=p.hypotheses.findIndex(x=>x.id===id);
        if (existing===-1) p.hypotheses.push(review); else p.hypotheses[existing]={...p.hypotheses[existing],...review};
        changed=true;
      }
    }
    if (changed) await save(context,p);
    return changed;
  } catch (_) { return false; }
}
function record(context, event) {
  const p = getProfile(context); if (!p.active) return;
  const workspaceId=workspaceAssessmentKey();
  p.events.push({ id: `EV-${Date.now()}`, at: now(), workspaceId, ...event });
  p.events = p.events.slice(-120);
  const records = buildLearningRecords(p,event);
  const score = risk(p);
  if (event.type === 'DIAGNOSTIC') {
    updateRunEvidence(p,workspaceId,{runs:(p.runEvidence?.[workspaceId]?.runs || 0)+1,failures:(p.runEvidence?.[workspaceId]?.failures || 0)+1,category:event.classes?.[0],outcome:'failure'});
    const open = [...p.predictions].reverse().find(x => x.realized === null && x.category === event.classes?.[0] && x.workspaceId === workspaceId);
    if (open) { resolveForecast(p,workspaceId,event.classes?.[0],true,'recurred during a matching run'); p.lastOutcome = 'recurrence'; }
    persistForecastOutcome(context,event.classes?.[0],true);
    updateAdaptiveRisk(p,true);
  }
  if (event.type === 'RECOVERY') {
    const category=event.classes?.[0];
    updateRunEvidence(p,workspaceId,{runs:(p.runEvidence?.[workspaceId]?.runs || 0)+1,recoveries:(p.runEvidence?.[workspaceId]?.recoveries || 0)+1,category,outcome:'recovery',increment:0});
    resolveForecast(p,workspaceId,category,false,'not observed after a matching successful run'); persistForecastOutcome(context,category,false);
    updateAdaptiveRisk(p,false);
    recordLearningOutcomes(p,workspaceId,category);
  }
  save(context, p);
  if (records?.observation) syncEpisodeToBackend(context,records.observation,'/v1/observations');
  if (records?.episode) syncEpisodeToBackend(context,records.episode,'/v1/episodes');
  updateStatus(context,p);
  vscode.commands.executeCommand('setContext', 'hypotrace.risk', score >= .7);
}

function workspaceAssessmentKey() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.toString() || '';
}
function backendWorkspaceId() {
  const value=workspaceAssessmentKey();
  return value ? crypto.createHash('sha256').update(value).digest('hex').slice(0,32) : '';
}
function sourceLanguage(file) {
  const ext=path.extname(file).toLowerCase();
  return ({'.py':'python','.js':'javascript','.ts':'typescript','.tsx':'typescript-react','.jsx':'javascript-react','.cpp':'cpp','.cc':'cpp','.cxx':'cpp','.c':'c','.h':'c','.hpp':'cpp','.java':'java','.go':'go','.rs':'rust'})[ext] || '';
}
async function collectWorkspaceSource() {
  const include='**/*.{py,js,ts,tsx,jsx,cpp,cc,cxx,c,h,hpp,java,go,rs}';
  const exclude='**/{.git,node_modules,venv,.venv,__pycache__,dist,build,.next,target,vendor}/**';
  const uris=await vscode.workspace.findFiles(include,exclude,10); const files=[];
  for (const uri of uris) {
    if (isPrivate({uri})) continue;
    try { const stat=await vscode.workspace.fs.stat(uri); if(stat.size > 50000) continue; const content=Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); if(content.trim()) files.push({language:sourceLanguage(uri.fsPath),content:content.slice(0,2500)}); }
    catch (_) {}
  }
  return files;
}
async function assessWorkspace(context, {quiet=false}={}) {
  const key=workspaceAssessmentKey(); const config=vscode.workspace.getConfiguration('hypotrace');
  if (!key || !config.get('aiCodeAnalysis',true)) return null;
  const files=await collectWorkspaceSource(); if (!files.length) return null;
  const url=String(config.get('backendUrl','')).replace(/\/$/,''); if(!url) return null;
  try {
    const result=await postBackend(`${url}/v1/project-assessment`,{user_id:backendUserId(config),files});
    if(result.error) throw new Error(result.error);
    const p=getProfile(context); const prior=p.projectAssessments[key] || {history:[]};
    const counts=Object.fromEntries((result.findings || []).map(x=>[x.category,x.count]));
    const snapshot={at:now(),qualityScore:result.quality_score,counts};
    p.projectAssessments[key]={name:vscode.workspace.workspaceFolders?.[0]?.name || 'Current project',summary:result.summary,qualityScore:result.quality_score,findings:result.findings || [],strengths:result.strengths || [],nextFocus:result.next_focus,scannedFiles:files.length,updatedAt:now(),history:[...(prior.history || []).slice(-11),snapshot]};
    const observation=p.observability || {}; p.observability={...observation,lastBackend:'project AI assessment complete'}; await save(context,p);
    if(!quiet) vscode.window.showInformationMessage(`HypoTrace assessed ${files.length} source files. The current-project dashboard is updated.`);
    return p.projectAssessments[key];
  } catch(error) { if(!quiet) vscode.window.showWarningMessage(`HypoTrace project assessment could not run: ${error.message}`); return null; }
}
async function refreshProfessionalProfile(context, {quiet=false}={}) {
  const config=vscode.workspace.getConfiguration('hypotrace'); const url=String(config.get('backendUrl','')).replace(/\/$/,'');
  const profile=getProfile(context); const assessments=Object.values(profile.projectAssessments || {}).map(item=>({
    quality_score:item.qualityScore, findings:(item.findings || []).map(f=>({category:f.category,label:f.label,severity:f.severity,count:f.count})),
    strengths:item.strengths || [], next_focus:item.nextFocus || '', history:(item.history || []).slice(-8)
  }));
  const outcomes=(profile.signatures || []).map(item=>({category:item.id || item.category,name:item.name,failures:item.recurrence || item.count || 0,recoveries:item.recoveries || 0,risk:item.risk || 0}));
  if(!url || (!assessments.length && !outcomes.length)) return null;
  try {
    const result=await postBackend(`${url}/v1/professional-profile`,{user_id:backendUserId(config),assessments,outcomes});
    if(result.error) throw new Error(result.error);
    const prior=profile.professionalProfile || {history:[]};
    const snapshot={at:now(),readinessScore:result.readiness_score,dimensions:result.dimensions || []};
    profile.professionalProfile={readinessScore:result.readiness_score,summary:result.summary || '',dimensions:result.dimensions || [],strengths:result.strengths || [],nextFocus:result.next_focus || '',updatedAt:now(),history:[...(prior.history || []).slice(-11),snapshot]};
    profile.observability={...(profile.observability || {}),lastBackend:'professional AI profile complete'}; await save(context,profile);
    if(!quiet) vscode.window.showInformationMessage('HypoTrace refreshed your all-time professional growth profile.');
    return profile.professionalProfile;
  } catch(error) { if(!quiet) vscode.window.showWarningMessage(`HypoTrace professional profile could not run: ${error.message}`); return null; }
}
async function refreshLearningModel(context) {
  const config=vscode.workspace.getConfiguration('hypotrace'); const url=String(config.get('backendUrl','')).replace(/\/$/,'');
  if (!url) return null;
  try {
    const result=await postBackend(`${url}/v1/learning-model`,{user_id:backendUserId(config)});
    if (result.error) return null;
    const profile=getProfile(context); profile.learningModel={...result,updatedAt:now()}; await save(context,profile);
    return profile.learningModel;
  } catch (_) { return null; }
}
function assessmentData(profile) {
  const workspaceId=workspaceAssessmentKey();
  const storedProject=profile.projectAssessments?.[workspaceId] || null;
  const runEvidence=profile.runEvidence?.[workspaceId] || {runs:0,failures:0,recoveries:0,patterns:{},patternStats:{},calibration:{total:0,matched:0,avoided:0,brierTotal:0,history:[]},history:[]};
  const project=storedProject
    ? {...storedProject,sourceAssessed:true,runEvidence}
    : {name:vscode.workspace.workspaceFolders?.[0]?.name || 'Current project',sourceAssessed:false,qualityScore:null,findings:[],strengths:[],nextFocus:'Run code normally; the source assessment is still being prepared.',scannedFiles:0,updatedAt:null,history:[],runEvidence};
  const global={};
  const projects=Object.values(profile.projectAssessments || {}).map(project => ({name:project.name,qualityScore:project.qualityScore,scannedFiles:project.scannedFiles,updatedAt:project.updatedAt,findings:project.findings || [],history:project.history || []}));
  for(const assessment of projects) for(const finding of assessment.findings) global[finding.label]=(global[finding.label] || 0) + (finding.count || 0);
  for(const signature of profile.signatures) global[signature.name || signature.id]=(global[signature.name || signature.id] || 0) + (signature.recurrence || 0);
  for(const event of profile.events.filter(e=>e.type==='DIAGNOSTIC')) for(const category of event.classes || []) global[titleCase(category)]=(global[titleCase(category)] || 0)+1;
  const learning=(profile.hypotheses || []).slice(-4).map(item => ({
    category:item.category || 'personal pattern', state:item.state || 'insufficient_evidence',
    statement:item.statement || 'HypoTrace is still comparing possible explanations.',
    prediction:item.prediction || 'More similar outcomes are needed.', probe:item.probe || 'No small check is ready yet.',
    counterevidence:item.counterevidence || []
  }));
  const calibration=runEvidence.calibration || {total:0,matched:0,avoided:0,brierTotal:0,history:[]};
  const calibrationScore=calibration.total ? clamp(1-(calibration.brierTotal / calibration.total)) : null;
  const projectPatterns=Object.entries(runEvidence.patterns || {}).map(([category,count])=>{
    const signature=(profile.signatures || []).find(item=>item.id===`FS-${category}` || item.sector===category);
    const stat=runEvidence.patternStats?.[category] || {failures:count,recoveries:0,lastFailureAt:null,lastRecoveryAt:null};
    const recovered=stat.recoveries || 0;
    const lastSeen=stat.lastFailureAt || signature?.lastSeenAt || null;
    const ageDays=lastSeen ? Math.max(0,(Date.now()-Date.parse(lastSeen))/86400000) : null;
    const personalCalibration=runEvidence.serverCalibration?.[category] || null;
    const confidence=personalCalibration?.probability ?? signature?.risk ?? risk(profile);
    const state=!count ? 'watching' : recovered >= count ? 'repaired' : recovered > 0 ? 'improving' : count > 1 ? 'repeating' : 'watching';
    const confidenceHistory=(calibration.history || []).filter(item=>item.category===category).slice(-8);
    return {category,label:signature?.name || titleCase(category),count,recoveries:recovered,risk:signature?.risk || 0,confidence,state,lastSeenAt:lastSeen,ageDays,confidenceHistory,calibration:personalCalibration};
  }).sort((a,b)=>(b.risk-a.risk) || (b.count-a.count));
  const projectHypotheses=(profile.hypotheses || []).filter(item=>item.workspaceId===workspaceId).slice(-8);
  const projectPredictions=(profile.predictions || []).filter(item=>item.workspaceId===workspaceId).slice(-20);
  const graphNodes=[{id:'workspace',label:'This project',kind:'evidence',state:'current workspace'}]; const graphEdges=[];
  for(const pattern of projectPatterns) { const id=`signature:${pattern.category}`; graphNodes.push({id,label:pattern.label,kind:'pattern',state:pattern.state}); graphEdges.push({from:'workspace',to:id,label:'observed in'}); }
  const episodeGroups=new Map();
  for(const episode of (profile.episodes || []).filter(item=>item.workspaceId===workspaceId).slice(-24)) {
    const categories=(episode.categories || []).slice().sort().join('|') || 'other';
    const key=`${episode.kind || 'outcome'}:${categories}`;
    const group=episodeGroups.get(key) || {id:`episode-group:${key}`,kind:'evidence',sessionKind:episode.kind || 'outcome',categories:categories.split('|'),count:0,seconds:0,state:episode.outcome || 'observed'};
    group.count++; group.seconds+=Number(episode.durationSeconds || 0); group.state=episode.outcome || group.state;
    episodeGroups.set(key,group);
  }
  for(const group of episodeGroups.values()) {
    const outcome=group.sessionKind==='diagnostic'?'failed run':group.sessionKind==='recovery'?'successful follow-up':'completed run';
    const activity=group.seconds>0?` · ${Math.round(group.seconds)}s of captured activity`: ' · quick run outcome';
    graphNodes.push({id:group.id,label:`${group.count} ${outcome}${group.count===1?'':'s'}${activity}`,kind:'evidence',state:group.state});
    for(const category of group.categories) if(category && category!=='other') graphEdges.push({from:group.id,to:`signature:${category}`,label:'supports'});
  }
  for(const hypothesis of projectHypotheses) { const id=`hypothesis:${hypothesis.id}`; graphNodes.push({id,label:hypothesis.statement,kind:'hypothesis',state:hypothesis.state}); graphEdges.push({from:`signature:${hypothesis.category}`,to:id,label:'suggests'}); if((hypothesis.counterevidence||[]).length) graphEdges.push({from:id,to:`signature:${hypothesis.category}`,label:'challenged by'}); }
  for(const prediction of projectPredictions.slice(-8)) { const id=`prediction:${prediction.id}`; graphNodes.push({id,label:`${Math.round((prediction.probability||0)*100)}% future risk`,kind:'prediction',state:prediction.outcome||'waiting for outcome'}); graphEdges.push({from:`signature:${prediction.category}`,to:id,label:'predicts'}); }
  for(const experiment of (profile.experiments || []).filter(item=>item.signature?.replace(/^FS-/,'') && projectPatterns.some(pattern=>pattern.category===item.category || `FS-${pattern.category}`===item.signature)).slice(-8)) { const id=`intervention:${experiment.id}`; graphNodes.push({id,label:experiment.intervention,kind:'intervention',state:experiment.outcome}); const category=experiment.category || String(experiment.signature).replace(/^FS-/,''); graphEdges.push({from:id,to:`signature:${category}`,label:experiment.outcome?.includes('recovered')?'helped by':'tested against'}); }
  const totalRuns=Object.values(profile.runEvidence || {}).reduce((total,item)=>total+(item.runs || 0),0);
  return {global:Object.entries(global).map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value).slice(0,8),professional:profile.professionalProfile || null,learningModel:profile.learningModel || null,project,learning,freshStart:profile.freshStartAt && totalRuns===0 ? profile.freshStartAt : null,graph:{nodes:graphNodes,edges:graphEdges},forecast:{patterns:projectPatterns,hypotheses:projectHypotheses,predictions:projectPredictions,calibration:{...calibration,score:calibrationScore},adaptiveRisk:{score:risk(profile),updates:profile.adaptiveRisk?.updates || 0,history:profile.adaptiveRisk?.history || []},transfer:(profile.transfer || []).filter(item=>item.toWorkspace===workspaceId).slice(-12),retention:(profile.retention || []).filter(item=>item.toWorkspace===workspaceId).slice(-12)}};
}

function modernDashboardHtml(profile) {
  const data=JSON.stringify(assessmentData(profile)).replace(/</g,'\\u003c');
  const fontCss=`@import url('https://fonts.googleapis.com/css2?family=Petrona:wght@400;500;600;700&display=swap');body{font-family:"Williwaw","Avenir Next","Segoe UI",sans-serif;letter-spacing:.015em}.hero,.card{background:color-mix(in srgb,var(--vscode-editor-background) 62%,transparent)}h1,h2,h3,.metric{font-family:"Petrona",Georgia,serif;font-weight:700}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}
  :root{--ink:var(--vscode-foreground);--muted:color-mix(in srgb,var(--ink) 62%,transparent);--glass:color-mix(in srgb,var(--vscode-editor-background) 72%,transparent);--edge:color-mix(in srgb,var(--vscode-focusBorder) 48%,transparent);--blue:#64b5ff;--violet:#a88bff;--mint:#57d2ae;--amber:#f3c969}*{box-sizing:border-box}body{font:13px ui-sans-serif,-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif;letter-spacing:.01em;color:var(--ink);padding:20px;max-width:1180px;margin:auto;background:linear-gradient(130deg,color-mix(in srgb,var(--vscode-editor-background) 82%,#12304a),var(--vscode-editor-background) 54%)}h1{font-size:30px;letter-spacing:-.045em;margin:0;font-weight:760}h2{font-size:19px;margin:0 0 8px;font-weight:750;letter-spacing:-.025em}h3{font-size:14px;margin:0 0 8px;font-weight:730}.sub,.muted{color:var(--muted)}.hero,.card{border:1px solid var(--edge);background:var(--glass);backdrop-filter:blur(16px);box-shadow:0 18px 45px rgba(0,0,0,.12)}.hero{border-radius:18px;padding:20px;margin-top:18px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:12px;margin:12px 0}.card{border-radius:14px;padding:16px}.metric{font-size:34px;line-height:1;font-weight:780;letter-spacing:-.055em;margin:10px 0}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--blue);font-weight:780}button{font:inherit;font-weight:720;background:color-mix(in srgb,var(--vscode-button-background) 80%,#215d92);color:var(--vscode-button-foreground);border:1px solid color-mix(in srgb,var(--vscode-button-background) 65%,white);border-radius:9px;padding:9px 13px;margin:3px;cursor:pointer;transition:transform .18s ease,filter .18s ease}button:hover{transform:translateY(-1px);filter:brightness(1.12)}button.active{outline:2px solid var(--blue)}.charts{display:grid;grid-template-columns:minmax(190px,.8fr) minmax(260px,1.4fr);gap:16px;align-items:center}.donut-wrap{text-align:center}.donut{width:164px;height:164px;margin:auto;border-radius:50%;display:grid;place-items:center;position:relative;animation:enter .55s cubic-bezier(.2,.8,.2,1)}.donut:after{content:"";width:112px;height:112px;border-radius:50%;background:var(--vscode-editor-background);border:1px solid var(--edge);position:absolute}.donut-label{z-index:1;font-size:26px;font-weight:800;letter-spacing:-.06em}.bar-row{display:grid;grid-template-columns:minmax(100px,1fr) 4fr 42px;gap:9px;align-items:center;margin:9px 0}.track{height:11px;border-radius:8px;overflow:hidden;background:color-mix(in srgb,var(--ink) 12%,transparent)}.fill{height:100%;border-radius:8px;transform-origin:left;animation:grow .75s cubic-bezier(.2,.75,.2,1) both}.trend{font-size:11px;font-weight:750;text-transform:capitalize}.trend.improving{color:var(--mint)}.trend.needs_attention{color:var(--amber)}.finding{border-left:3px solid var(--amber);padding:10px 12px;margin:8px 0;border-radius:0 8px 8px 0;background:color-mix(in srgb,var(--vscode-textBlockQuote-background) 68%,transparent)}.pill{display:inline-block;border:1px solid var(--edge);border-radius:20px;padding:4px 8px;margin:2px;font-size:11px;font-weight:650}.line{height:150px;width:100%;overflow:visible}.line polyline{stroke-dasharray:260;stroke-dashoffset:260;animation:draw 1.15s ease forwards}@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}@keyframes draw{to{stroke-dashoffset:0}}@keyframes enter{from{opacity:0;transform:scale(.82) rotate(-8deg)}to{opacity:1;transform:scale(1) rotate(0)}}@media(max-width:650px){.charts{grid-template-columns:1fr}}
  </style></head><body><h1>HypoTrace</h1><p class="sub">Personal AI growth profile · privacy-filtered coding evidence</p><section class="hero"><div class="eyebrow">Developer growth system</div><h2>Your learning overview</h2><p class="sub">Current project evaluates this workspace. All-time turns your own accumulated evidence into a professional development profile—not a workspace comparison.</p><button id="projectTab" class="active" onclick="showProject()">Current project</button><button id="profileTab" onclick="showProfile()">All-time personal profile</button><button onclick="send('scan')">Refresh current project</button><div id="view"></div></section><script>
  const vscode=acquireVsCodeApi(),data=${data};const colors=['#64b5ff','#a88bff','#57d2ae','#f3c969','#ff8e8e','#6ee7d8','#d9a7ff','#8cd17d'];function send(command){vscode.postMessage({command})}function esc(v){return String(v||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}function value(x){return x.score??x.value??x.count??0}function bars(items){if(!items.length)return '<p class="muted">No evidence supports a dimension yet.</p>';return items.map((x,i)=>'<div class="bar-row"><b>'+esc(x.label)+'</b><div class="track"><div class="fill" style="width:'+Math.max(2,Math.round(value(x)))+'%;background:'+colors[i%colors.length]+';animation-delay:'+(i*.08)+'s"></div></div><span class="trend '+esc(x.trend||'')+'">'+Math.round(value(x))+(x.score===undefined?'':'%')+'</span></div>').join('')}function donut(dimensions,score){if(!dimensions.length)return '<div class="donut" style="background:conic-gradient(var(--edge) 0 100%)"><span class="donut-label">—</span></div>';let total=Math.max(1,dimensions.reduce((n,x)=>n+Math.max(1,x.score),0)),at=0,parts=[];dimensions.forEach((x,i)=>{let end=at+Math.max(1,x.score)/total*100;parts.push(colors[i%colors.length]+' '+at+'% '+end+'%');at=end});return '<div class="donut" style="background:conic-gradient('+parts.join(',')+')"><span class="donut-label">'+Math.round(score||0)+'</span></div>'}function lineTrend(history,key,empty){if(history.length<2)return '<p class="muted">'+empty+'</p>';let v=history.map(x=>x[key]||0),lo=Math.min(...v),hi=Math.max(...v),span=Math.max(1,hi-lo),pts=v.map((n,i)=>(i*100/(v.length-1)).toFixed(1)+','+(85-(n-lo)*65/span).toFixed(1)).join(' ');return '<svg class="line" viewBox="0 0 100 100" preserveAspectRatio="none"><line x1="0" y1="90" x2="100" y2="90" stroke="currentColor" opacity=".2"/><polyline points="'+pts+'" fill="none" stroke="#64b5ff" stroke-width="2.7" vector-effect="non-scaling-stroke"/></svg>'}function showProject(){projectTab.classList.add('active');profileTab.classList.remove('active');const p=data.project;if(!p){view.innerHTML='<h2>Current project</h2><p class="muted">The first assessment is starting automatically. You can also select Refresh current project.</p>';return}let findings=p.findings||[];view.innerHTML='<div class="grid"><article class="card"><div class="eyebrow">Current workspace</div><h3>'+esc(p.name)+'</h3><div class="metric">'+Math.round(p.qualityScore||0)+'/100</div><p class="sub">AI code-health snapshot · '+p.scannedFiles+' files</p></article><article class="card"><div class="eyebrow">Next focus</div><h3>'+esc(p.nextFocus)+'</h3><p>'+((p.strengths||[]).map(x=>'<span class="pill">'+esc(x)+'</span>').join('')||'<span class="pill">Evidence is still growing</span>')+'</p></article></div><div class="grid"><article class="card"><div class="eyebrow">Issue distribution</div><h3>Current-workspace signals</h3>'+bars(findings)+'</article><article class="card"><div class="eyebrow">Progress over time</div><h3>Current-workspace trend</h3>'+lineTrend(p.history||[],'qualityScore','The trend appears after this workspace has two assessments.')+'</article></div><article class="card"><h3>AI recommendations</h3>'+findings.map((x)=>'<div class="finding"><b>'+esc(x.label)+'</b> · '+esc(x.count)+' signal'+(x.count===1?'':'s')+'<br><span class="muted">'+esc(x.suggestion)+'</span></div>').join('')+'<p class="sub">'+esc(p.summary)+'</p></article>' }function showProfile(){projectTab.classList.remove('active');profileTab.classList.add('active');const p=data.professional;if(!p){view.innerHTML='<h2>All-time personal profile</h2><p class="muted">Generating your AI growth profile from your existing private semantic evidence…</p>';send('profile');return}let d=p.dimensions||[];view.innerHTML='<div class="grid"><article class="card"><div class="eyebrow">Professional growth snapshot</div><div class="charts"><div class="donut-wrap">'+donut(d,p.readinessScore)+'<p class="sub">Readiness snapshot /100</p></div><div><h3>'+esc(p.summary)+'</h3><p><b>Next focus:</b> '+esc(p.nextFocus)+'</p><p>'+((p.strengths||[]).map(x=>'<span class="pill">'+esc(x)+'</span>').join('')||'<span class="pill">Evidence is still growing</span>')+'</p></div></div></article><article class="card"><div class="eyebrow">Capability map</div><h3>Strengths and growth areas</h3>'+bars(d)+'</article></div><div class="grid"><article class="card"><div class="eyebrow">Progress over time</div><h3>Professional-growth trend</h3>'+lineTrend(p.history||[],'readinessScore','A line trend appears after the profile has been refreshed at least twice.')+'</article><article class="card"><div class="eyebrow">Dimension evidence</div>'+d.map(x=>'<div class="finding"><b>'+esc(x.label)+'</b> <span class="trend '+esc(x.trend)+'">'+esc(x.trend)+'</span><br><span class="muted">'+esc(x.evidence)+'</span></div>').join('')+'</article></div>'}showProject()</script></section></body></html>`;
}

function modernDashboardHtmlV2(profile) {
  const data=JSON.stringify(assessmentData(profile)).replace(/</g,'\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @import url('https://fonts.googleapis.com/css2?family=Petrona:wght@400;500;600;700&display=swap');
  :root{--ink:var(--vscode-foreground);--muted:color-mix(in srgb,var(--ink) 60%,transparent);--card:color-mix(in srgb,var(--vscode-editor-background) 58%,transparent);--edge:color-mix(in srgb,var(--vscode-focusBorder) 50%,transparent);--blue:#64b5ff;--violet:#a88bff;--mint:#57d2ae;--amber:#f3c969;--red:#ff7676}*{box-sizing:border-box}body{margin:0;padding:22px;max-width:1200px;color:var(--ink);font:14px "Williwaw","Avenir Next","Segoe UI",sans-serif;letter-spacing:.015em;background:radial-gradient(circle at 80% 0,color-mix(in srgb,#2067a1 18%,transparent),transparent 38%),var(--vscode-editor-background)}h1,h2,h3,.score{font-family:"Petrona",Georgia,serif}h1{font-size:34px;letter-spacing:-.05em;margin:0;font-weight:700}h2{font-size:21px;margin:0 0 8px;font-weight:700}h3{font-size:17px;margin:0 0 8px;font-weight:700}.muted{color:var(--muted);line-height:1.45}.eyebrow{font:800 11px "Williwaw","Avenir Next",sans-serif;letter-spacing:.13em;text-transform:uppercase;color:var(--blue)}.hero,.card{border:1px solid var(--edge);background:var(--card);backdrop-filter:blur(18px);box-shadow:0 18px 52px rgba(0,0,0,.14)}.hero{border-radius:20px;padding:22px;margin-top:18px}.card{border-radius:15px;padding:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(265px,1fr));gap:13px;margin:14px 0}.score{font-size:40px;letter-spacing:-.065em;font-weight:700;margin:10px 0}button{font:700 13px "Williwaw","Avenir Next",sans-serif;background:color-mix(in srgb,var(--vscode-button-background) 80%,#1d6093);color:var(--vscode-button-foreground);border:1px solid color-mix(in srgb,var(--vscode-button-background) 65%,white);border-radius:9px;padding:10px 14px;margin:3px;cursor:pointer;transition:transform .2s ease,filter .2s ease}button:hover{transform:translateY(-2px);filter:brightness(1.12)}button.active{outline:2px solid var(--blue)}.bar-row{display:grid;grid-template-columns:minmax(122px,1.25fr) 4fr 60px;gap:10px;align-items:center;margin:12px 0}.track{height:14px;border-radius:12px;overflow:hidden;background:color-mix(in srgb,var(--ink) 12%,transparent)}.fill{height:100%;border-radius:12px;transform-origin:left;animation:rise .9s cubic-bezier(.16,.84,.25,1) both}.bar-value{font-weight:800;font-size:12px}.legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.legend span{font-size:11px;font-weight:700}.dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:4px}.chart-labels{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:-5px}.line{width:100%;height:180px;overflow:visible}.line polyline{stroke-dasharray:340;stroke-dashoffset:340;animation:draw 1.25s ease forwards}.line circle{opacity:0;animation:appear .25s ease forwards}.donut{width:170px;height:170px;border-radius:50%;margin:auto;display:grid;place-items:center;position:relative;animation:pop .6s cubic-bezier(.2,.8,.2,1)}.donut:after{content:"";position:absolute;width:112px;height:112px;border-radius:50%;background:var(--vscode-editor-background);border:1px solid var(--edge)}.donut b{z-index:1;font:700 29px "Petrona",Georgia,serif}.donut-wrap{text-align:center}.finding{border-left:4px solid var(--amber);border-radius:0 8px 8px 0;padding:10px 12px;margin:9px 0;background:color-mix(in srgb,var(--vscode-textBlockQuote-background) 70%,transparent)}.pill{display:inline-block;border:1px solid var(--edge);border-radius:20px;padding:4px 9px;margin:2px;font-size:11px;font-weight:700}.action{border:1px solid color-mix(in srgb,var(--amber) 65%,var(--edge));background:color-mix(in srgb,var(--amber) 8%,transparent);border-radius:10px;padding:12px;margin:8px 0}@keyframes rise{from{transform:scaleX(0);filter:brightness(.7)}to{transform:scaleX(1);filter:brightness(1)}}@keyframes draw{to{stroke-dashoffset:0}}@keyframes appear{to{opacity:1}}@keyframes pop{from{opacity:0;transform:scale(.75) rotate(-12deg)}to{opacity:1;transform:scale(1)}}@media(max-width:650px){body{padding:14px}.bar-row{grid-template-columns:105px 1fr 45px}}
  .tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;max-width:720px;padding:5px;margin:18px 0 16px;border:1px solid color-mix(in srgb,var(--edge) 75%,transparent);border-radius:999px;background:color-mix(in srgb,#17213d 76%,var(--vscode-editor-background));box-shadow:inset 0 1px rgba(255,255,255,.08)}.tabs button{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin:0;padding:12px 14px;border:0;border-radius:999px;background:transparent;color:color-mix(in srgb,var(--ink) 72%,transparent);font:700 13px "Williwaw","Avenir Next",sans-serif;letter-spacing:.015em;transition:background .22s ease,color .22s ease,transform .22s ease}.tabs button:hover{transform:none;filter:none;color:var(--ink);background:color-mix(in srgb,var(--ink) 10%,transparent)}.tabs button.active{outline:0;background:linear-gradient(135deg,#f3c969,#fde68a);color:#1a1b35;box-shadow:0 5px 15px rgba(0,0,0,.18)}.project-actions{display:flex;justify-content:flex-end;margin:0 0 14px}.project-actions button{margin:0}.dashboard-loading{display:none;position:fixed;z-index:20;inset:0;place-items:center;background:color-mix(in srgb,var(--vscode-editor-background) 38%,transparent);backdrop-filter:blur(9px);-webkit-backdrop-filter:blur(9px)}.dashboard-loading.visible{display:grid}.loading-card{display:grid;justify-items:center;gap:14px;min-width:min(310px,86vw);padding:25px 30px;border:1px solid color-mix(in srgb,var(--blue) 72%,white);border-radius:20px;background:color-mix(in srgb,var(--vscode-editor-background) 88%,#102137);box-shadow:0 22px 70px rgba(0,0,0,.38)}.orbit{width:54px;height:54px;border:3px solid color-mix(in srgb,var(--blue) 26%,transparent);border-top-color:var(--blue);border-right-color:var(--mint);border-radius:50%;animation:spin .9s linear infinite;position:relative}.orbit:after{content:"";position:absolute;width:10px;height:10px;border-radius:50%;background:var(--amber);right:-4px;top:2px;box-shadow:0 0 16px var(--amber)}.loading-card strong{font:700 19px "Petrona",Georgia,serif}.loading-card span{color:var(--muted);font-size:12px;text-align:center}@keyframes spin{to{transform:rotate(360deg)}}.card{min-width:0}.grid{grid-template-columns:repeat(auto-fit,minmax(min(265px,100%),1fr))}.bar-row{grid-template-columns:minmax(105px,1.25fr) minmax(0,4fr) 60px}.line polyline{stroke-dasharray:none;stroke-dashoffset:0;animation:lineFade .55s ease both}.causal-graph{display:none}.graph-details{display:grid;gap:8px}.graph-detail{display:none;overflow-wrap:anywhere}.relationship-flow{display:grid;gap:10px;margin:14px 0}.relationship{display:grid;grid-template-columns:minmax(0,1fr) minmax(90px,.65fr) minmax(0,1fr);gap:8px;align-items:center;width:100%;margin:0;padding:10px;border:1px solid color-mix(in srgb,var(--blue) 45%,var(--edge));border-radius:12px;background:color-mix(in srgb,#0a1b29 46%,transparent);color:var(--ink);text-align:left}.relationship:hover{transform:none;filter:none;border-color:var(--blue)}.node-chip{min-width:0;overflow-wrap:anywhere;font-size:12px;font-weight:750}.edge-link{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:5px;color:var(--blue);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;text-align:center}.edge-link:before,.edge-link:after{content:"";height:2px;background:linear-gradient(90deg,color-mix(in srgb,var(--blue) 25%,transparent),var(--blue))}.edge-link:after{background:linear-gradient(90deg,var(--blue),color-mix(in srgb,var(--blue) 25%,transparent))}@keyframes lineFade{from{opacity:.2}to{opacity:1}}@media(max-width:520px){.tabs{max-width:none}.tabs button{padding:10px 7px;font-size:11px}.project-actions{justify-content:stretch}.project-actions button{width:100%}.bar-row{grid-template-columns:minmax(80px,1fr) minmax(0,2fr) 44px}.relationship{grid-template-columns:1fr}.edge-link{grid-template-columns:1fr auto 1fr}.node-chip{text-align:center}}
  </style></head><body><main id="dashboardContent"><h1>HypoTrace</h1><p class="muted">A private AI coach that turns your coding history into clear next steps.</p><section class="hero"><div class="eyebrow">Your developer dashboard</div><h2>See what to improve, why it matters, and how you are progressing.</h2><nav class="tabs" role="tablist" aria-label="HypoTrace dashboard views"><button id="profileTab" class="active" role="tab" aria-selected="true" onclick="showProfile()">All-time profile</button><button id="projectTab" role="tab" aria-selected="false" onclick="showProject()">Current project</button><button id="forecastTab" role="tab" aria-selected="false" onclick="showForecast()">Forecast</button></nav><div id="view"></div></section></main><div id="dashboardLoading" class="dashboard-loading" role="status" aria-live="polite"><div class="loading-card"><div class="orbit"></div><strong id="loadingTitle">Updating your dashboard</strong><span id="loadingDetail">HypoTrace is analyzing local evidence. VS Code remains fully usable.</span></div></div><script>
  const vscode=acquireVsCodeApi(),data=${data},colors=['#64b5ff','#a88bff','#57d2ae','#f3c969','#ff8e8e','#6ee7d8','#d9a7ff','#8cd17d'];
  const stableUiStyle=document.createElement('style');
  stableUiStyle.textContent='body,body *,button,button *{font-family:Arial,Helvetica,sans-serif!important}';
  document.head.appendChild(stableUiStyle);
  function showLoading(command){const copy={scan:['Refreshing this project','Analyzing this workspace with your local AI service.'],profile:['Updating your all-time profile','Summarizing your saved personal evidence.'],reset:['Starting with empty data','Removing HypoTrace learning history only — your source files stay untouched.']}[command];if(!copy)return;loadingTitle.textContent=copy[0];loadingDetail.textContent=copy[1];dashboardLoading.classList.add('visible')}
  function send(command){showLoading(command);vscode.postMessage({command})} function esc(v){return String(v||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
  function issueBars(items){if(!items.length)return '<p class="muted">No clear issues were found in the latest scan.</p>';let max=Math.max(...items.map(x=>x.count||0),1);return '<p class="muted">Number of times each issue was found in the latest scan. A longer bar means it appeared more often.</p>'+items.map((x,i)=>{let n=x.count||0;return '<div class="bar-row" title="'+esc(x.suggestion)+'"><b>'+esc(x.label)+'</b><div class="track"><div class="fill" style="width:'+Math.max(4,Math.round(n/max*100))+'%;background:'+colors[i%colors.length]+';animation-delay:'+(i*.08)+'s"></div></div><span class="bar-value">'+n+' finding'+(n===1?'':'s')+'</span></div>'}).join('')}
  function dimensionBars(items){if(!items.length)return '<p class="muted">More coding history is needed before HypoTrace can assess your skills.</p>';return '<p class="muted">Each score is an AI coaching estimate from your own evidence. It is not a hiring score.</p>'+items.map((x,i)=>'<div class="bar-row" title="'+esc(x.evidence)+'"><b>'+esc(x.label)+'</b><div class="track"><div class="fill" style="width:'+Math.max(3,x.score||0)+'%;background:'+colors[i%colors.length]+';animation-delay:'+(i*.08)+'s"></div></div><span class="bar-value">'+Math.round(x.score)+'% · '+esc(x.trend)+'</span></div>').join('')}
  function trend(history,key,empty){if(history.length<2)return '<p class="muted">'+empty+'</p>';let values=history.map(x=>Number.isFinite(Number(x[key]))?Number(x[key]):0),lo=Math.min(...values),hi=Math.max(...values),span=Math.max(1,hi-lo),pts=values.map((n,i)=>(i*100/(values.length-1)).toFixed(1)+','+(84-(n-lo)*63/span).toFixed(1)).join(' '),dots=values.map((n,i)=>'<circle cx="'+(i*100/(values.length-1)).toFixed(1)+'" cy="'+(84-(n-lo)*63/span).toFixed(1)+'" r="2.8" fill="#64b5ff" style="animation-delay:'+(i*.13)+'s"><title>Assessment '+(i+1)+': '+Math.round(n)+'/100</title></circle>').join('');return '<svg class="line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Score changes from earlier to latest assessment"><line x1="0" y1="90" x2="100" y2="90" stroke="currentColor" opacity=".22"/><polyline pathLength="1" points="'+pts+'" fill="none" stroke="#64b5ff" stroke-width="2.8" vector-effect="non-scaling-stroke"/>'+dots+'</svg><div class="chart-labels"><span>Earlier assessment</span><span>Latest assessment</span></div>'}
  function donut(items,score){if(!items.length)return '<div class="donut" style="background:var(--edge)"><b>—</b></div>';let total=Math.max(1,items.reduce((n,x)=>n+Math.max(1,x.score),0)),at=0,parts=[],legend=[];items.forEach((x,i)=>{let end=at+Math.max(1,x.score)/total*100;parts.push(colors[i%colors.length]+' '+at+'% '+end+'%');legend.push('<span><i class="dot" style="background:'+colors[i%colors.length]+'"></i>'+esc(x.label)+'</span>');at=end});return '<div class="donut" style="background:conic-gradient('+parts.join(',')+')"><b>'+Math.round(score||0)+'</b></div><div class="legend">'+legend.join('')+'</div>'}
  function runSummary(r){r=r||{};const items=Object.entries(r.patterns||{}).map(([label,value])=>({label,value}));const total=Math.max(1,r.runs||0);return '<div class="grid"><article class="card"><div class="eyebrow">Normal runs observed</div><div class="score">'+(r.runs||0)+'</div><p class="muted">Only completed VS Code runs count. Typing and opening a file do not.</p></article><article class="card"><div class="eyebrow">Run outcomes</div><h3>'+(r.failures||0)+' failure'+((r.failures||0)===1?'':'s')+' · '+(r.recoveries||0)+' confirmed recover'+((r.recoveries||0)===1?'y':'ies')+'</h3><p class="muted">A recovery is counted only when a matching concern later runs successfully.</p></article></div><article class="card"><div class="eyebrow">Patterns from real runs</div><h3>What HypoTrace is watching in this project</h3>'+issueBars(items.map(x=>({label:title(x.label),count:x.value,suggestion:'This label came from a completed run, not a fixed rule.'})))+'</article>'}function title(v){return String(v||'').replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}
  function showProject(){projectTab.classList.add('active');profileTab.classList.remove('active');const p=data.project;if(!p){view.innerHTML='<h2>Current project</h2><p class="muted">Your first project scan is starting. Select Refresh this project if it does not finish shortly.</p>';return}const f=p.findings||[],r=p.runEvidence||{};view.innerHTML='<div class="grid"><article class="card"><div class="eyebrow">Source health</div><h3>'+esc(p.name)+'</h3><div class="score">'+Math.round(p.qualityScore||0)+'/100</div><p class="muted">This source scan changes after a project refresh. Run evidence below changes after a completed run.</p></article><article class="card"><div class="eyebrow">Start here</div><h3>'+esc(p.nextFocus||'Keep building evidence')+'</h3><p>'+((p.strengths||[]).map(x=>'<span class="pill">'+esc(x)+'</span>').join('')||'<span class="pill">Strengths will appear with more evidence</span>')+'</p></article></div>'+runSummary(r)+'<div class="grid"><article class="card"><div class="eyebrow">What needs attention</div><h3>Issues found in this project</h3>'+issueBars(f)+'</article><article class="card"><div class="eyebrow">Project progress</div><h3>How this project has changed</h3>'+trend(p.history||[],'qualityScore','Refresh this project once more later to see a progress line.')+'</article></div><article class="card"><div class="eyebrow">Plain-language advice</div><h3>How to improve this project</h3>'+f.map(x=>'<div class="finding"><b>'+esc(x.label)+'</b><br><span class="muted">'+esc(x.suggestion)+'</span></div>').join('')+'<p class="muted">'+esc(p.summary)+'</p></article>'}
  function showProfile(){projectTab.classList.remove('active');profileTab.classList.add('active');const p=data.professional;if(!p){view.innerHTML='<h2>All-time personal profile</h2><p class="muted">No all-time profile exists yet. Run a non-private file normally in VS Code to create your first saved evidence.</p>';return}const d=p.dimensions||[],work=d.filter(x=>x.trend==='needs_attention'||x.score<60);view.innerHTML='<div class="grid"><article class="card"><div class="eyebrow">Overall growth snapshot</div><div class="donut-wrap">'+donut(d,p.readinessScore)+'<p class="muted">Personal growth snapshot /100</p></div></article><article class="card"><div class="eyebrow">Your profile, in simple words</div><h3>'+esc(p.summary)+'</h3><p><b>Best next step:</b> '+esc(p.nextFocus)+'</p><p>'+((p.strengths||[]).map(x=>'<span class="pill">'+esc(x)+'</span>').join('')||'<span class="pill">Strengths will appear with more evidence</span>')+'</p></article></div><div class="grid"><article class="card"><div class="eyebrow">Your skill map</div><h3>What you are strong at and building</h3>'+dimensionBars(d)+'</article><article class="card"><div class="eyebrow">Areas to work on</div><h3>Practice these next</h3>'+((work.length?work:[{label:p.nextFocus||'Keep collecting evidence',evidence:'HypoTrace needs more repeated work before it can identify a weak area.'}]).map(x=>'<div class="action"><b>'+esc(x.label)+'</b><br><span class="muted">'+esc(x.evidence)+'</span></div>').join(''))+'</article></div><div class="grid"><article class="card"><div class="eyebrow">Your progress</div><h3>How your overall profile is changing</h3>'+trend(p.history||[],'readinessScore','Refresh your profile after more coding activity to see a progress line.')+'</article><article class="card"><div class="eyebrow">How to read this</div><h3>Clear and personal</h3><p class="muted">The dashboard uses only your own saved semantic outcomes and AI assessments. Scores go up or down when your coding evidence changes.</p></article></div>'}
  function selectTab(id){for(const tab of [profileTab,projectTab,forecastTab]){const selected=tab.id===id;tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',String(selected))}}
  const renderProject=showProject,renderProfile=showProfile;
  showProject=()=>{selectTab('projectTab');renderProject();view.insertAdjacentHTML('afterbegin','<div class="project-actions"><button id="refreshProjectButton">Refresh this project</button></div>');document.getElementById('refreshProjectButton').onclick=()=>send('scan')};
  showProfile=()=>{selectTab('profileTab');const result=renderProfile();if(data.freshStart)view.insertAdjacentHTML('afterbegin','<div class="action"><b>Fresh start complete</b><br><span class="muted">Your saved HypoTrace learning data is now empty. Run one non-private file in VS Code to create your first new piece of evidence.</span></div>');const model=data.learningModel;if(model){const list=(items,fn,empty)=>items?.length?items.map(fn).join(''):('<p class="muted">'+empty+'</p>');view.insertAdjacentHTML('beforeend','<div class="grid"><article class="card"><div class="eyebrow">Evidence-backed strengths</div><h3>What is working</h3>'+list(model.strengths,x=>'<div class="finding"><b>'+esc(x.label)+'</b><br><span class="muted">'+esc(x.evidence)+'</span></div>','More successful outcomes are needed before a strength is claimed.')+'</article><article class="card"><div class="eyebrow">Learning debt</div><h3>What to work on next</h3>'+list(model.learning_debt,x=>'<div class="action"><b>'+esc(x.label)+'</b><br><span class="muted">'+esc(x.evidence)+' '+esc(x.next_step)+'</span></div>','No repeated unresolved pattern is established yet.')+'</article></div><div class="grid"><article class="card"><div class="eyebrow">Build in this order</div><h3>Prerequisites seen in your evidence</h3>'+list(model.prerequisites,x=>'<div class="finding"><b>'+esc(x.before)+' → '+esc(x.then)+'</b><br><span class="muted">'+esc(x.evidence)+'</span></div>','HypoTrace has not yet observed enough evidence to infer a dependency.')+'</article><article class="card"><div class="eyebrow">Personal roadmap</div><h3>Your next small steps</h3>'+list(model.roadmap,x=>'<div class="finding"><b>'+esc(x.step)+'</b><br><span class="muted">'+esc(x.why)+'</span></div>','The roadmap appears after repeated outcomes create useful evidence.')+'</article></div>')}view.insertAdjacentHTML('beforeend','<article class="card"><div class="eyebrow">Fresh demo</div><h3>Start with empty data</h3><p class="muted">This permanently removes this VS Code profile’s saved HypoTrace run evidence, patterns, forecasts, and dashboard history. It does not delete your source files.</p><button id="resetProfileButton">Start fresh</button></article>');document.getElementById('resetProfileButton').onclick=()=>{if(confirm('Erase all saved HypoTrace learning data for this VS Code profile? Your source files will not be changed.'))send('reset')};return result};
  function showForecast(){selectTab('forecastTab');const f=data.forecast||{patterns:[],hypotheses:[],predictions:[]};const state={watching:'Watching — seen once',repeating:'Repeating — enough evidence to watch',improving:'Improving — a matching recovery was observed',repaired:'Repaired — successful evidence outweighs recurrence'};const patternCards=f.patterns.length?f.patterns.map(x=>'<article class="card"><div class="eyebrow">'+esc(state[x.state]||'Uncertain')+'</div><h3>'+esc(x.label)+'</h3><p><b>'+x.count+'</b> matching run'+(x.count===1?'':'s')+' in this project · '+Math.round((x.risk||0)*100)+'% current risk</p><p class="muted">'+(x.state==='repaired'?'No popup is shown unless the pattern becomes active again.':x.state==='watching'?'HypoTrace needs one more comparable result before it can forecast.':'HypoTrace will only remind you at a similar code decision, never just because this project opened.')+'</p></article>').join(''):'<article class="card"><h3>No active forecast yet</h3><p class="muted">Run code normally. HypoTrace needs repeated comparable outcomes before it can predict a future mistake.</p></article>';const reasons=f.hypotheses.length?f.hypotheses.map(h=>'<div class="finding"><b>Possible reason: '+esc(h.statement)+'</b><br><span class="muted">What would change this conclusion: '+esc((h.counterevidence||[])[0]||'More comparable runs are needed.')+'</span><br><span class="muted">What HypoTrace will watch next: '+esc(h.prediction||'A matching future run.')+'</span></div>').join(''):'<p class="muted">Possible reasons appear only after repeated comparable failures. HypoTrace does not pretend one failure explains a habit.</p>';const audit=f.predictions.length?f.predictions.slice(-6).reverse().map(p=>'<div class="finding"><b>'+esc(title(p.category))+'</b> · '+Math.round((p.probability||0)*100)+'% forecast<br><span class="muted">'+esc(p.outcome||'Waiting for a matching run')+'</span></div>').join(''):'<p class="muted">No forecast has been evaluated in this project yet.</p>';view.innerHTML='<div class="grid">'+patternCards+'</div><div class="grid"><article class="card"><div class="eyebrow">Why this may be happening</div><h3>Possible reasons, not assumptions</h3>'+reasons+'</article><article class="card"><div class="eyebrow">Forecast history</div><h3>Did reminders match later outcomes?</h3>'+audit+'</article></div><article class="card"><div class="eyebrow">How forecasts work</div><h3>One relevant reminder, at the right time</h3><p class="muted">A popup requires a repeated, recent pattern in this project and a matching decision in the active code. If several patterns match, HypoTrace selects the highest-confidence one. Ghost Mode records the same predictions silently so the system can measure whether it would have been useful.</p></article>'}
  const previousForecast=showForecast;
  showForecast=()=>{selectTab('forecastTab');const f=data.forecast||{patterns:[],hypotheses:[],predictions:[],calibration:{total:0,matched:0,avoided:0,history:[]}},c=f.calibration||{},status={watching:'Watching',repeating:'Repeating',improving:'Improving',repaired:'Repaired',stale:'Stale'};const age=x=>x.ageDays===null?'No recent run date':x.ageDays<1?'Seen today':'Last seen '+Math.round(x.ageDays)+' days ago';const cards=f.patterns.length?f.patterns.map(x=>'<article class="card"><div class="eyebrow">'+esc(status[x.state]||'Uncertain')+'</div><h3>'+esc(x.label)+'</h3><p><b>'+x.count+'</b> matching run'+(x.count===1?'':'s')+' · '+Math.round((x.confidence||0)*100)+'% forecast confidence</p><p class="muted">'+esc(age(x))+' · '+x.recoveries+' confirmed recover'+(x.recoveries===1?'y':'ies')+'. '+(x.state==='stale'?'This pattern is too old to interrupt you.':x.state==='repaired'?'Successful evidence currently outweighs recurrence.':x.state==='watching'?'One more comparable run is needed before any forecast.':'It can warn only at a matching decision, never on project open.')+'</p></article>').join(''):'<article class="card"><h3>No project pattern is ready to forecast</h3><p class="muted">HypoTrace needs repeated comparable run outcomes first.</p></article>';const lead=f.hypotheses.find(h=>h.state==='supported'),conclusion=lead?'<div class="finding"><b>Current conclusion — supported by the evidence so far</b><br>'+esc(lead.statement)+'<br><span class="muted">It could still change if: '+esc((lead.counterevidence||[])[0]||'new conflicting evidence appears')+'</span></div>':'<div class="finding"><b>Current conclusion — still uncertain</b><br><span class="muted">HypoTrace has not promoted a possible reason to a conclusion yet. It needs a discriminating run, recovery, or counterexample.</span></div>';const reasons=f.hypotheses.length?f.hypotheses.map(h=>'<div class="finding"><b>Possible reason: '+esc(h.statement)+'</b><br><span class="muted">What could prove it wrong: '+esc((h.counterevidence||[])[0]||'More comparable runs are needed.')+'</span><br><span class="muted">Next evidence to watch: '+esc(h.prediction||'A matching future run.')+'</span></div>').join(''):'<p class="muted">Possible reasons appear after repeated comparable failures; one failure never becomes a story about you.</p>';const audit=f.predictions.length?f.predictions.slice(-8).reverse().map(p=>'<div class="finding"><b>'+esc(title(p.category))+'</b> · '+Math.round((p.probability||0)*100)+'% confidence<br><span class="muted">'+esc(p.outcome||'Waiting for a matching run')+'</span></div>').join(''):'<p class="muted">No forecast has been evaluated in this project yet.</p>';const calibration=c.total>=3?Math.round((c.score||0)*100)+'% calibration from '+c.total+' evaluated forecasts':c.total+' evaluated forecast'+(c.total===1?'':'s')+' — more evidence is needed before confidence is calibrated';view.innerHTML='<div class="grid">'+cards+'</div><div class="grid"><article class="card"><div class="eyebrow">Pattern status</div><h3>What is active, improving, repaired, or stale</h3><p class="muted">Status changes only from this project’s completed run outcomes.</p></article><article class="card"><div class="eyebrow">Confidence check</div><h3>'+esc(calibration)+'</h3><p class="muted">'+(c.matched||0)+' forecasts matched later failures · '+(c.avoided||0)+' did not recur after a matching successful run.</p></article></div><div class="grid"><article class="card"><div class="eyebrow">What is the current conclusion?</div><h3>Agent A proposes; Agent B challenges</h3>'+conclusion+reasons+'</article><article class="card"><div class="eyebrow">Forecast history</div><h3>What happened after earlier predictions?</h3>'+audit+'</article></div><article class="card"><div class="eyebrow">When a popup is allowed</div><h3>One relevant reminder, at the right time</h3><p class="muted">A popup requires a repeated, recent pattern in this project and a matching code decision. If several patterns match, HypoTrace selects the highest-confidence one. Ghost Mode saves the same predictions silently so the confidence score can be checked without interrupting you.</p></article>'}
  function graphView(graph){const nodes=graph?.nodes||[],edges=graph?.edges||[];if(!nodes.length)return '<p class="muted">The graph appears after this project has a completed episode.</p>';return '<p class="muted">Each connection is created from your own saved session evidence. It is not a generic concept map.</p>'+nodes.map(node=>'<div class="finding"><b>'+esc(node.kind)+': '+esc(node.label)+'</b><br><span class="muted">'+esc(node.state||'observed')+' · '+edges.filter(edge=>edge.to===node.id).map(edge=>edge.label).join(', ')+'</span></div>').join('')}
  const enhancedForecast=showForecast;
  showForecast=()=>{enhancedForecast();const f=data.forecast||{},m=f.adaptiveRisk||{},transfer=f.transfer||[],retention=f.retention||[];view.insertAdjacentHTML('beforeend','<div class="grid"><article class="card"><div class="eyebrow">Personal learning graph</div><h3>Sessions → patterns → possible reasons → checks</h3>'+graphView(data.graph)+'</article><article class="card"><div class="eyebrow">Adaptive risk model</div><h3>'+Math.round((m.score||0)*100)+'% current session risk</h3><p class="muted">Learned from '+(m.updates||0)+' completed outcomes in your own profile. It begins with no personal risk score.</p><p><button id="dynamicProbeButton">Try an AI-generated check</button><button id="dynamicReplayButton">See AI reasoning replay</button></p></article></div><div class="grid"><article class="card"><div class="eyebrow">Transfer evidence</div><h3>'+transfer.length+' cross-project successful reuse'+(transfer.length===1?'':'s')+'</h3><p class="muted">'+(transfer.length?esc(transfer[0].evidence):'This appears only when a learned pattern resolves in a different project.')+'</p></article><article class="card"><div class="eyebrow">Retention evidence</div><h3>'+retention.length+' delayed successful reuse'+(retention.length===1?'':'s')+'</h3><p class="muted">'+(retention.length?'This is measured from a later successful run, not from typing.':'HypoTrace will wait for a later successful reuse before making a retention claim.')+'</p></article></div>');document.getElementById('dynamicProbeButton').onclick=()=>send('probe');document.getElementById('dynamicReplayButton').onclick=()=>send('replay')};
  function brief(value,limit=170){const clean=String(value||'').replace(/\\bE-\\d+\\b/g,'').replace(/\\s+/g,' ').trim();const first=clean.split(/(?<=[.!?])\\s/)[0]||clean;return first.length>limit?first.slice(0,limit-1)+'…':first}
  title=v=>String(v||'').replace(/[-_]/g,' ').replace(/\\b\\w/g,c=>c.toUpperCase());
  graphView=(graph)=>{const nodes=graph?.nodes||[],edges=graph?.edges||[];if(!nodes.length)return '<p class="muted">This appears after the first completed run in this project.</p>';const columns={evidence:12,pattern:39,hypothesis:66,intervention:90,prediction:90};const groups={};nodes.forEach(n=>(groups[n.kind]||(groups[n.kind]=[])).push(n));const pos={};Object.entries(groups).forEach(([kind,list])=>list.forEach((n,i)=>pos[n.id]={x:columns[kind]||52,y:12+(i+1)*76/(list.length+1)}));const line=edge=>{const a=pos[edge.from],b=pos[edge.to];return !a||!b?'':'<g><line x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'" stroke="#65b7ff" stroke-opacity=".65" stroke-width=".8" marker-end="url(#arrow)"><title>'+esc(edge.label)+'</title></line><text x="'+((a.x+b.x)/2)+'" y="'+((a.y+b.y)/2-2)+'" text-anchor="middle" fill="#b8d8f5" font-size="2.6">'+esc(edge.label)+'</text></g>'};const dot=node=>{const p=pos[node.id],label=brief(node.label,24);return '<g class="graph-node" data-graph-node="'+esc(node.id)+'" tabindex="0"><circle cx="'+p.x+'" cy="'+p.y+'" r="5.4" fill="#0f2636" stroke="#69b9ff" stroke-width=".9"></circle><text x="'+p.x+'" y="'+(p.y+.9)+'" text-anchor="middle" fill="#eef8ff" font-size="2.45">'+esc(label)+'</text><title>'+esc(node.label+' — '+(node.state||'observed'))+'</title></g>'};const details=nodes.map(n=>'<div class="finding graph-detail" data-graph-detail="'+esc(n.id)+'"><b>'+esc(title(n.kind))+': '+esc(brief(n.label,150))+'</b><br><span class="muted">'+esc(n.state||'observed')+' · '+esc(edges.filter(e=>e.from===n.id||e.to===n.id).map(e=>e.label).join(', ')||'saved evidence')+'</span></div>').join('');return '<p class="muted">Click a circle to inspect the saved relationship. Arrows show what supports, predicts, challenges, or was tested by another item.</p><svg class="causal-graph" viewBox="0 0 100 100" role="img" aria-label="Interactive personal evidence graph"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="3" markerHeight="3" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#65b7ff"/></marker></defs>'+edges.map(line).join('')+nodes.map(dot).join('')+'</svg><div class="graph-details">'+details+'</div>'};
  graphView=(graph)=>{const nodes=graph?.nodes||[],nodeById=new Map(nodes.map(node=>[node.id,node])),edges=(graph?.edges||[]).filter(edge=>nodeById.has(edge.from)&&nodeById.has(edge.to));if(!nodes.length)return '<p class="muted">This appears after the first completed run in this project.</p>';const connections=edges.length?edges.map(edge=>{const from=nodeById.get(edge.from),to=nodeById.get(edge.to);return '<button class="relationship" data-graph-node="'+esc(to.id)+'" title="Show saved evidence for this connection"><span class="node-chip">'+esc(brief(from.label,54))+'</span><span class="edge-link">'+esc(edge.label)+'</span><span class="node-chip">'+esc(brief(to.label,54))+'</span></button>'}).join(''):'<p class="muted">Saved evidence exists, but it has no relationship to draw yet.</p>';const details=nodes.map(node=>'<div class="finding graph-detail" data-graph-detail="'+esc(node.id)+'"><b>'+esc(title(node.kind))+': '+esc(brief(node.label,170))+'</b><br><span class="muted">'+esc(node.state||'observed')+' · '+esc(edges.filter(edge=>edge.from===node.id||edge.to===node.id).map(edge=>edge.label).join(', ')||'saved evidence')+'</span></div>').join('');return '<p class="muted">Each row is a saved connection from your own evidence. Select a row to inspect it.</p><div class="relationship-flow" role="list">'+connections+'</div><div class="graph-details">'+details+'</div>'};
  showForecast=()=>{selectTab('forecastTab');const f=data.forecast||{},m=f.adaptiveRisk||{},transfer=f.transfer||[],retention=f.retention||[],patterns=f.patterns||[],hypotheses=f.hypotheses||[],predictions=f.predictions||[],c=f.calibration||{};const status={watching:'Seen once — collecting evidence',repeating:'Ready — waiting for a similar future decision',improving:'Improving — a later run succeeded',repaired:'Repaired — successful runs now outweigh failures',stale:'Paused — not recent enough to interrupt'};const cards=patterns.length?patterns.map(x=>'<article class="card"><div class="eyebrow">'+esc(status[x.state]||'Collecting evidence')+'</div><h3>'+esc(x.label)+'</h3><p><b>'+x.count+'</b> matching failed run'+(x.count===1?'':'s')+' · '+x.recoveries+' matching successful follow-up'+(x.recoveries===1?'':'s')+'</p><p class="muted">'+(x.state==='repeating'?'HypoTrace will make a prediction only when you later edit a similar decision.':x.state==='watching'?'Another comparable run is needed before it is considered a pattern.':'This status changes only after a later completed run.')+'</p></article>').join(''):'<article class="card"><h3>No forecast-ready pattern yet</h3><p class="muted">Repeated comparable run outcomes are needed before HypoTrace can watch for a future decision.</p></article>';const conclusion=hypotheses.find(h=>h.state==='supported');const conclusionCard=conclusion?'<div class="finding"><b>Best explanation so far</b><br>'+esc(brief(conclusion.statement))+'<br><span class="muted">It may change if: '+esc(brief((conclusion.counterevidence||[])[0]||'a later run shows different evidence.',115))+'</span></div>':'<div class="finding"><b>No conclusion yet</b><br><span class="muted">The evidence is not strong enough to choose one explanation.</span></div>';const reasons=hypotheses.length?hypotheses.map(h=>'<div class="finding"><b>Possible reason</b><br>'+esc(brief(h.statement))+'<br><span class="muted"><b>What could prove it wrong:</b> '+esc(brief((h.counterevidence||[])[0]||'A later run with conflicting evidence.',115))+'</span><br><span class="muted"><b>What to watch next:</b> '+esc(brief(h.prediction||'A similar later run.',115))+'</span></div>').join(''):'<p class="muted">After repeated comparable failures, Agent A suggests possible reasons. Agent B names what could make each reason wrong. Neither is a fact about you.</p>';const audit=predictions.length?predictions.slice(-8).reverse().map(p=>'<div class="finding"><b>'+esc(title(p.category))+'</b> · '+Math.round((p.probability||0)*100)+'% predicted risk<br><span class="muted">'+esc(brief(p.outcome||'Waiting for the later matching run.',120))+'</span></div>').join(''):'<div class="finding"><b>Pattern ready, but no prediction has been tested yet</b><br><span class="muted">A prediction is saved only after you later edit a similar code decision. The next matching run then records whether it was right or wrong.</span></div>';const calibration=c.total>=3?Math.round((c.score||0)*100)+'% from '+c.total+' tested predictions':(c.total||0)+' tested prediction'+((c.total||0)===1?'':'s')+' — confidence will improve with more tested predictions';view.innerHTML='<div class="grid">'+cards+'</div><div class="grid"><article class="card"><div class="eyebrow">What HypoTrace thinks so far</div><h3>Possible reasons, kept honest</h3><p class="muted">Agent A offers a possible reason. Agent B looks for a reason it could be wrong. Later evidence can change or remove both.</p>'+conclusionCard+reasons+'</article><article class="card"><div class="eyebrow">Prediction record</div><h3>What happened after predictions?</h3>'+audit+'<p class="muted"><b>Confidence:</b> '+esc(calibration)+'</p></article></div><div class="grid"><article class="card"><div class="eyebrow">Your saved evidence</div><h3>Runs → patterns → possible reasons → checks</h3>'+graphView(data.graph)+'</article><article class="card"><div class="eyebrow">Current learning signal</div><h3>'+Math.round((m.score||0)*100)+'% current-session risk</h3><p class="muted">This score begins at zero and adapts from '+(m.updates||0)+' completed run outcomes in your own profile.</p><p><button id="dynamicProbeButton">Try a small AI check</button><button id="dynamicReplayButton">See the reasoning replay</button></p></article></div><div class="grid"><article class="card"><div class="eyebrow">Using a lesson in another project</div><h3>'+transfer.length+' successful cross-project reuse'+(transfer.length===1?'':'s')+'</h3><p class="muted">'+(transfer.length?esc(brief(transfer[0].evidence)):'This appears when a previously seen pattern later resolves in a different project.')+'</p></article><article class="card"><div class="eyebrow">Remembering a lesson later</div><h3>'+retention.length+' delayed successful reuse'+(retention.length===1?'':'s')+'</h3><p class="muted">'+(retention.length?'Measured from a later successful run.':'HypoTrace waits for a later successful reuse before claiming retention.')+'</p></article></div>';document.getElementById('dynamicProbeButton').onclick=()=>send('probe');document.getElementById('dynamicReplayButton').onclick=()=>send('replay')};
  showForecast=()=>{
    selectTab('forecastTab');const f=data.forecast||{},patterns=f.patterns||[],hypotheses=f.hypotheses||[],predictions=f.predictions||[];
    const cards=patterns.length?patterns.map(x=>{const k=x.calibration||null;const confidence=k?(k.status==='calibrated'?Math.round(k.probability*100)+'% calibrated from '+k.total+' tested forecasts':'Still learning — '+k.total+' tested forecast'+(k.total===1?'':'s')+' · likely range '+Math.round(k.lower*100)+'–'+Math.round(k.upper*100)+'%'):'Not calibrated yet — no tested forecast for this pattern';return '<article class="card"><div class="eyebrow">'+esc(x.state||'watching')+'</div><h3>'+esc(x.label)+'</h3><p><b>'+x.count+'</b> matching failed run'+(x.count===1?'':'s')+' · '+x.recoveries+' matching recovery</p><p class="muted"><b>Forecast confidence:</b> '+esc(confidence)+'</p></article>'}).join(''):'<article class="card"><h3>No forecast-ready pattern yet</h3><p class="muted">HypoTrace needs repeated comparable run outcomes before it can predict a future mistake.</p></article>';
    const reasons=hypotheses.length?hypotheses.map(h=>'<div class="finding"><b>Possible reason — '+esc(brief(h.statement,115))+'</b><br><span class="muted">Evidence: '+esc(h.evidenceSummary||((h.evidenceSessionCount||0)+' full coding sessions'))+' · review '+esc(h.reviewVersion||1)+'</span><br><span class="muted">What could change it: '+esc(brief((h.counterevidence||[])[0]||'A later session that shows conflicting evidence.',110))+'</span></div>').join(''):'<div class="finding"><b>No conclusion yet</b><br><span class="muted">Two full sessions create possible reasons. Three or more let Agent B test whether one is supported.</span></div>';
    const history=predictions.length?predictions.slice(-8).reverse().map(p=>'<div class="finding"><b>'+esc(title(p.category))+'</b> · '+Math.round((p.probability||0)*100)+'% predicted risk<br><span class="muted">'+esc(brief(p.outcome||'Waiting for the next matching run.',110))+'</span></div>').join(''):'<div class="finding"><b>No prediction tested yet</b><br><span class="muted">Confidence remains intentionally uncertain until real later runs evaluate predictions.</span></div>';
    view.innerHTML='<div class="grid">'+cards+'</div><div class="grid"><article class="card"><div class="eyebrow">Possible reasons, kept honest</div><h3>What HypoTrace thinks so far</h3><p class="muted">Agent A suggests possibilities. Agent B looks for counterevidence. A reflection never becomes proof; later runs decide.</p>'+reasons+'</article><article class="card"><div class="eyebrow">Prediction record</div><h3>What happened after forecasts?</h3>'+history+'</article></div><div class="grid"><article class="card"><div class="eyebrow">Your saved evidence</div><h3>Sessions → patterns → possible reasons → checks</h3>'+graphView(data.graph)+'</article><article class="card"><div class="eyebrow">Personal check policy</div><h3>One small check, selected from your results</h3><p class="muted">When several AI-generated checks are available, HypoTrace uses Thompson sampling: it explores uncertain checks and gradually favors checks followed by a successful matching run.</p><button id="dynamicProbeButton">Try a small AI check</button><button id="dynamicReplayButton">See the reasoning replay</button></article></div>';
    document.getElementById('dynamicProbeButton').onclick=()=>send('probe');document.getElementById('dynamicReplayButton').onclick=()=>send('replay');
    view.querySelectorAll('[data-graph-node]').forEach(node=>node.onclick=()=>{const id=node.getAttribute('data-graph-node');view.querySelectorAll('[data-graph-detail]').forEach(detail=>detail.style.display=detail.getAttribute('data-graph-detail')===id?'block':'none')});
  };
  showProfile();
  </script></section></body></html>`;
}

function dashboardHtml(profile) {
  return modernDashboardHtmlV2(profile);
}
function openDashboard(context) {
  try {
    const panel = vscode.window.createWebviewPanel('hypotraceDashboard', 'HypoTrace Learning Dashboard', vscode.ViewColumn.Beside, { enableScripts: true });
    const render = () => panel.webview.html = dashboardHtml(getProfile(context)); dashboardRender=render; render();
    hydrateSavedBackendReviews(context).then(changed=>{ if(changed) render(); });
    panel.onDidDispose(()=>{ if (dashboardRender === render) dashboardRender=undefined; });
    panel.webview.onDidReceiveMessage(async ({ command }) => {
      const commands={reset:'hypotrace.reset',scan:'hypotrace.scanWorkspace',probe:'hypotrace.tryGeneratedCheck',replay:'hypotrace.openReasoningReplay'};
      if(command==='profile') await refreshProfessionalProfile(context,{quiet:true});
      else if(commands[command]) { await vscode.commands.executeCommand(commands[command]); if(command==='scan') await refreshProfessionalProfile(context,{quiet:true}); }
      render();
    });
    const key=workspaceAssessmentKey(); const profile=getProfile(context);
    if(key && !profile.projectAssessments?.[key]) {
      assessWorkspace(context,{quiet:true}).then(async ()=>{ await refreshProfessionalProfile(context,{quiet:true}); render(); });
    } else if (!profile.professionalProfile && Object.keys(profile.projectAssessments || {}).length) {
      refreshProfessionalProfile(context,{quiet:true}).then(()=>render());
    }
  } catch (error) { vscode.window.showErrorMessage(`HypoTrace dashboard could not open: ${error.message}`); }
}

async function offerProbe(context, purpose='probe') {
  const p=getProfile(context); if (!p.active) return vscode.window.showInformationMessage('HypoTrace is not observing this session.');
  const workspaceId=workspaceAssessmentKey();
  const patternCounts=p.runEvidence?.[workspaceId]?.patterns || {};
  const repeatedCategories=Object.entries(patternCounts).filter(([,count])=>Number(count)>=2).sort((a,b)=>Number(b[1])-Number(a[1])).map(([category])=>category);
  const pendingCategory=String(p.predictions.find(item=>item.realized===null && item.workspaceId===workspaceId)?.category || '');
  const category=(repeatedCategories.includes(pendingCategory) ? pendingCategory : repeatedCategories[0]) || '';
  const signature=category ? `FS-${category}` : '';
  const hypotheses=(p.hypotheses || []).filter(item=>item.category===category && (item.workspaceId===workspaceId || !item.workspaceId)).slice(-3);
  const completedEpisodes=(p.episodes || []).filter(item=>item.workspaceId===workspaceId && item.categories?.includes(category)).slice(-5).map(item=>item.trace);
  const runEvidence=(p.events || []).filter(item=>item.workspaceId===workspaceId && item.type==='DIAGNOSTIC' && (item.classes || []).includes(category)).slice(-5).map(item=>`completed normal run; outcome: ${category}; event_type: diagnostic`);
  const episodes=[...completedEpisodes,...runEvidence].slice(-5);
  if (!category || episodes.length<2) return vscode.window.showInformationMessage('HypoTrace needs two comparable completed runs in this project before it can create a personal check.');
  const url=String(vscode.workspace.getConfiguration('hypotrace').get('backendUrl','')).replace(/\/$/,'');
  try {
    const probe=await postBackend(`${url}/v1/intervention`,{user_id:backendUserId(),workspace_id:backendWorkspaceId(),category,hypotheses,episodes,purpose});
    if (probe.error) throw new Error(probe.error);
    const answer=await vscode.window.showInputBox({title:'One short AI reflection',prompt:probe.prompt,placeHolder:probe.input_hint,ignoreFocusOut:true});
    if(answer===undefined) return;
    if(!answer.trim()) return vscode.window.showInformationMessage('No answer was saved. Type one short sentence only if you want to use this check.');
    const evaluation=await postBackend(`${url}/v1/probe-result`,{user_id:backendUserId(),trial_id:probe.id,category,answer});
    if (evaluation.error) throw new Error(evaluation.error);
    const fresh=getProfile(context);
    fresh.experiments=[...(fresh.experiments || []).slice(-39),{id:probe.id,intervention:probe.title,modality:probe.modality,signature,category,outcome:'waiting for the next matching run',selfReport:evaluation.outcome,state:evaluation.state,evidence:evaluation.evidence,policy:probe.policy || null,interruptions:1,at:now()}];
    for(const hypothesis of fresh.hypotheses || []) if(hypothesis.workspaceId===workspaceId && hypothesis.category===category) { hypothesis.lastProbeAt=now(); hypothesis.lastReflection=evaluation.evidence; if(evaluation.state==='contested') hypothesis.counterevidence=[...(hypothesis.counterevidence || []),evaluation.evidence].slice(-5); }
    fresh.interventionBudget=Math.max(0,(fresh.interventionBudget || 0)-1); await save(context,fresh); dashboardRender?.();
    vscode.window.showInformationMessage('HypoTrace saved your reflection. The next matching run will measure whether this check helped.');
  } catch(error) { vscode.window.showWarningMessage(`HypoTrace could not create the AI question: ${friendlyBackendError(error)}`); }
}

function friendlyBackendError(error) {
  const message=String(error?.message || error);
  if(message.includes('database is locked')) return 'the local learning service is restarting. Reload VS Code once, then try again.';
  if(message.includes('missing_probe_result')) return 'please type one short answer, or press Escape to cancel.';
  if(message.includes('no_episode_evidence')) return 'run two comparable files that fail first, then try again.';
  return message;
}

function sanitizedEpisodes(p) {
  return p.episodes.slice(-8).map(e => ({ id:e.id, canonical_behavior_trace:e.trace, outcome:e.outcome, failure_signature:e.signature || null, numeric_features:e.features?.vector || [e.features?.editBursts||0,e.features?.rewrites||0], context:e.context }));
}
async function configureOpenAI(context) {
  const key = await vscode.window.showInputBox({prompt:'Paste your OpenAI API key. It is stored only in VS Code Secret Storage.',password:true,ignoreFocusOut:true});
  if (!key) return;
  if (!/^sk-/.test(key)) return vscode.window.showErrorMessage('That does not look like an OpenAI API key. Nothing was saved.');
  await context.secrets.store('hypotrace.openai.apiKey', key.trim());
  vscode.window.showInformationMessage('HypoTrace OpenAI key stored securely.');
}
async function addReasonNote(context) {
  const note = await vscode.window.showInputBox({prompt:'Optional, private reasoning note (1–2 sentences). Only its presence and a local category are used; the note text is discarded.',placeHolder:'Example: I will establish the legal index interval first.'});
  if (!note) return;
  const category = /constraint|bound|invariant|interval/i.test(note) ? 'constraint_check' : /trace|state|step/i.test(note) ? 'state_trace' : 'plan';
  record(context,{type:'REASON_NOTE',category}); vscode.window.showInformationMessage('Reasoning-note category recorded; text was discarded.');
}
async function toggleGhostMode(context) { const p=getProfile(context); p.ghostMode=!p.ghostMode; await save(context,p); vscode.window.showInformationMessage(`Ghost Mode ${p.ghostMode?'enabled: forecasts will be silent.':'disabled: eligible forecasts may offer a probe.'}`); }
async function falseMasteryChallenge(context) { return offerProbe(context,'transfer_or_retention_check'); }
async function openReplay(context) {
  const p=getProfile(context); const workspaceId=workspaceAssessmentKey(); const category=(p.hypotheses || []).filter(item=>item.workspaceId===workspaceId).slice(-1)[0]?.category;
  if (!category) return vscode.window.showInformationMessage('A replay becomes available after a repeated real-run pattern has evidence.');
  const url=String(vscode.workspace.getConfiguration('hypotrace').get('backendUrl','')).replace(/\/$/,'');
  try {
    const replay=await postBackend(`${url}/v1/replay`,{user_id:backendUserId(),category}); if(replay.error) throw new Error(replay.error);
    const esc=value=>String(value || '').replace(/[<>&]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]));
    const panel=vscode.window.createWebviewPanel('hypotraceReplay','HypoTrace Reasoning Replay',vscode.ViewColumn.Beside,{enableScripts:true});
    panel.webview.html=`<!doctype html><style>body{font:15px system-ui;padding:24px;line-height:1.55;max-width:720px}li{margin:14px 0}button{padding:8px 12px}</style><h1>${esc(replay.title)}</h1><p>This is a short explanation of a pattern from your saved run outcomes. It does not contain your source code.</p><ol>${(replay.steps || []).map(step=>`<li>${esc(step)}</li>`).join('')}</ol><h2>What to notice next time</h2><p>${esc(replay.checkpoint)}</p><button id="checkpoint">Save this reminder</button><p id="outcome"></p><script>const vscode=acquireVsCodeApi();document.getElementById('checkpoint').onclick=()=>{document.getElementById('outcome').textContent='Saved as a private reminder. It does not change your code or score.';vscode.postMessage({type:'checkpoint'})}</script>`;
    panel.webview.onDidReceiveMessage(()=>record(context,{type:'REASON_NOTE',category:'dynamic-replay-checkpoint'}));
  } catch(error) { vscode.window.showWarningMessage(`HypoTrace could not build the explanation: ${friendlyBackendError(error)}`); }
}

async function prepareNormalRunObservation() {
  const config=vscode.workspace.getConfiguration('terminal.integrated');
  const inspection=config.inspect('shellIntegration.enabled');
  if (inspection?.globalValue === false || inspection?.workspaceValue === false) return;
  if (inspection?.globalValue === undefined && inspection?.workspaceValue === undefined) {
    await config.update('shellIntegration.enabled', true, vscode.ConfigurationTarget.Global);
  }
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function currentBackend(url) {
  try { const health=await getBackend(`${url}/health`); return health?.revision===BACKEND_REVISION ? health : null; }
  catch (_) { return null; }
}
function freeLoopbackPort() {
  return new Promise((resolve,reject)=>{
    const probe=net.createServer();
    probe.unref();
    probe.once('error',reject);
    probe.listen({host:'127.0.0.1',port:0},()=>{const address=probe.address();probe.close(error=>error?reject(error):resolve(address.port));});
  });
}
async function ensureBundledBackend(context) {
  const config=vscode.workspace.getConfiguration('hypotrace');
  const configured=String(config.get('backendUrl','')).replace(/\/$/,'');
  if (await currentBackend(configured)) return;
  const server=path.join(context.extensionPath,'backend','server.py');
  if (!fs.existsSync(server)) return;
  const port=await freeLoopbackPort(), url=`http://127.0.0.1:${port}`;
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath,{recursive:true});
    const python=process.env.HYPOTRACE_PYTHON || (fs.existsSync('/opt/homebrew/bin/python3.12') ? '/opt/homebrew/bin/python3.12' : 'python3');
    const child=spawn(python,[server],{cwd:path.dirname(server),env:{...process.env,HYPOTRACE_PORT:String(port),HYPOTRACE_DB:path.join(context.globalStorageUri.fsPath,'hypotrace-current-v3.db')},stdio:'ignore',windowsHide:true});
    child.on('error',()=>{}); context.subscriptions.push({dispose:()=>{ if(!child.killed) child.kill(); }});
    for(let attempt=0;attempt<10;attempt++) { await wait(250); if(await currentBackend(url)) { await config.update('backendUrl',url,vscode.ConfigurationTarget.Global); return; } }
    vscode.window.showWarningMessage('HypoTrace could not start its current local AI service. Restart VS Code once, then try again.');
  } catch (_) {}
}

function activate(context) {
  let profile=getProfile(context);
  if (profile.version < 6 || profile.isDemo || profile.sessions.some(session=>session.id==='demo-session')) {
    profile=initialProfile(); save(context,profile);
  }
  context._hypotraceStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  context.subscriptions.push(context._hypotraceStatus);
  updateStatus(context,profile);
  prepareNormalRunObservation().catch(()=>{});
  ensureBundledBackend(context);
  for (const doc of vscode.workspace.textDocuments) scheduleAiInspection(context,doc);
  context.subscriptions.push(vscode.commands.registerCommand('hypotrace.openDashboard', () => openDashboard(context)));
  context.subscriptions.push(vscode.commands.registerCommand('hypotrace.showLearningReview', () => showLatestLearningReview(context)));
  context.subscriptions.push(vscode.commands.registerCommand('hypotrace.scanWorkspace', () => assessWorkspace(context)));
  context.subscriptions.push(vscode.commands.registerCommand('hypotrace.tryGeneratedCheck', () => offerProbe(context)));
  context.subscriptions.push(vscode.commands.registerCommand('hypotrace.openReasoningReplay', () => openReplay(context)));
  context.subscriptions.push(vscode.commands.registerCommand('hypotrace.showStatus', () => showLearningStatus(context)));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('hypotrace.dashboard', {
    resolveWebviewView(view) {
      view.webview.options={enableScripts:true};
      const render=()=>{ view.webview.html=dashboardHtml(getProfile(context)); };
      render();
      view.webview.onDidReceiveMessage(async ({command})=>{
        const commands={reset:'hypotrace.reset',scan:'hypotrace.scanWorkspace',probe:'hypotrace.tryGeneratedCheck',replay:'hypotrace.openReasoningReplay'};
        if(command==='profile') await refreshProfessionalProfile(context,{quiet:true});
        else if(commands[command]) { await vscode.commands.executeCommand(commands[command]); if(command==='scan') await refreshProfessionalProfile(context,{quiet:true}); }
        render();
      });
      const previous=dashboardRender;
      const rerender=()=>{ render(); previous?.(); };
      dashboardRender=rerender;
      view.onDidDispose(()=>{ if(dashboardRender===rerender) dashboardRender=previous; });
    }
  }));
  if (vscode.workspace.getConfiguration('hypotrace').get('projectAssessmentOnOpen',true)) setTimeout(()=>assessWorkspace(context,{quiet:true}),3500);
  context.subscriptions.push(vscode.commands.registerCommand('hypotrace.reset', async () => {
    const choice=await vscode.window.showWarningMessage('Start HypoTrace over? This permanently erases this VS Code profile’s saved run evidence, forecasts, and dashboard history.', {modal:true}, 'Start fresh');
    if(choice!=='Start fresh') return;
    const url=String(vscode.workspace.getConfiguration('hypotrace').get('backendUrl','')).replace(/\/$/,'');
    try {
      const result=await postBackend(`${url}/v1/reset`,{user_id:backendUserId()});
      if(!result?.ok) throw new Error(result?.error || 'reset did not finish');
      const fresh=initialProfile(); fresh.freshStartAt=now(); await save(context,fresh);
      dashboardRender?.();
      vscode.window.showInformationMessage('HypoTrace started fresh. Your next completed run creates the first evidence.');
    } catch(error) {
      vscode.window.showWarningMessage(`HypoTrace could not start fresh: ${friendlyBackendError(error)}. No data was erased.`);
    }
  }));
  let lastSemanticAt = Date.now();
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async e => { if(!isPrivate(e.document) && e.contentChanges.length) { const elapsed=Date.now()-lastSemanticAt; if(elapsed>1500) record(context,{type:'PAUSE',durationMs:elapsed}); const delta=e.contentChanges.reduce((n,c)=>n+c.text.length-c.rangeLength,0); record(context,{type:delta<0?'REVERT':'EDIT_BURST',charsDelta:delta,language:e.document.languageId}); scheduleAiInspection(context,e.document); lastSemanticAt=Date.now(); } }));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => scheduleAiInspection(context,doc)));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => { if(editor) scheduleAiInspection(context,editor.document); }));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(e => { if(!isPrivate(e.textEditor.document)) { const elapsed=Date.now()-lastSemanticAt; if(elapsed>3000) record(context,{type:'PAUSE',durationMs:elapsed}); record(context,{type:'NAVIGATION',selections:e.selections.length}); lastSemanticAt=Date.now(); } }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {if(!isPrivate(doc))record(context,{type:'RUN_OR_SAVE',language:doc.languageId});}));
  context.subscriptions.push(vscode.debug.onDidStartDebugSession(() => record(context,{type:'DEBUG_STEP',phase:'start'})));
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => record(context,{type:'DEBUG_STEP',phase:'end'})));
  context.subscriptions.push(vscode.tasks.onDidStartTask(e => record(context,{type:'RUN_OR_SAVE',category:'task',task:e.execution.task.name})));
  context.subscriptions.push(vscode.tasks.onDidEndTaskProcess(e => { const task=e.execution.task; if(e.exitCode === 0) record(context,{type:'RUN_OR_SAVE',category:'task',task:task.name,outcome:'pass'}); else analyzeOutcome(context,`Task exited with status ${e.exitCode}: ${task.name}`,'task','VS Code task'); }));
  installShellExecutionObserver(context);
}
function deactivate() {}
module.exports = { activate, deactivate };
