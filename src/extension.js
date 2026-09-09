const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runHypothesisAgent, runFalsifierAgent, embedEpisode, runCodeCoach, runSkillEvolutionAgent } = require('./aiClient');
const { post: postBackend } = require('./backendClient');

const KEY = 'hypotrace.profile.v1';
const now = () => new Date().toISOString();
const clamp = n => Math.max(0, Math.min(1, n));
const last = items => items && items.length ? items[items.length - 1] : undefined;
// The AI inspector is deliberately debounced.  It is not a keystroke logger:
// it runs after a meaningful pause and retains only a semantic result.
const activeAiFindings = new Map();
const inspectionTimers = new Map();

function initialProfile() {
  return {
    // Version 2 deliberately invalidates the former demo-shaped profile so
    // only evidence collected by the current dynamic pipeline is displayed.
    version: 2, privacy: 'semantic-only', sessions: [], events: [], episodes: [],
    signatures: [], hypotheses: [], predictions: [], experiments: [],
    // A fresh install must begin empty: no fabricated weaknesses, strengths, or scores.
    transfer: [], retention: [], strengths: [], debt: [],
    milestone: { label: 'First observed learning goal', progress: 0, total: 1 },
    interventionBudget: 3, active: true, ghostMode: false, lastEpisodeEventCount: 0,
    skills: [], evolution: [], knowledge: [], projectAssessments: {}, professionalProfile: null,
    // Evidence of what this individual profile has actually observed. These
    // counters make it clear when the IDE observation channel is not connected.
    observability: { terminalCommands:0, shellIntegratedTerminals:0, backendEpisodes:0, aiInspections:0, lastOutcome:'none', lastBackend:'not contacted' },
    concepts: [
      ['Array bounds',[]],['Boundary representation',['Array bounds']],['Two pointers',['Boundary representation']],['Sliding-window invariant',['Two pointers']],['Recursion base case',[]],['Return propagation',['Recursion base case']],['State tracing',['Return propagation']],['Graph traversal',[]],['DFS recursion',['Graph traversal','Recursion base case']],['BFS queue',['Graph traversal']],['Complexity analysis',[]],['Hash lookup',['Complexity analysis']],['Backtracking',['DFS recursion']],['Debugging hypothesis',['State tracing']],['Counterexample design',['Debugging hypothesis']]
    ]
  };
}

function getProfile(context) {
  const saved = context.globalState.get(KEY);
  if (!saved) return initialProfile();
  const base = initialProfile();
  return {...base, ...saved, skills:saved.skills || base.skills, evolution:saved.evolution || base.evolution, knowledge:saved.knowledge || base.knowledge, projectAssessments:saved.projectAssessments || base.projectAssessments, professionalProfile:saved.professionalProfile || base.professionalProfile, concepts:saved.concepts || base.concepts};
}
async function save(context, profile) { await context.globalState.update(KEY, profile); }
function isPrivate(doc) {
  const value = doc.uri.fsPath.toLowerCase();
  return value.includes('.env') || value.includes('secret') || value.includes('credential');
}
function risk(profile) {
  const recent = profile.events.slice(-12);
  const edits = recent.filter(e => e.type === 'EDIT_BURST').length;
  const failures = recent.filter(e => e.type === 'DIAGNOSTIC').length;
  const noPlan = !recent.some(e => e.type === 'REASON_NOTE');
  return clamp(.28 + edits * .07 + failures * .13 + (noPlan ? .12 : 0) + (profile.signatures.length ? .08 : 0));
}
function titleCase(value) { return String(value).replace(/^runtime-/, '').replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase()); }
async function analyzeOutcome(context, outcome, language='text', source='IDE') {
  const config=vscode.workspace.getConfiguration('hypotrace'); const url=String(config.get('backendUrl','')).replace(/\/$/,'');
  if(!url || !getProfile(context).active) return;
  try {
    const result=await postBackend(`${url}/v1/outcome`,{user_id:config.get('backendUserId','local-dev'),language,outcome:String(outcome).slice(0,9000)});
    if(result.state !== 'failure_present' || !result.category || (result.confidence || 0) < .60) return;
    record(context,{type:'DIAGNOSTIC',classes:[result.category],severity:['Error'],source,label:result.label});
  } catch (_) { /* No fallback category is invented when AI is unavailable. */ }
}
async function recordSuccessfulOutcome(context, source='normal run') {
  // A successful normal run is useful only when it follows a concrete AI
  // observation in the same open file. This avoids falsely declaring that an
  // unrelated successful command repaired a personal pattern.
  const editor=vscode.window.activeTextEditor;
  const uri=editor?.document?.uri?.toString(); const finding=uri && activeAiFindings.get(uri);
  if (!finding) { record(context,{type:'RUN_OR_SAVE',category:'normal-run',outcome:'pass',source}); return; }
  activeAiFindings.delete(uri);
  await syncEpisodeToBackend(context,inspectionEpisode('recovery',{category:finding.category,label:finding.label,decision:'the previously observed decision now completed successfully',confidence:1}));
  record(context,{type:'RUN_OR_SAVE',category:'normal-run',outcome:'pass',source});
}
function installShellExecutionObserver(context) {
  // Modern VS Code shell integration lets an extension associate output with one
  // completed terminal command. This is the normal Run/Terminal path: no custom
  // HypoTrace command is needed. Terminal output is buffered only long enough to
  // classify the outcome, then immediately discarded.
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
      } catch (_) { /* Shell integration can end before output is readable. */ }
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
  return {id:`E-${Date.now()}`,kind,trace:`episode_kind: ${kind}; semantic_pattern: ${result.category}; decision: ${result.decision}; confidence: ${Math.round((result.confidence || 0)*100)}%`,categories:[result.category],label:result.label,features:[0,0,kind==='diagnostic'?1:0,0,0,0,0]};
}
async function inspectCurrentCode(context, document) {
  const profile=getProfile(context); const config=vscode.workspace.getConfiguration('hypotrace');
  if (!profile.active || isPrivate(document) || !config.get('aiCodeAnalysis',true) || !document.getText().trim()) return;
  const editor=vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== document.uri.toString()) return;
  const uri=document.uri.toString(); const line=editor.selection.active.line;
  try {
    const url=String(config.get('backendUrl','')).replace(/\/$/,''); if (!url) return;
    // This exact snapshot is sent transiently for the user's enabled AI
    // analysis; neither this extension nor the backend writes it to SQLite.
    const result=await postBackend(`${url}/v1/inspect`,{user_id:config.get('backendUserId','local-dev'),language:document.languageId,cursor_line:line,code:document.getText().slice(0,16000)});
    const p=getProfile(context); const observation=p.observability || {};
    p.observability={...observation,aiInspections:(observation.aiInspections || 0)+1,lastBackend:result.backend === 'openai'?'AI inspection complete':String(result.backend || 'inspection unavailable')}; await save(context,p);
    const activeKey=activeAiFindings.get(uri);
    if (result.state === 'clear') {
      if (activeKey) { activeAiFindings.delete(uri); await syncEpisodeToBackend(context,inspectionEpisode('recovery',{category:activeKey.category,label:activeKey.label,decision:'previous personal decision repaired',confidence:1})); }
      return;
    }
    if (!result.category || (result.confidence || 0) < .60) return;
    const decisionKey=`${result.category}|${uri}|${line}`;
    if (result.state === 'failure_present') {
      if (!activeKey || activeKey.decisionKey !== decisionKey) {
        activeAiFindings.set(uri,{category:result.category,label:result.label,decisionKey});
        record(context,{type:'DIAGNOSTIC',classes:[result.category],severity:['Error'],source:'personal AI observation',label:result.label});
      }
      return;
    }
    // An opportunity has passed the model's relevance check. The server still
    // enforces the two-failure, recovery-adjusted personal threshold before a
    // notification can be displayed.
    await syncEpisodeToBackend(context,{...inspectionEpisode('opportunity',result),decisionKeys:{[result.category]:decisionKey}});
  } catch (_) { /* Offline or a missing key means no AI forecast, never a fabricated fallback. */ }
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
function skillUtility(skill) {
  return (skill.transfer || 0) * .30 + (skill.retention || 0) * .25 + (skill.recovery || 0) * .25 - (skill.cost || 0) * .10 - (skill.dependence || 0) * .07 - (skill.falsePositive || 0) * .03;
}
function selectMEI(profile) {
  return profile.skills.filter(s => ['trial','validated','active','candidate'].includes(s.status)).sort((a,b) => skillUtility(b)-skillUtility(a))[0];
}
function mutateProcedure(procedure) {
  if (/interval|constraint/i.test(procedure)) return 'Show one boundary counterexample, then ask the learner to state the legal interval before continuing.';
  if (/trace|state/i.test(procedure)) return 'Pause at the first state transition and ask for a prediction before revealing the next state.';
  return 'Use a Socratic fork: choose the next verification action, then test it on a minimal counterexample.';
}
function evolveDeterministically(profile, skill, outcome) {
  const utility = skillUtility(skill);
  let event, reason;
  if (skill.status === 'candidate' && skill.evidence >= 3 && skill.transfer >= .20 && skill.retention >= .15 && utility > .12) {
    skill.status = 'validated'; event = 'promoted to validated'; reason = 'Durable transfer and retention improved with acceptable interruption cost.';
  } else if ((skill.evidence >= 4 && utility < .04) || skill.dependence > .55) {
    skill.status = 'retired'; event = 'retired'; reason = skill.dependence > .55 ? 'Assistance dependence exceeded the permitted threshold.' : 'Repeated evidence showed low durable benefit.';
  } else if ((outcome === 'recurrence' || utility < .02) && skill.status !== 'retired') {
    skill.status = 'mutating'; const variant = {...skill,id:`${skill.id}-v${skill.version+1}`,version:skill.version+1,status:'trial',parent:skill.id,procedure:mutateProcedure(skill.procedure),transfer:0,retention:0,recovery:0,dependence:0,cost:Math.max(.05,(skill.cost||.12)-.02),falsePositive:0,evidence:0}; profile.skills.push(variant); event = `mutated → ${variant.id}`; reason = outcome === 'recurrence' ? 'The parent did not prevent recurrence; a constrained variant will compete.' : 'Low multi-objective utility triggered a lower-cost variant.';
  } else if (skill.status === 'validated' && skill.evidence >= 5 && utility > .18) {
    skill.status = 'active'; event = 'promoted to active'; reason = 'Outperformed alternatives on durable-learning utility.';
  } else { event = 'held for more evidence'; reason = 'Immediate completion is insufficient; more transfer/retention evidence is required.'; }
  profile.evolution.unshift({at:now(),skill:`${skill.id} v${skill.version}`,event,reason,utility:Number(utility.toFixed(2))}); profile.evolution=profile.evolution.slice(0,20);
  return {event,reason};
}
async function evolveSkills(context, outcome) {
  const p=getProfile(context); const skill=selectMEI(p);
  if (!skill) return vscode.window.showInformationMessage('No intervention skill is eligible for evolution yet. Run the AI agents or load the demo.');
  skill.evidence=(skill.evidence||0)+1;
  if(outcome==='passed') { skill.transfer=clamp((skill.transfer||0)+.12); skill.retention=clamp((skill.retention||0)+.06); skill.recovery=clamp((skill.recovery||0)+.08); skill.dependence=clamp((skill.dependence||0)-.04); }
  if(outcome==='recurrence') { skill.transfer=clamp((skill.transfer||0)-.08); skill.recovery=clamp((skill.recovery||0)-.10); skill.falsePositive=clamp((skill.falsePositive||0)+.05); }
  const apiKey=await context.secrets.get('hypotrace.openai.apiKey');
  let detail;
  if (apiKey) {
    try {
      const model=vscode.workspace.getConfiguration('hypotrace').get('openAIModel','gpt-5-mini');
      const agent=await runSkillEvolutionAgent(apiKey,model,skill,{outcome,utility:skillUtility(skill),recentTransfer:p.transfer.slice(-3),retention:p.retention,interruptionBudget:p.interventionBudget});
      if(agent.decision==='mutate') { skill.status='mutating'; const variant={...skill,id:`${skill.id}-v${skill.version+1}`,version:skill.version+1,status:'trial',parent:skill.id,procedure:agent.variant_procedure,mechanism:agent.expected_mechanism,transfer:0,retention:0,recovery:0,dependence:0,falsePositive:0,evidence:0};p.skills.push(variant);detail={event:`AI mutation → ${variant.id}`,reason:agent.rationale}; }
      else if(agent.decision==='promote' && skill.evidence>=3 && skill.transfer>=.2) {skill.status=skill.status==='validated'?'active':'validated';detail={event:`AI promoted to ${skill.status}`,reason:agent.rationale};}
      else if(agent.decision==='retire' && (skill.evidence>=4 || skill.dependence>.55)) {skill.status='retired';detail={event:'AI retired skill',reason:agent.rationale};}
      else detail=evolveDeterministically(p,skill,outcome);
      p.evolution.unshift({at:now(),skill:`${skill.id} v${skill.version}`,event:detail.event,reason:detail.reason,utility:Number(skillUtility(skill).toFixed(2)),plan:agent.evaluation_plan}); p.evolution=p.evolution.slice(0,20);
    } catch (_) { detail=evolveDeterministically(p,skill,outcome); }
  } else detail=evolveDeterministically(p,skill,outcome);
  await save(context,p); return detail;
}
async function showForecastAlert(context, p, signature, decisionKey) {
  const enabled = vscode.workspace.getConfiguration('hypotrace').get('liveWarnings', true);
  const alerted=p.alertedDecisionKeys || {}; const alreadyWarned=decisionKey && alerted[decisionKey];
  const score=Math.min(.90, Math.max(.72, signature.risk || .72));
  if (!enabled || p.ghostMode || signature.suppressed || score < .70 || p.interventionBudget < 1 || p.alertOpen || alreadyWarned) return;
  p.alertOpen = true; p.alertedDecisionKeys={...alerted,[decisionKey || signature.id]:Date.now()}; await save(context,p);
  const choice = await vscode.window.showWarningMessage(
    `HypoTrace forecast: ${Math.round(score*100)}% risk at this ${signature.sector || 'coding'} decision — ${signature.name}.`,
    '15-second check', 'Why this?', 'Explain & coach');
  const fresh = getProfile(context); fresh.alertOpen = false; await save(context,fresh);
  if (choice === '15-second check') await offerProbe(context);
  if (choice === 'Why this?') openDashboard(context);
  if (choice === 'Explain & coach') await explainAndCoach(context);
}
function showLearningReview(context, category, hypotheses) {
  if (!hypotheses?.length) return;
  const esc=value=>String(value || '').replace(/[&<>]/g, char=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]));
  const cards=hypotheses.map((item,index)=>`<article><h2>Possible reason ${index+1}</h2><p>${esc(item.statement)}</p><h3>What HypoTrace will watch for next</h3><p>${esc(item.prediction)}</p><h3>A small check that may help</h3><p>${esc(item.probe)}</p><h3>Agent B's caution</h3><p>${item.state==='supported'?'This matches the evidence so far, but it is not proven.':item.state==='contested'?'This is possible, but there is evidence against it too.':'There is not enough evidence to choose this explanation yet.'}${item.counterevidence?.[0] ? ` ${esc(item.counterevidence[0])}` : ''}</p></article>`).join('');
  const panel=vscode.window.createWebviewPanel('hypotraceLearningReview','HypoTrace: What I learned',vscode.ViewColumn.Beside,{});
  panel.webview.html=`<!doctype html><style>body{font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55;padding:24px;max-width:840px;color:var(--vscode-foreground)}h1,h2{font-family:Georgia,serif}article{border:1px solid var(--vscode-panel-border);border-radius:12px;padding:16px;margin:14px 0;background:var(--vscode-editor-background)}h3{font-size:13px;margin:16px 0 2px;color:var(--vscode-textLink-foreground)}</style><h1>What HypoTrace is learning</h1><p>These are two possible explanations for a repeated <b>${esc(category)}</b> pattern. They are not facts about you. Agent B actively looks for reasons each explanation could be wrong.</p>${cards}<p><small>Only privacy-filtered event summaries and outcomes were used. No source code is stored in your learning record.</small></p>`;
}
function buildEpisode(p, trigger) {
  // An episode is a short, privacy-filtered work period ending in a meaningful
  // result. It contains event types and counts only—never text typed by the
  // developer, code, command contents, file names, or clipboard data.
  const end=Date.now(); const lastBoundary=p.lastEpisodeEventCount || 0;
  const recent=p.events.slice(lastBoundary).filter(event => end - Date.parse(event.at || now()) <= 5 * 60 * 1000);
  const events=(recent.length ? recent : p.events.slice(-12)).slice(-24);
  // Only diagnostics and an actual learned decision point reach the backend.
  // Plain spaces, cursor moves, file opens, and generic edits never forecast.
  const diagnosticBoundary = trigger?.type === 'DIAGNOSTIC';
  const opportunityBoundary = Array.isArray(trigger?.forecastClasses) && trigger.forecastClasses.length > 0;
  if (!diagnosticBoundary && !opportunityBoundary) return null;
  const counts = type => events.filter(x => x.type === type).length;
  const types = events.map(x => x.type);
  const diagnostics = events.filter(x=>x.type==='DIAGNOSTIC').flatMap(x=>x.classes||[]);
  const rewrites = events.filter(x=>x.type==='EDIT_BURST' && x.charsDelta < 0).length;
  const vector = [counts('EDIT_BURST'),counts('NAVIGATION'),counts('DIAGNOSTIC'),counts('RUN_OR_SAVE'),counts('DEBUG_STEP'),rewrites,counts('REASON_NOTE')];
  const categories = [...new Set(diagnosticBoundary ? (trigger.classes || []) : trigger.forecastClasses)];
  const kind=diagnosticBoundary?'diagnostic':'opportunity';
  const canonical = `episode_kind: ${kind}; task_phase: implementation; event_window_seconds: ${Math.max(0,Math.round((end-Date.parse(events[0]?.at || now()))/1000))}; sequence: ${types.join(' → ')}; edit_bursts: ${vector[0]}; rewrites: ${rewrites}; navigation: ${vector[1]}; diagnostics: [${diagnostics.join(',')}]; categories: [${categories.join(',')}]; reason_note_seen: ${vector[6]>0}`;
  const ep = {id:`E-${Date.now()}`, kind, trace:canonical, categories, label:trigger.label, decisionKeys:trigger.decisionKeys || {}, outcome:diagnosticBoundary?'failure observed':'possible future decision', signature:null, context:'current workspace', features:{vector,editBursts:vector[0],rewrites,constraintCheck:vector[6]>0,eventCount:events.length}};
  p.episodes.push(ep); p.episodes = p.episodes.slice(-50); p.lastEpisodeEventCount = p.events.length;
  return ep;
}
async function syncEpisodeToBackend(context, episode) {
  const config=vscode.workspace.getConfiguration('hypotrace'); const url=String(config.get('backendUrl','')).replace(/\/$/,'');
  if (!url || !episode) return;
  try {
    const response=await postBackend(`${url}/v1/episodes`,{user_id:config.get('backendUserId','local-dev'),episode:{id:episode.id,kind:episode.kind,trace:episode.trace,categories:episode.categories || [],label:episode.label,features:episode.features?.vector || episode.features || []}});
    // Persist returned, server-learned evidence locally only as semantic labels.
    const p=getProfile(context); let agentReviewCreated=false;
    const observation=p.observability || {};
    p.observability={...observation,backendEpisodes:(observation.backendEpisodes || 0)+1,lastBackend:'episode acknowledged'};
    for (const learned of response.signatures || []) {
      let signature=p.signatures.find(s=>s.id===`FS-${learned.category}`);
      if (!signature) { signature={id:`FS-${learned.category}`,name:learned.name,sector:learned.category,recurrence:0,trend:'candidate',contexts:['backend similarity retrieval'],risk:0}; p.signatures.push(signature); }
      signature.name=learned.name || signature.name; signature.recurrence=learned.count||0; signature.recoveries=learned.recoveries||0; signature.risk=learned.risk ?? signature.risk;
      signature.trend=learned.learned?'recurring':(signature.recoveries >= 2 ? 'improving' : 'candidate'); signature.suppressed=signature.recoveries >= 2 && !learned.learned;
      for (const [index,h] of (learned.hypotheses || []).entries()) {
        const id=`B-${learned.category}-${index}`;
        const review={id,category:learned.category,state:h.state || 'insufficient_evidence',statement:h.statement,prediction:h.prediction,probe:h.probe,evidence:[`${learned.count} similar outcomes for this developer`],counterevidence:h.counterevidence || []};
        const existing=p.hypotheses.findIndex(x=>x.id===id);
        if (existing === -1) { p.hypotheses.push(review); agentReviewCreated=true; }
        else p.hypotheses[existing]={...p.hypotheses[existing],...review};
      }
      const trigger=`FS-${learned.category}`;
      if (learned.learned && learned.hypotheses?.[0] && !p.skills.some(s=>s.trigger===trigger && s.status!=='retired')) {
        const proposal=learned.hypotheses[0]; const skill={id:`S-${learned.category}-${Date.now()}`,version:1,status:'candidate',trigger,procedure:proposal.probe,mechanism:'Agent A proposal retained after Agent B falsification review',transfer:0,retention:0,recovery:0,dependence:0,cost:.1,falsePositive:0,evidence:0};
        p.skills.push(skill); p.evolution.unshift({at:now(),skill:`${skill.id} v1`,event:'candidate created from Agent A/B review',reason:proposal.state === 'supported' ? 'Agent B found the proposal currently supported.' : 'Agent B retained this as a contested, testable intervention.',utility:0}); p.evolution=p.evolution.slice(0,20);
      }
    }
    await save(context,p);
    if (agentReviewCreated) {
      const reviewed=response.signatures?.find(item=>item.hypotheses?.length);
      vscode.window.showInformationMessage('HypoTrace found a repeated pattern. I compared two possible reasons and checked what could make each one wrong.');
      if (reviewed) showLearningReview(context,reviewed.category,reviewed.hypotheses);
    }
    if(response.forecast && episode.kind==='opportunity') showForecastAlert(context,p,p.signatures.find(s=>s.id===`FS-${response.forecast.category}`) || {id:`FS-${response.forecast.category}`,name:response.forecast.name,sector:response.forecast.category,risk:response.forecast.risk},episode.decisionKeys?.[response.forecast.category]);
  } catch (_) { /* Backend is optional; local-first operation continues offline. */ }
}
function record(context, event) {
  const p = getProfile(context); if (!p.active) return;
  p.events.push({ id: `EV-${Date.now()}`, at: now(), ...event });
  p.events = p.events.slice(-120);
  const episode = buildEpisode(p,event);
  const score = risk(p);
  if (event.type === 'DIAGNOSTIC') {
    const open = p.predictions.find(x => x.realized === null);
    if (open) { open.realized = true; p.lastOutcome = 'recurrence'; }
  }
  save(context, p);
  if (episode) syncEpisodeToBackend(context,episode);
  updateStatus(context,p);
  vscode.commands.executeCommand('setContext', 'hypotrace.risk', score >= .7);
}

function workspaceAssessmentKey() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.toString() || '';
}
function sourceLanguage(file) {
  const ext=path.extname(file).toLowerCase();
  return ({'.py':'python','.js':'javascript','.ts':'typescript','.tsx':'typescript-react','.jsx':'javascript-react','.cpp':'cpp','.cc':'cpp','.cxx':'cpp','.c':'c','.h':'c','.hpp':'cpp','.java':'java','.go':'go','.rs':'rust'})[ext] || '';
}
async function collectWorkspaceSource() {
  const include='**/*.{py,js,ts,tsx,jsx,cpp,cc,cxx,c,h,hpp,java,go,rs}';
  const exclude='**/{.git,node_modules,venv,.venv,__pycache__,dist,build,.next,target,vendor}/**';
  // Keep a project assessment comfortably within an interactive request. It is
  // sampled across the project and can be refreshed; it is not a repository dump.
  const uris=await vscode.workspace.findFiles(include,exclude,10); const files=[];
  for (const uri of uris) {
    if (isPrivate({uri})) continue;
    try { const stat=await vscode.workspace.fs.stat(uri); if(stat.size > 50000) continue; const content=Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); if(content.trim()) files.push({language:sourceLanguage(uri.fsPath),content:content.slice(0,2500)}); }
    catch (_) { /* Skip unreadable files. */ }
  }
  return files;
}
async function assessWorkspace(context, {quiet=false}={}) {
  const key=workspaceAssessmentKey(); const config=vscode.workspace.getConfiguration('hypotrace');
  if (!key || !config.get('aiCodeAnalysis',true)) return null;
  const files=await collectWorkspaceSource(); if (!files.length) return null;
  const url=String(config.get('backendUrl','')).replace(/\/$/,''); if(!url) return null;
  try {
    const result=await postBackend(`${url}/v1/project-assessment`,{user_id:config.get('backendUserId','local-dev'),files});
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
    const result=await postBackend(`${url}/v1/professional-profile`,{user_id:config.get('backendUserId','local-dev'),assessments,outcomes});
    if(result.error) throw new Error(result.error);
    const prior=profile.professionalProfile || {history:[]};
    const snapshot={at:now(),readinessScore:result.readiness_score,dimensions:result.dimensions || []};
    profile.professionalProfile={readinessScore:result.readiness_score,summary:result.summary || '',dimensions:result.dimensions || [],strengths:result.strengths || [],nextFocus:result.next_focus || '',updatedAt:now(),history:[...(prior.history || []).slice(-11),snapshot]};
    profile.observability={...(profile.observability || {}),lastBackend:'professional AI profile complete'}; await save(context,profile);
    if(!quiet) vscode.window.showInformationMessage('HypoTrace refreshed your all-time professional growth profile.');
    return profile.professionalProfile;
  } catch(error) { if(!quiet) vscode.window.showWarningMessage(`HypoTrace professional profile could not run: ${error.message}`); return null; }
}
function assessmentData(profile) {
  const project=profile.projectAssessments?.[workspaceAssessmentKey()] || null;
  const global={};
  const projects=Object.values(profile.projectAssessments || {}).map(project => ({name:project.name,qualityScore:project.qualityScore,scannedFiles:project.scannedFiles,updatedAt:project.updatedAt,findings:project.findings || [],history:project.history || []}));
  // Every workspace remains its own record. All-time is an aggregate across
  // those records plus live outcome evidence; switching folders never erases a
  // previous project's assessment.
  for(const assessment of projects) for(const finding of assessment.findings) global[finding.label]=(global[finding.label] || 0) + (finding.count || 0);
  for(const signature of profile.signatures) global[signature.name || signature.id]=(global[signature.name || signature.id] || 0) + (signature.recurrence || 0);
  for(const event of profile.events.filter(e=>e.type==='DIAGNOSTIC')) for(const category of event.classes || []) global[titleCase(category)]=(global[titleCase(category)] || 0)+1;
  const learning=(profile.hypotheses || []).slice(-4).map(item => ({
    category:item.category || 'personal pattern', state:item.state || 'insufficient_evidence',
    statement:item.statement || 'HypoTrace is still comparing possible explanations.',
    prediction:item.prediction || 'More similar outcomes are needed.', probe:item.probe || 'No small check is ready yet.',
    counterevidence:item.counterevidence || []
  }));
  return {global:Object.entries(global).map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value).slice(0,8),professional:profile.professionalProfile || null,project,learning};
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
  </style></head><body><h1>HypoTrace</h1><p class="muted">A private AI coach that turns your coding history into clear next steps.</p><section class="hero"><div class="eyebrow">Your developer dashboard</div><h2>See what to improve, why it matters, and how you are progressing.</h2><button id="projectTab" class="active" onclick="showProject()">Current project</button><button id="profileTab" onclick="showProfile()">All-time personal profile</button><button onclick="send('scan')">Refresh this project</button><div id="view"></div></section><script>
  const vscode=acquireVsCodeApi(),data=${data},colors=['#64b5ff','#a88bff','#57d2ae','#f3c969','#ff8e8e','#6ee7d8','#d9a7ff','#8cd17d'];
  function send(command){vscode.postMessage({command})} function esc(v){return String(v||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
  function issueBars(items){if(!items.length)return '<p class="muted">No clear issues were found in the latest scan.</p>';let max=Math.max(...items.map(x=>x.count||0),1);return '<p class="muted">Number of times each issue was found in the latest scan. A longer bar means it appeared more often.</p>'+items.map((x,i)=>{let n=x.count||0;return '<div class="bar-row" title="'+esc(x.suggestion)+'"><b>'+esc(x.label)+'</b><div class="track"><div class="fill" style="width:'+Math.max(4,Math.round(n/max*100))+'%;background:'+colors[i%colors.length]+';animation-delay:'+(i*.08)+'s"></div></div><span class="bar-value">'+n+' finding'+(n===1?'':'s')+'</span></div>'}).join('')}
  function dimensionBars(items){if(!items.length)return '<p class="muted">More coding history is needed before HypoTrace can assess your skills.</p>';return '<p class="muted">Each score is an AI coaching estimate from your own evidence. It is not a hiring score.</p>'+items.map((x,i)=>'<div class="bar-row" title="'+esc(x.evidence)+'"><b>'+esc(x.label)+'</b><div class="track"><div class="fill" style="width:'+Math.max(3,x.score||0)+'%;background:'+colors[i%colors.length]+';animation-delay:'+(i*.08)+'s"></div></div><span class="bar-value">'+Math.round(x.score)+'% · '+esc(x.trend)+'</span></div>').join('')}
  function trend(history,key,empty){if(history.length<2)return '<p class="muted">'+empty+'</p>';let values=history.map(x=>x[key]||0),lo=Math.min(...values),hi=Math.max(...values),span=Math.max(1,hi-lo),pts=values.map((n,i)=>(i*100/(values.length-1)).toFixed(1)+','+(84-(n-lo)*63/span).toFixed(1)).join(' '),dots=values.map((n,i)=>'<circle cx="'+(i*100/(values.length-1)).toFixed(1)+'" cy="'+(84-(n-lo)*63/span).toFixed(1)+'" r="2.8" fill="#64b5ff" style="animation-delay:'+(i*.13)+'s"><title>Assessment '+(i+1)+': '+Math.round(n)+'/100</title></circle>').join('');return '<svg class="line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Score changes from earlier to latest assessment"><line x1="0" y1="90" x2="100" y2="90" stroke="currentColor" opacity=".22"/><polyline points="'+pts+'" fill="none" stroke="#64b5ff" stroke-width="2.8" vector-effect="non-scaling-stroke"/>'+dots+'</svg><div class="chart-labels"><span>Earlier assessment</span><span>Latest assessment</span></div>'}
  function donut(items,score){if(!items.length)return '<div class="donut" style="background:var(--edge)"><b>—</b></div>';let total=Math.max(1,items.reduce((n,x)=>n+Math.max(1,x.score),0)),at=0,parts=[],legend=[];items.forEach((x,i)=>{let end=at+Math.max(1,x.score)/total*100;parts.push(colors[i%colors.length]+' '+at+'% '+end+'%');legend.push('<span><i class="dot" style="background:'+colors[i%colors.length]+'"></i>'+esc(x.label)+'</span>');at=end});return '<div class="donut" style="background:conic-gradient('+parts.join(',')+')"><b>'+Math.round(score||0)+'</b></div><div class="legend">'+legend.join('')+'</div>'}
  function showProject(){projectTab.classList.add('active');profileTab.classList.remove('active');const p=data.project;if(!p){view.innerHTML='<h2>Current project</h2><p class="muted">Your first project scan is starting. Select Refresh this project if it does not finish shortly.</p>';return}const f=p.findings||[];view.innerHTML='<div class="grid"><article class="card"><div class="eyebrow">Project health</div><h3>'+esc(p.name)+'</h3><div class="score">'+Math.round(p.qualityScore||0)+'/100</div><p class="muted">A rough snapshot from '+p.scannedFiles+' source files. It improves as the project improves.</p></article><article class="card"><div class="eyebrow">Start here</div><h3>'+esc(p.nextFocus||'Keep building evidence')+'</h3><p>'+((p.strengths||[]).map(x=>'<span class="pill">'+esc(x)+'</span>').join('')||'<span class="pill">Strengths will appear with more evidence</span>')+'</p></article></div><div class="grid"><article class="card"><div class="eyebrow">What needs attention</div><h3>Issues found in this project</h3>'+issueBars(f)+'</article><article class="card"><div class="eyebrow">Project progress</div><h3>How this project has changed</h3>'+trend(p.history||[],'qualityScore','Refresh this project once more later to see a progress line.')+'</article></div><article class="card"><div class="eyebrow">Plain-language advice</div><h3>How to improve this project</h3>'+f.map(x=>'<div class="finding"><b>'+esc(x.label)+'</b><br><span class="muted">'+esc(x.suggestion)+'</span></div>').join('')+'<p class="muted">'+esc(p.summary)+'</p></article>'}
  function showProfile(){projectTab.classList.remove('active');profileTab.classList.add('active');const p=data.professional;if(!p){view.innerHTML='<h2>All-time personal profile</h2><p class="muted">Creating your personal growth profile from your own saved coding evidence…</p>';send('profile');return}const d=p.dimensions||[],work=d.filter(x=>x.trend==='needs_attention'||x.score<60);view.innerHTML='<div class="grid"><article class="card"><div class="eyebrow">Overall growth snapshot</div><div class="donut-wrap">'+donut(d,p.readinessScore)+'<p class="muted">Personal growth snapshot /100</p></div></article><article class="card"><div class="eyebrow">Your profile, in simple words</div><h3>'+esc(p.summary)+'</h3><p><b>Best next step:</b> '+esc(p.nextFocus)+'</p><p>'+((p.strengths||[]).map(x=>'<span class="pill">'+esc(x)+'</span>').join('')||'<span class="pill">Strengths will appear with more evidence</span>')+'</p></article></div><div class="grid"><article class="card"><div class="eyebrow">Your skill map</div><h3>What you are strong at and building</h3>'+dimensionBars(d)+'</article><article class="card"><div class="eyebrow">Areas to work on</div><h3>Practice these next</h3>'+((work.length?work:[{label:p.nextFocus||'Keep collecting evidence',evidence:'HypoTrace needs more repeated work before it can identify a weak area.'}]).map(x=>'<div class="action"><b>'+esc(x.label)+'</b><br><span class="muted">'+esc(x.evidence)+'</span></div>').join(''))+'</article></div><div class="grid"><article class="card"><div class="eyebrow">Your progress</div><h3>How your overall profile is changing</h3>'+trend(p.history||[],'readinessScore','Refresh your profile after more coding activity to see a progress line.')+'</article><article class="card"><div class="eyebrow">How to read this</div><h3>Clear and personal</h3><p class="muted">The dashboard uses only your own saved semantic outcomes and AI assessments. Scores go up or down when your coding evidence changes.</p></article></div>'}
  showProject();
  </script></section></body></html>`;
}

function dashboardHtml(profile) {
  return modernDashboardHtmlV2(profile);
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const cards = profile.signatures.map(s => `<article><h3>${esc(s.name)}</h3><p><b>${s.recurrence}</b> episodes · ${esc(s.trend)}${s.suppressed?' · alerts paused':''} · live risk <b>${Math.round((s.risk||risk(profile))*100)}%</b></p><small>${esc(s.sector || s.contexts.join(' · '))}</small></article>`).join('') || '<article><h3>Watching for patterns</h3><p>Start a session and work normally. Only semantic aggregates are retained.</p></article>';
  const battle = profile.hypotheses.map(h => `<article class="${h.state}"><span>${esc(h.id)} · ${esc(h.state)}</span><h3>${esc(h.statement)}</h3><p>${esc(h.prediction)}</p><p class="muted">Confidence ${Math.round(h.confidence*100)}% · ${esc(h.counterevidence?.[0] || 'Evidence: '+h.evidence?.join(', '))}</p></article>`).join('') || '<p>Two rival hypotheses will appear after recurrent semantic episodes.</p>';
  const predictions = profile.predictions.map(p => `<tr><td>${esc(p.id)}</td><td>${Math.round(p.probability*100)}%</td><td>${esc(p.mode)}</td><td>${p.realized === null ? 'open' : p.realized ? 'true prediction' : 'false alarm'}</td></tr>`).join('') || '<tr><td colspan="4">No forecasts yet</td></tr>';
  const transfer = profile.transfer.map(t => `<li>${esc(t.task)} — <b>${esc(t.result)}</b> (${esc(t.mechanism)})</li>`).join('');
  const skill = profile.skills.map(s => `<li><b>${esc(s.id)} v${s.version}</b> · ${esc(s.status)} · transfer ${Math.round(s.transfer*100)}% · retention ${Math.round(s.retention*100)}% · evidence ${s.evidence}</li>`).join('') || '<li>Candidate skills are created after an agent identifies a testable intervention.</li>';
  const evolution = profile.evolution.map(e => `<li><b>${esc(e.skill)}</b> — ${esc(e.event)}<br><small>${esc(e.reason)} · utility ${esc(e.utility ?? 'pending')}</small></li>`).join('') || '<li>No evolution event yet.</li>';
  const mei = selectMEI(profile);
  const observer=profile.observability || {};
  const graph = profile.concepts.map(([node,parents]) => `<li><b>${esc(node)}</b>${parents.length ? ` ← ${esc(parents.join(', '))}` : ''}</li>`).join('');
  const dis = clamp((profile.transfer.filter(x=>x.result==='passed').length / Math.max(1,profile.transfer.length))*.35 + (profile.retention[0]?.score||0)*.3 + (profile.milestone.progress/profile.milestone.total)*.2 + (1-Math.min(1,profile.events.filter(e=>e.type==='ASSIST_REQUEST').length/5))*.15);
  const assessmentJson=JSON.stringify(assessmentData(profile)).replace(/</g,'\\u003c');
  // The dashboard deliberately exposes only the live, per-workspace assessment
  // and the all-time aggregate.  The previous fixed “learning graph” demo
  // panels are not part of the product surface.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:var(--vscode-foreground);padding:18px;max-width:1100px;margin:auto}h1{margin:0}h2{margin-top:28px;color:var(--vscode-textLink-foreground)}.sub,.muted{opacity:.72}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}article{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:14px;background:var(--vscode-editor-background)}article h3{margin:7px 0}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:5px;padding:8px 12px;margin:4px;cursor:pointer}button.active{outline:2px solid var(--vscode-focusBorder)}.metric{font-size:27px;font-weight:700}.hero{padding:18px;border:1px solid var(--vscode-focusBorder);border-radius:12px;background:linear-gradient(135deg,color-mix(in srgb,var(--vscode-editor-background) 82%,#1667b7),var(--vscode-editor-background))}.chart{width:100%;min-height:170px}.finding{border-left:4px solid #d9a441;margin:8px 0;padding:8px 12px;background:var(--vscode-textBlockQuote-background)}.finding.high{border-color:#ef5350}.pill{display:inline-block;padding:3px 8px;border-radius:12px;background:var(--vscode-badge-background);margin:2px;font-size:12px}</style></head><body>
  <h1>HypoTrace</h1><p class="sub">Personal AI coding assessment · semantic-only evidence</p>
  <section class="hero"><h2 style="margin-top:0">Your learning overview</h2><p>Current project is based only on this opened workspace. All-time combines separately saved assessments across your workspaces.</p><button id="projectTab" class="active" onclick="renderAssessment('project')">Current project: this workspace</button><button id="globalTab" onclick="renderAssessment('global')">All-time personal profile</button><button onclick="send('scan')">Refresh current workspace assessment</button><div id="assessment"></div></section>
  <section><h2>How this stays personal</h2><p class="sub">Each workspace has an independent assessment. Your all-time view aggregates your own saved workspace results and observed outcomes; it never substitutes another user's profile.</p></section>
  <script>const vscode=acquireVsCodeApi();const data=${assessmentJson};function send(command){vscode.postMessage({command})}function esc(v){return String(v||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}function bars(items){if(!items.length)return '<p class="muted">No supported issues in this assessment yet.</p>';const max=Math.max(...items.map(x=>x.value||x.count||0),1);return '<div class="chart">'+items.map((x,i)=>'<div style="display:grid;grid-template-columns:minmax(110px,1fr) 5fr 36px;gap:8px;align-items:center;margin:10px 0"><small>'+esc(x.label)+'</small><div style="height:16px;background:var(--vscode-editorWidget-border);border-radius:8px;overflow:hidden"><div style="width:'+Math.max(4,Math.round(((x.value||x.count)/max)*100))+'%;height:100%;background:hsl('+(205+i*31)%360+' 72% 56%)"></div></div><b>'+Math.round(x.value||x.count)+'</b></div>').join('')+'</div>'}function trend(history){if(history.length<2)return '<p class="muted">Trend appears after two or more assessments of this workspace.</p>';const values=history.map(x=>x.qualityScore);const min=Math.min(...values),max=Math.max(...values),span=Math.max(1,max-min);const pts=values.map((v,i)=>(i*(100/(values.length-1))).toFixed(1)+','+(88-(v-min)*72/span).toFixed(1)).join(' ');return '<svg class="chart" viewBox="0 0 100 100" preserveAspectRatio="none"><line x1="0" y1="90" x2="100" y2="90" stroke="currentColor" opacity=".25"/><polyline points="'+pts+'" fill="none" stroke="#4ea1ff" stroke-width="3" vector-effect="non-scaling-stroke"/></svg>'}function projectCards(){if(!data.projects.length)return '<p class="muted">No workspace has been assessed yet.</p>';return '<div class="grid">'+data.projects.map(p=>'<article><h3>'+esc(p.name)+'</h3><p class="metric">'+Math.round(p.qualityScore||0)+'/100</p><small>'+p.scannedFiles+' files · '+esc(p.updatedAt)+'</small><p>'+trend(p.history||[])+'</p></article>').join('')+'</div>'}function renderAssessment(mode){globalTab.classList.toggle('active',mode==='global');projectTab.classList.toggle('active',mode==='project');if(mode==='global'){assessment.innerHTML='<h3>All-time personal profile</h3><p class="sub">A comparison of your separately assessed workspaces. A card name identifies the workspace it belongs to.</p>'+bars(data.global)+'<h3>Workspace comparison</h3>'+projectCards();return}const p=data.project;if(!p){assessment.innerHTML='<h3>Current project: this workspace</h3><p class="muted">No assessment has completed for this workspace yet. HypoTrace starts one automatically; you can also select Refresh current workspace assessment.</p>';return}const findings=p.findings||[];assessment.innerHTML='<div class="grid"><article><h3>Current workspace: '+esc(p.name)+'</h3><p class="metric">'+Math.round(p.qualityScore||0)+'/100</p><small>AI code-health snapshot · '+p.scannedFiles+' files · '+esc(p.updatedAt)+'</small></article><article><h3>Suggested next focus</h3><p>'+esc(p.nextFocus)+'</p><p>'+((p.strengths||[]).map(x=>'<span class="pill">'+esc(x)+'</span>').join('')||'<span class="pill">No strengths measured yet</span>')+'</p></article></div><h3>Current-workspace issue distribution</h3>'+bars(findings)+'<h3>Current-workspace trend</h3>'+trend(p.history||[])+'<h3>AI recommendations</h3>'+ (findings.map(x=>'<div class="finding '+esc(x.severity)+'"><b>'+esc(x.label)+'</b> · '+esc(x.count)+' signal'+(x.count===1?'':'s')+'<br><span class="muted">'+esc(x.suggestion)+'</span></div>').join('')||'<p class="muted">No supported issues in the latest scan.</p>')+'<p class="sub">'+esc(p.summary)+'</p>'}renderAssessment('project')</script></body></html>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:var(--vscode-foreground);padding:18px;max-width:1200px;margin:auto}h1{margin:0}h2{margin-top:28px;color:var(--vscode-textLink-foreground)}.sub,.muted{opacity:.72}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}article{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:14px;background:var(--vscode-editor-background)}article h3{margin:7px 0}.supported{border-left:4px solid #55b987}.contested{border-left:4px solid #d9a441}span{font-size:12px;text-transform:uppercase;letter-spacing:.08em;opacity:.75}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:5px;padding:8px 12px;margin:4px;cursor:pointer}button.active{outline:2px solid var(--vscode-focusBorder)}table{width:100%;border-collapse:collapse}td,th{padding:9px;border-bottom:1px solid var(--vscode-panel-border);text-align:left}.metric{font-size:24px;font-weight:700}.hero{padding:18px;border:1px solid var(--vscode-focusBorder);border-radius:12px;background:linear-gradient(135deg,color-mix(in srgb,var(--vscode-editor-background) 82%,#1667b7),var(--vscode-editor-background))}.chart{width:100%;min-height:230px}.finding{border-left:4px solid #d9a441;margin:8px 0;padding:8px 12px;background:var(--vscode-textBlockQuote-background)}.finding.high{border-color:#ef5350}.pill{display:inline-block;padding:3px 8px;border-radius:12px;background:var(--vscode-badge-background);margin:2px;font-size:12px}</style></head><body>
  <h1>HypoTrace</h1><p class="sub">Predictive cognitive debugger · ${profile.privacy} · intervention budget: ${profile.interventionBudget}</p>
  <section class="hero"><h2 style="margin-top:0">Your learning overview</h2><p>AI-generated assessment from normal coding evidence. Switch between your all-time profile and the current project.</p><button id="globalTab" class="active" onclick="renderAssessment('global')">All-time personal profile</button><button id="projectTab" onclick="renderAssessment('project')">Current project</button><button onclick="send('scan')">Refresh project assessment</button><div id="assessment"></div></section>
  <h2>1–3. Behavioral evidence → Developer Learning Graph → signature</h2><div class="grid">${cards}<article><h3>Personal-agent connection</h3><p><b>${observer.terminalCommands || 0}</b> normal terminal outcomes captured · <b>${observer.shellIntegratedTerminals || 0}</b> shell-integrated terminals seen</p><p><b>${observer.aiInspections || 0}</b> transient AI code inspections · <b>${observer.backendEpisodes || 0}</b> semantic episodes acknowledged</p><small>Last outcome: ${esc(observer.lastOutcome || 'none')} · backend: ${esc(observer.lastBackend || 'not contacted')}</small></article><article><h3>Privacy boundary</h3><p>Raw keystrokes, clipboard contents, and private files are never stored. AI inspection code is transient and never written to the learning database.</p><small>${profile.events.length} semantic events · ${profile.episodes.length} episodes</small></article></div>
  <h2>4–5. Hypothesis battle</h2><div class="grid">${battle}</div>
  <h2>6–7. Pre-failure forecast and intervention</h2><div class="grid"><article><h3>Why this warning</h3><p>${last(profile.predictions)?.rationale?.join(' · ') || 'Need live semantic evidence.'}</p><p class="metric">${Math.round(risk(profile)*100)}% <small>current risk</small></p></article><article><h3>Intervention lab</h3><p>${last(profile.experiments)?.intervention || 'Constraint extraction, counterexample, and execution trace are available.'}</p><p>${last(profile.experiments)?.evidence || 'Use Explain & coach only when you explicitly approve sharing the active file.'}</p></article></div>
  <h2>8–9. Transfer, retention, debt, strengths, effectiveness</h2><div class="grid"><article><h3>Transfer test</h3><ul>${transfer || '<li>Not scheduled</li>'}</ul><p class="metric">${Math.round(dis*100)} <small>developer independence</small></p></article><article><h3>Learning debt</h3><p>${profile.debt.map(x=>esc(x.name)+' · '+esc(x.level)).join('<br>')}</p><h3>Strength genome</h3><p>${profile.strengths.map(x=>esc(x.name)+' · '+esc(x.state)).join('<br>')}</p></article><article><h3>Retention & milestone</h3><p>${profile.retention.map(x=>esc(x.concept)+' '+Math.round(x.score*100)+'% · '+esc(x.due)).join('<br>')}</p><p>${esc(profile.milestone.label)}: ${profile.milestone.progress}/${profile.milestone.total}</p></article></div>
  <h2>Self-evolving intervention skills</h2><div class="grid"><article><h3>Minimum Effective Intervention</h3><p>${mei ? `${esc(mei.id)} v${mei.version} · ${esc(mei.status)}` : 'No eligible skill'}</p><p>${esc(mei?.procedure || 'Run Agent A/B first.')}</p><small>Utility ${mei ? skillUtility(mei).toFixed(2) : '—'}: transfer + retention + recovery − cost − dependence.</small></article><article><h3>Skill competition</h3><ul>${skill}</ul></article></div><h3>Evolution ledger</h3><article><ul>${evolution}</ul><p class="muted">Skills may be promoted, mutated into a constrained variant, held, or retired. Immediate success alone never promotes a skill.</p></article>
  <h2>Prerequisite learning graph</h2><article><ul>${graph}</ul><p class="muted">Recommended upstream repair: ${esc(profile.debt[0]?.prerequisite || 'No active debt')}.</p></article>
  <h2>10. Prediction audit</h2><table><thead><tr><th>ID</th><th>Risk</th><th>Mode</th><th>Outcome</th></tr></thead><tbody>${predictions}</tbody></table>
  <script>const vscode=acquireVsCodeApi();const data=${assessmentJson};function send(command){vscode.postMessage({command})}function esc(v){return String(v||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}function bars(items){if(!items.length)return '<p class="muted">No evidence yet. Work normally and HypoTrace will build this profile.</p>';const max=Math.max(...items.map(x=>x.value||x.count||0),1);return '<div class="chart">'+items.map((x,i)=>'<div style="display:grid;grid-template-columns:minmax(110px,1fr) 5fr 36px;gap:8px;align-items:center;margin:10px 0"><small>'+esc(x.label)+'</small><div style="height:16px;background:var(--vscode-editorWidget-border);border-radius:8px;overflow:hidden"><div style="width:'+Math.max(4,Math.round(((x.value||x.count)/max)*100))+'%;height:100%;background:hsl('+(205+i*31)%360+' 72% 56%)"></div></div><b>'+Math.round(x.value||x.count)+'</b></div>').join('')+'</div>'}function trend(history){if(history.length<2)return '<p class="muted">The learning trend appears after at least two assessments.</p>';const values=history.map(x=>x.qualityScore);const min=Math.min(...values),max=Math.max(...values),span=Math.max(1,max-min);const pts=values.map((v,i)=>(i*(100/(values.length-1))).toFixed(1)+','+(88-(v-min)*72/span).toFixed(1)).join(' ');return '<svg class="chart" viewBox="0 0 100 100" preserveAspectRatio="none"><line x1="0" y1="90" x2="100" y2="90" stroke="currentColor" opacity=".25"/><polyline points="'+pts+'" fill="none" stroke="#4ea1ff" stroke-width="3" vector-effect="non-scaling-stroke"/></svg>'}function projectCards(){if(!data.projects.length)return '<p class="muted">No workspace has been assessed yet.</p>';return '<div class="grid">'+data.projects.map(p=>'<article><h3>'+esc(p.name)+'</h3><p class="metric">'+Math.round(p.qualityScore||0)+'/100</p><small>'+p.scannedFiles+' files · '+esc(p.updatedAt)+'</small><p>'+trend(p.history||[])+'</p></article>').join('')+'</div>'}function renderAssessment(mode){globalTab.classList.toggle('active',mode==='global');projectTab.classList.toggle('active',mode==='project');if(mode==='global'){assessment.innerHTML='<h3>All-time personal profile</h3><p class="sub">Aggregated from every workspace assessed since HypoTrace was installed. Each project remains separate below.</p>'+bars(data.global)+'<h3>Workspace comparison</h3>'+projectCards();return}const p=data.project;if(!p){assessment.innerHTML='<h3>Current project</h3><p class="muted">No project assessment yet. Select Refresh project assessment for this opened workspace.</p>';return}const findings=p.findings||[];assessment.innerHTML='<div class="grid"><article><h3>'+esc(p.name)+'</h3><p class="metric">'+Math.round(p.qualityScore||0)+'/100</p><small>AI code-health snapshot · '+p.scannedFiles+' files · '+esc(p.updatedAt)+'</small></article><article><h3>Suggested next focus</h3><p>'+esc(p.nextFocus)+'</p><p>'+((p.strengths||[]).map(x=>'<span class="pill">'+esc(x)+'</span>').join('')||'<span class="pill">No strengths measured yet</span>')+'</p></article></div><h3>Current-project issue distribution</h3>'+bars(findings)+'<h3>Project learning trend</h3>'+trend(p.history||[])+'<h3>AI recommendations</h3>'+ (findings.map(x=>'<div class="finding '+esc(x.severity)+'"><b>'+esc(x.label)+'</b> · '+esc(x.count)+' signal'+(x.count===1?'':'s')+'<br><span class="muted">'+esc(x.suggestion)+'</span></div>').join('')||'<p class="muted">No supported issues in the latest scan.</p>')+'<p class="sub">'+esc(p.summary)+'</p>'}renderAssessment('global')</script></body></html>`;
}

function openDashboard(context) {
  try {
    const panel = vscode.window.createWebviewPanel('hypotraceDashboard', 'HypoTrace Learning Dashboard', vscode.ViewColumn.Beside, { enableScripts: true });
    const render = () => panel.webview.html = dashboardHtml(getProfile(context)); render();
    panel.webview.onDidReceiveMessage(async ({ command }) => {
      const commands={reset:'hypotrace.reset',scan:'hypotrace.scanWorkspace'};
      if(command==='profile') await refreshProfessionalProfile(context,{quiet:true});
      else if(commands[command]) { await vscode.commands.executeCommand(commands[command]); if(command==='scan') await refreshProfessionalProfile(context,{quiet:true}); }
      render();
    });
    // A new workspace should behave like a fresh personal context: open the
    // dashboard and its first assessment begins automatically. Existing
    // workspace records are preserved for the all-time comparison.
    const key=workspaceAssessmentKey(); const profile=getProfile(context);
    if(key && !profile.projectAssessments?.[key]) {
      assessWorkspace(context,{quiet:true}).then(async ()=>{ await refreshProfessionalProfile(context,{quiet:true}); render(); });
    } else if (!profile.professionalProfile && Object.keys(profile.projectAssessments || {}).length) {
      refreshProfessionalProfile(context,{quiet:true}).then(()=>render());
    }
  } catch (error) { vscode.window.showErrorMessage(`HypoTrace dashboard could not open: ${error.message}`); }
}

async function offerProbe(context) {
  const p = getProfile(context); if (!p.active) return vscode.window.showInformationMessage('Start a HypoTrace session first.');
  const signature=p.predictions.find(x=>x.realized===null)?.signature || p.signatures.filter(s=>!s.suppressed).sort((a,b)=>(b.risk||0)-(a.risk||0))[0]?.id;
  const kind=String(signature || '').replace(/^FS-/,'');
  const probes={
    syntax:{prompt:'15-second syntax check: after a Python def/for/if header, which character completes the header?',placeHolder:'Type one character',correct:answer=>String(answer).trim()===':',label:'Header-delimiter check'},
    boundary:{prompt:'15-second boundary check: for an array of length n, write the legal index interval before coding.',placeHolder:'Example: 0 ≤ i < n',correct:answer=>/0.*[≤<]=?\s*i\s*<\s*n|0.*<=?\s*i\s*<\s*n/i.test(answer||''),label:'Legal-index interval check'},
    assertion:{prompt:'15-second assertion check: name the expected behavior your assertion is verifying.',placeHolder:'Example: empty input returns an empty list',correct:answer=>String(answer||'').trim().length>=8,label:'Expected-behavior check'},
    performance:{prompt:'15-second performance check: state the expected time complexity before adding another loop.',placeHolder:'Example: O(n log n)',correct:answer=>/o\s*\(/i.test(answer||''),label:'Complexity expectation check'},
    representation:{prompt:'15-second type check: state the input type and the expected output type.',placeHolder:'Example: list of ints → integer',correct:answer=>String(answer||'').trim().length>=8,label:'Input/output contract check'},
    logic:{prompt:'15-second invariant check: state one condition that must remain true after this step.',placeHolder:'One short invariant',correct:answer=>String(answer||'').trim().length>=8,label:'Invariant check'}
  };
  const probe=probes[kind] || probes.logic; const answer=await vscode.window.showInputBox({prompt:probe.prompt,placeHolder:probe.placeHolder}); if(answer===undefined)return;
  const correct=probe.correct(answer);
  p.experiments.push({ id:`X-${Date.now()}`, intervention:probe.label, outcome:correct?'learner supplied a relevant check':'check was incomplete', recurrenceDelta:correct?-.2:0, interruptions:1, signature:signature||'unclassified' });
  p.milestone.progress = Math.min(p.milestone.total, p.milestone.progress + (correct ? 1 : 0)); p.interventionBudget = Math.max(0, p.interventionBudget - 1); await save(context,p);
  vscode.window.showInformationMessage(correct ? 'Probe recorded. No solution or code was shown.' : 'Probe recorded. Try stating the check before continuing.');
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
async function runAgents(context) {
  const apiKey = await context.secrets.get('hypotrace.openai.apiKey');
  if (!apiKey) { vscode.window.showWarningMessage('Configure your OpenAI API key first; it is never saved in settings.'); return; }
  const p = getProfile(context); const episodes = sanitizedEpisodes(p);
  if (episodes.length < 2) { vscode.window.showWarningMessage('HypoTrace needs at least two semantic episodes before it can form competing hypotheses. Load the demo or continue a session.'); return; }
  const model = vscode.workspace.getConfiguration('hypotrace').get('openAIModel', 'gpt-5-mini');
  const signature = p.signatures[0] || {id:'FS-candidate',name:'candidate repair trajectory'};
  await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'HypoTrace: Agent A is proposing testable hypotheses…'}, async () => {
    try {
      const embedded = p.episodes.slice(-8);
      for (const episode of embedded) {
        if (!episode.embedding) episode.embedding = await embedEpisode(apiKey, episode.trace);
      }
      const latest = last(embedded);
      const cosine = (a,b) => { let dot=0,aa=0,bb=0; for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];} return dot/(Math.sqrt(aa)*Math.sqrt(bb)||1); };
      if (latest?.embedding) {
        const near = embedded.filter(e=>e.id!==latest.id && e.embedding).map(e=>({id:e.id,similarity:cosine(latest.embedding,e.embedding)})).sort((a,b)=>b.similarity-a.similarity).slice(0,3);
        latest.nearestEpisodes = near;
      }
      const proposal = await runHypothesisAgent(apiKey, model, episodes, signature);
      const created = proposal.hypotheses.map((h,i) => ({id:`H-${Date.now()}-${i+1}`,state:'candidate',confidence:h.confidence,statement:h.statement,mechanism:h.mechanism_type,prediction:h.testable_prediction,evidence:h.supporting_episode_ids,counterevidence:h.counterevidence_episode_ids,intervention:h.candidate_intervention,probe:h.diagnostic_probe}));
      const first = created[0];
      const challenge = await runFalsifierAgent(apiKey, model, episodes, first);
      first.state = 'contested'; first.confidence = clamp(first.confidence + challenge.recommended_confidence_delta);
      first.counterevidence = [...first.counterevidence, ...challenge.strongest_counterevidence]; first.confounds = challenge.confounds; first.discriminatingTest = challenge.discriminating_test; first.alternatives = challenge.alternative_explanations; first.intervention = challenge.recommended_intervention;
      p.hypotheses.push(...created); p.hypotheses = p.hypotheses.slice(-8);
      const skill={id:`S-${Date.now()}`,version:1,status:'candidate',trigger:signature.id,procedure:first.intervention,mechanism:first.mechanism,transfer:0,retention:0,recovery:0,dependence:0,cost:.1,falsePositive:0,evidence:0};
      p.skills.push(skill); p.evolution.unshift({at:now(),skill:`${skill.id} v1`,event:'candidate created',reason:'Agent A proposed an intervention and Agent B supplied a challenge plan.',utility:0});
      await save(context,p); vscode.window.showInformationMessage(`Agent A proposed ${created.length} hypotheses; Agent B contested ${first.id}.`);
    } catch (error) { vscode.window.showErrorMessage(`HypoTrace AI call failed: ${error.message}`); }
  });
}
async function addReasonNote(context) {
  const note = await vscode.window.showInputBox({prompt:'Optional, private reasoning note (1–2 sentences). Only its presence and a local category are used; the note text is discarded.',placeHolder:'Example: I will establish the legal index interval first.'});
  if (!note) return;
  const category = /constraint|bound|invariant|interval/i.test(note) ? 'constraint_check' : /trace|state|step/i.test(note) ? 'state_trace' : 'plan';
  record(context,{type:'REASON_NOTE',category}); vscode.window.showInformationMessage('Reasoning-note category recorded; text was discarded.');
}
function coachHtml(result) {
  const esc = value => String(value || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  return `<!doctype html><style>body{font:15px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:24px;line-height:1.55;max-width:780px}h1{color:#4ea1ff}h2{font-size:15px;margin:22px 0 4px;color:#8ec5ff}pre{white-space:pre-wrap;background:#1f2937;padding:14px;border-radius:8px}</style><h1>HypoTrace Code Coach</h1><h2>Likely issue</h2><p>${esc(result.diagnosis)}</p><h2>Why it happened</h2><p>${esc(result.why_it_happened)}</p><h2>Smallest fix</h2><pre>${esc(result.minimal_fix)}</pre><h2>Build the skill</h2><p>${esc(result.learning_focus)}</p><h2>Practice independently</h2><p>${esc(result.practice_prompt)}</p><p><small>This explanation is a suggestion, not a guaranteed diagnosis. Verify it with a small test.</small></p>`;
}
async function explainAndCoach(context) {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) return vscode.window.showInformationMessage('Open the code file you want HypoTrace to explain.');
  if (isPrivate(doc)) return vscode.window.showWarningMessage('HypoTrace will not send a private-file path to an AI service.');
  const apiKey = await context.secrets.get('hypotrace.openai.apiKey');
  if (!apiKey) return vscode.window.showWarningMessage('Configure your OpenAI API key first.');
  const permission = await vscode.window.showWarningMessage(`Send the current ${doc.languageId} file to OpenAI once for a code explanation and learning plan?`, {modal:true}, 'Send once');
  if (permission !== 'Send once') return;
  const model = vscode.workspace.getConfiguration('hypotrace').get('openAIModel','gpt-5-mini');
  await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'HypoTrace: analyzing the current code…'}, async () => {
    try {
      const result = await runCodeCoach(apiKey,model,doc.languageId,doc.getText(),{semanticEpisode:last(getProfile(context).episodes),focus:'Help the developer recognize and avoid the mechanism on a new task.'});
      const panel=vscode.window.createWebviewPanel('hypotraceCoach','HypoTrace Code Coach',vscode.ViewColumn.Beside,{}); panel.webview.html=coachHtml(result);
      const p=getProfile(context); p.experiments.push({id:`X-${Date.now()}`,intervention:'Opt-in code explanation and independent practice',outcome:'coaching delivered',recurrenceDelta:0,interruptions:1,evidence:'Awaiting transfer task'}); await save(context,p);
    } catch (error) { vscode.window.showErrorMessage(`HypoTrace coach failed: ${error.message}`); }
  });
}
async function openFeatureTestLab() {
  const scenarios = [
    ['Easy syntax — first failure', 'HypoTrace Easy Syntax 1'], ['Easy syntax — second failure', 'HypoTrace Easy Syntax 2'], ['Easy syntax — forecast opportunity', 'HypoTrace Easy Syntax Forecast'], ['Easy syntax — clean recovery', 'HypoTrace Easy Syntax Clean'],
    ['Medium boundary — first failure', 'HypoTrace Medium Boundary 1'], ['Medium boundary — second failure', 'HypoTrace Medium Boundary 2'], ['Medium boundary — forecast opportunity', 'HypoTrace Medium Boundary Forecast'], ['Medium boundary — clean recovery', 'HypoTrace Medium Boundary Clean'],
    ['Advanced algorithm — first failure', 'HypoTrace Advanced Algorithm 1'], ['Advanced algorithm — second failure', 'HypoTrace Advanced Algorithm 2'], ['Advanced algorithm — forecast opportunity', 'HypoTrace Advanced Algorithm Forecast'], ['Advanced algorithm — clean recovery', 'HypoTrace Advanced Algorithm Clean']
  ];
  const pick = await vscode.window.showQuickPick(scenarios.map(([label, task]) => ({label,task})), {placeHolder:'Run a real test task. HypoTrace receives its actual pass/fail result.'});
  if (!pick) return;
  const task = (await vscode.tasks.fetchTasks()).find(item => item.name === pick.task);
  if (!task) return vscode.window.showErrorMessage('Feature-test tasks were not found. Open the HypoTrace project folder, then reload VS Code.');
  await vscode.tasks.executeTask(task);
}
async function toggleGhostMode(context) { const p=getProfile(context); p.ghostMode=!p.ghostMode; await save(context,p); vscode.window.showInformationMessage(`Ghost Mode ${p.ghostMode?'enabled: forecasts will be silent.':'disabled: eligible forecasts may offer a probe.'}`); }
async function falseMasteryChallenge(context) {
  const p=getProfile(context); const answer=await vscode.window.showQuickPick(['A boundary invariant must remain true after every pointer move','I solved a similar task before'],{placeHolder:'False-mastery check: choose the statement that can be tested on a new task.'}); if(!answer)return;
  const pass=answer.startsWith('A boundary'); const knowledge=p.knowledge[0] || (p.knowledge[0]={concept:'Boundary representation',explicit:0,spontaneous:0,state:'unobserved'}); knowledge.state=pass?'applied':'false mastery suspected'; knowledge.spontaneous=clamp(knowledge.spontaneous+(pass?.12:-.16)); if(!pass)p.debt[0]={name:'Boundary representation',level:'high',prerequisite:'Array bounds'}; await save(context,p); vscode.window.showInformationMessage(pass?'Structural understanding supported.':'Prior success did not establish transferable mastery.');
}
function openReplay(context) {
  const p=getProfile(context); const h=last(p.hypotheses); const panel=vscode.window.createWebviewPanel('hypotraceReplay','HypoTrace Counterfactual Replay',vscode.ViewColumn.Beside,{enableScripts:true});
  panel.webview.html=`<!doctype html><style>body{font:14px system-ui;padding:20px}li{margin:12px 0}button{padding:8px}</style><h1>Break Wrong Intuition</h1><p>Hypothesis: ${String(h?.statement||'Load a demo or run agents first.').replace(/[<>&]/g,'')}</p><ol><li>Task opened</li><li>Implementation started <b>before an explicit constraint check</b></li><li>Diagnostic / repair loop appears</li><li>Counterfactual: record the legal interval, then choose the next action</li></ol><button id=b>Prediction checkpoint: I would verify the invariant</button><p id=o></p><script>const v=acquireVsCodeApi();b.onclick=()=>{o.textContent='Evidence recorded: prediction before reveal. No code or solution shown.';v.postMessage({type:'checkpoint'})}</script>`;
  panel.webview.onDidReceiveMessage(()=>record(context,{type:'REASON_NOTE',category:'counterfactual_prediction'}));
}

async function prepareNormalRunObservation() {
  // Make the supported VS Code command lifecycle available by default. An
  // explicit user-level `false` is respected; we do not override it.
  const config=vscode.workspace.getConfiguration('terminal.integrated');
  const inspection=config.inspect('shellIntegration.enabled');
  if (inspection?.globalValue === false || inspection?.workspaceValue === false) return;
  if (inspection?.globalValue === undefined && inspection?.workspaceValue === undefined) {
    await config.update('shellIntegration.enabled', true, vscode.ConfigurationTarget.Global);
  }
}
function ensureBundledBackend(context) {
  const url=String(vscode.workspace.getConfiguration('hypotrace').get('backendUrl','')).replace(/\/$/,'');
  if (url !== 'http://127.0.0.1:8787') return;
  const server=path.join(context.extensionPath,'backend','server.py');
  if (!fs.existsSync(server)) return;
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath,{recursive:true});
    const python=process.env.HYPOTRACE_PYTHON || (fs.existsSync('/opt/homebrew/bin/python3.12') ? '/opt/homebrew/bin/python3.12' : 'python3');
    const child=spawn(python,[server],{cwd:path.dirname(server),env:{...process.env,HYPOTRACE_DB:path.join(context.globalStorageUri.fsPath,'hypotrace.db')},stdio:'ignore',windowsHide:true});
    child.on('error',()=>{});
    context.subscriptions.push({dispose:()=>{ if(!child.killed) child.kill(); }});
  } catch (_) { /* Local Python is optional; diagnostics still work offline. */ }
}

function activate(context) {
  // Discard the former seeded-demo state: a personal profile begins with real
  // evidence only.
  let profile=getProfile(context);
  if (profile.version < 2 || profile.isDemo || profile.sessions.some(session=>session.id==='demo-session')) {
    profile=initialProfile(); save(context,profile);
  }
  context._hypotraceStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  context.subscriptions.push(context._hypotraceStatus);
  updateStatus(context,profile);
  prepareNormalRunObservation().catch(()=>{});
  ensureBundledBackend(context);
  for (const doc of vscode.workspace.textDocuments) scheduleAiInspection(context,doc);
  context.subscriptions.push(vscode.commands.registerCommand('hypotrace.openDashboard', () => openDashboard(context)));
  context.subscriptions.push(vscode.commands.registerCommand('hypotrace.scanWorkspace', () => assessWorkspace(context)));
  // An opened source project gets one bounded assessment. Later refreshes are
  // user-driven; editing never rescans the entire project on every keystroke.
  if (vscode.workspace.getConfiguration('hypotrace').get('projectAssessmentOnOpen',true)) setTimeout(()=>assessWorkspace(context,{quiet:true}),3500);
  context.subscriptions.push(vscode.commands.registerCommand('hypotrace.reset', async () => { const choice=await vscode.window.showWarningMessage('Erase the local HypoTrace profile?', {modal:true}, 'Reset'); if(choice==='Reset'){await save(context,initialProfile());vscode.window.showInformationMessage('Local profile reset.');} }));
  let lastSemanticAt = Date.now();
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async e => { if(!isPrivate(e.document) && e.contentChanges.length) { const elapsed=Date.now()-lastSemanticAt; if(elapsed>1500) record(context,{type:'PAUSE',durationMs:elapsed}); const delta=e.contentChanges.reduce((n,c)=>n+c.text.length-c.rangeLength,0); record(context,{type:delta<0?'REVERT':'EDIT_BURST',charsDelta:delta,language:e.document.languageId}); scheduleAiInspection(context,e.document); lastSemanticAt=Date.now(); } }));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => scheduleAiInspection(context,doc)));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => { if(editor) scheduleAiInspection(context,editor.document); }));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(e => { if(!isPrivate(e.textEditor.document)) { const elapsed=Date.now()-lastSemanticAt; if(elapsed>3000) record(context,{type:'PAUSE',durationMs:elapsed}); record(context,{type:'NAVIGATION',selections:e.selections.length}); lastSemanticAt=Date.now(); } }));
  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(e => { for(const uri of e.uris){if(!isPrivate(uri)){const ds=vscode.languages.getDiagnostics(uri); if(ds.length){const doc=vscode.workspace.textDocuments.find(x=>x.uri.toString()===uri.toString()); analyzeOutcome(context,ds.map(d=>d.message).join('\n'),doc?.languageId || 'text','VS Code language service');}}} }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {if(!isPrivate(doc))record(context,{type:'RUN_OR_SAVE',language:doc.languageId});}));
  context.subscriptions.push(vscode.debug.onDidStartDebugSession(() => record(context,{type:'DEBUG_STEP',phase:'start'})));
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => record(context,{type:'DEBUG_STEP',phase:'end'})));
  context.subscriptions.push(vscode.tasks.onDidStartTask(e => record(context,{type:'RUN_OR_SAVE',category:'task',task:e.execution.task.name})));
  context.subscriptions.push(vscode.tasks.onDidEndTaskProcess(e => { const task=e.execution.task; if(e.exitCode === 0) record(context,{type:'RUN_OR_SAVE',category:'task',task:task.name,outcome:'pass'}); else analyzeOutcome(context,`Task exited with status ${e.exitCode}: ${task.name}`,'task','VS Code task'); }));
  // Prefer command-lifecycle shell integration over terminal-byte scraping. It
  // gives one outcome per normal command and prevents repeated alerts while the
  // developer is simply typing or a traceback is streaming.
  installShellExecutionObserver(context);
}
function deactivate() {}
module.exports = { activate, deactivate };
