"""HypoTrace personal learning backend.

The only endpoint that accepts source code is /v1/inspect.  It holds the
snippet in memory for one OpenAI request and deliberately never writes it,
terminal output, identifiers, or file names to SQLite.  Everything retained is
a small semantic label, evidence score, and recovery score for one user.
"""
import hashlib, json, math, os, platform, random, socket, sqlite3, ssl, subprocess, time, urllib.error, urllib.request
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(__file__)
DB_PATH = os.environ.get("HYPOTRACE_DB", os.path.join(ROOT, "hypotrace.db"))
KEYCHAIN_SERVICE = os.environ.get("HYPOTRACE_KEYCHAIN_SERVICE", "HypoTrace.OpenAI")

def load_openai_key():
    """Prefer an explicit environment variable, then macOS Keychain.

    The key is never written to SQLite, logs, settings, or this repository.
    Keychain lookup is intentionally best-effort so the backend remains portable
    on non-macOS systems and can still use OPENAI_API_KEY in deployed services.
    """
    environment_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if environment_key:
        return environment_key, "environment"
    if platform.system() != "Darwin":
        return "", "missing"
    try:
        result = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-a", os.environ.get("USER", ""), "-s", KEYCHAIN_SERVICE, "-w"],
            check=True, capture_output=True, text=True, timeout=5
        )
        key = result.stdout.strip()
        return key, "keychain" if key else "missing"
    except (OSError, subprocess.SubprocessError):
        return "", "missing"

OPENAI_KEY, KEY_SOURCE = load_openai_key()
MODEL = os.environ.get("HYPOTRACE_MODEL", "gpt-5-mini")
BACKEND_REVISION = "0.7.9"

def trusted_tls_context():
    """Use an installed CA bundle while preserving full TLS verification.

    The python.org macOS runtime can be installed without a populated OpenSSL
    certificate directory even though macOS supplies /etc/ssl/cert.pem.  We do
    not disable verification; this just explicitly selects that trusted bundle.
    """
    candidates=[os.environ.get("SSL_CERT_FILE", "")]
    try:
        import certifi
        candidates.append(certifi.where())
    except ImportError:
        pass
    candidates.extend(["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"])
    for bundle in candidates:
        if bundle and os.path.isfile(bundle):
            return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()

TLS_CONTEXT = trusted_tls_context()

def db():
    con = sqlite3.connect(DB_PATH, timeout=8)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=8000")
    con.executescript("""
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at REAL NOT NULL,
        trace TEXT NOT NULL, categories TEXT NOT NULL, features TEXT NOT NULL, embedding TEXT,
        workspace_id TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS run_observations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at REAL NOT NULL,
        trace TEXT NOT NULL, categories TEXT NOT NULL, features TEXT NOT NULL,
        embedding TEXT, workspace_id TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS signatures (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, category TEXT NOT NULL,
        name TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, risk REAL NOT NULL DEFAULT 0,
        recoveries INTEGER NOT NULL DEFAULT 0, hypotheses TEXT NOT NULL DEFAULT '[]', UNIQUE(user_id, category)
      );
      CREATE TABLE IF NOT EXISTS outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, signature_id INTEGER,
        outcome TEXT NOT NULL, created_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hypothesis_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, category TEXT NOT NULL,
        created_at REAL NOT NULL, episode_ids TEXT NOT NULL, review TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS intervention_trials (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        category TEXT NOT NULL, title TEXT NOT NULL, modality TEXT NOT NULL,
        status TEXT NOT NULL, outcome TEXT, created_at REAL NOT NULL, completed_at REAL,
        arm_id TEXT, forecast_id TEXT, policy_draw REAL, self_report TEXT
      );
      CREATE TABLE IF NOT EXISTS forecast_records (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        category TEXT NOT NULL, probability REAL NOT NULL, created_at REAL NOT NULL,
        resolved_at REAL, outcome INTEGER, decision_context TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS intervention_arms (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        category TEXT NOT NULL, title TEXT NOT NULL, modality TEXT NOT NULL,
        prompt TEXT NOT NULL, input_hint TEXT NOT NULL,
        alpha REAL NOT NULL DEFAULT 1, beta REAL NOT NULL DEFAULT 1,
        offered INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
        total_cost REAL NOT NULL DEFAULT 0, last_used_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_pattern_stats (
        user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, category TEXT NOT NULL,
        failures INTEGER NOT NULL DEFAULT 0, recoveries INTEGER NOT NULL DEFAULT 0,
        last_failure_at REAL, last_recovery_at REAL,
        confidence_history TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY(user_id, workspace_id, category)
      );
      CREATE TABLE IF NOT EXISTS signature_clusters (
        user_id TEXT NOT NULL, signature_category TEXT NOT NULL,
        member_category TEXT NOT NULL, similarity REAL NOT NULL, seen_at REAL NOT NULL,
        PRIMARY KEY(user_id, signature_category, member_category)
      );
      CREATE TABLE IF NOT EXISTS learning_events (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        category TEXT NOT NULL, event_type TEXT NOT NULL, evidence TEXT NOT NULL,
        created_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retention_checks (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        category TEXT NOT NULL, due_at REAL NOT NULL, status TEXT NOT NULL,
        created_at REAL NOT NULL, completed_at REAL
      );
      CREATE TABLE IF NOT EXISTS learning_models (
        user_id TEXT PRIMARY KEY, model TEXT NOT NULL, updated_at REAL NOT NULL
      );
    """)
    try: con.execute("ALTER TABLE signatures ADD COLUMN recoveries INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError: pass
    try: con.execute("ALTER TABLE episodes ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''")
    except sqlite3.OperationalError: pass
    for column, definition in (("arm_id","TEXT"),("forecast_id","TEXT"),("policy_draw","REAL"),("self_report","TEXT")):
        try: con.execute(f"ALTER TABLE intervention_trials ADD COLUMN {column} {definition}")
        except sqlite3.OperationalError: pass
    return con

def openai(path, payload, timeout=25):
    if not OPENAI_KEY:
        return None
    request = urllib.request.Request("https://api.openai.com" + path,
        data=json.dumps(payload).encode(), headers={"Content-Type":"application/json", "Authorization":"Bearer " + OPENAI_KEY}, method="POST")
    with urllib.request.urlopen(request, timeout=timeout, context=TLS_CONTEXT) as response:
        return json.loads(response.read())

def verify_openai_key():
    """Perform an authenticated OpenAI API check without returning a secret."""
    if not OPENAI_KEY:
        return {"valid":False,"reason":"key_not_configured","key_source":KEY_SOURCE}
    request = urllib.request.Request(
        "https://api.openai.com/v1/models",
        headers={"Authorization":"Bearer " + OPENAI_KEY}, method="GET"
    )
    try:
        with urllib.request.urlopen(request, timeout=15, context=TLS_CONTEXT) as response:
            return {"valid":200 <= response.status < 300,"key_source":KEY_SOURCE,"status":response.status}
    except urllib.error.HTTPError as error:
        return {"valid":False,"key_source":KEY_SOURCE,"status":error.code,"reason":"openai_rejected_request"}
    except urllib.error.URLError as error:
        cause = error.reason
        if isinstance(cause, ssl.SSLCertVerificationError): reason="tls_certificate_error"
        elif isinstance(cause, socket.timeout): reason="request_timeout"
        else: reason="network_unreachable"
        return {"valid":False,"key_source":KEY_SOURCE,"reason":reason}
    except (TimeoutError, socket.timeout):
        return {"valid":False,"key_source":KEY_SOURCE,"reason":"request_timeout"}
    except OSError:
        return {"valid":False,"key_source":KEY_SOURCE,"reason":"network_unreachable"}

def embedding(trace):
    response = openai("/v1/embeddings", {"model":"text-embedding-3-small", "input":trace})
    return response["data"][0]["embedding"] if response else None

def cosine(a, b):
    if not a or not b: return 0
    return sum(x*y for x,y in zip(a,b)) / (math.sqrt(sum(x*x for x in a))*math.sqrt(sum(y*y for y in b)) or 1)

def response_json(instructions, payload, schema_name, schema, timeout=25):
    if not OPENAI_KEY: return {}
    response = openai("/v1/responses", {"model":MODEL,"store":False,"instructions":instructions,"input":json.dumps(payload),"text":{"format":{"type":"json_schema","name":schema_name,"strict":True,"schema":schema}}}, timeout=timeout)
    text = response.get("output_text") or next((item.get("text") for output in response.get("output",[]) for item in output.get("content",[]) if item.get("type")=="output_text"), "")
    return json.loads(text) if text else {}

HYPOTHESES_SCHEMA = {"type":"object","additionalProperties":False,"required":["hypotheses"],"properties":{"hypotheses":{"type":"array","minItems":2,"maxItems":2,"items":{"type":"object","additionalProperties":False,"required":["statement","prediction","probe"],"properties":{"statement":{"type":"string"},"prediction":{"type":"string"},"probe":{"type":"string"}}}}}}
FALSIFICATION_SCHEMA = {"type":"object","additionalProperties":False,"required":["assessments"],"properties":{"assessments":{"type":"array","minItems":2,"maxItems":2,"items":{"type":"object","additionalProperties":False,"required":["state","counterevidence"],"properties":{"state":{"type":"string","enum":["supported","contested","insufficient_evidence"]},"counterevidence":{"type":"array","items":{"type":"string"}}}}}}}
AGENT_REVIEW_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["hypotheses"],
    "properties": {
        "hypotheses": {
            "type": "array", "minItems": 2, "maxItems": 2,
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["statement", "prediction", "probe", "state", "counterevidence"],
                "properties": {
                    "statement": {"type": "string"}, "prediction": {"type": "string"},
                    "probe": {"type": "string"},
                    "state": {"type": "string", "enum": ["supported", "contested", "insufficient_evidence"]},
                    "counterevidence": {"type": "array", "items": {"type": "string"}}
                }
            }
        }
    }
}
INTERVENTION_SCHEMA = {"type":"object","additionalProperties":False,"required":["title","modality","prompt","input_hint","purpose"],"properties":{"title":{"type":"string"},"modality":{"type":"string"},"prompt":{"type":"string"},"input_hint":{"type":"string"},"purpose":{"type":"string"}}}
INTERVENTION_OPTIONS_SCHEMA = {"type":"object","additionalProperties":False,"required":["options"],"properties":{"options":{"type":"array","minItems":2,"maxItems":3,"items":{"type":"object","additionalProperties":False,"required":["title","modality","prompt","input_hint"],"properties":{"title":{"type":"string"},"modality":{"type":"string"},"prompt":{"type":"string"},"input_hint":{"type":"string"}}}}}}
PROBE_RESULT_SCHEMA = {"type":"object","additionalProperties":False,"required":["state","outcome","evidence"],"properties":{"state":{"type":"string","enum":["supported","contested","insufficient_evidence"]},"outcome":{"type":"string","enum":["helpful","not_yet_helpful","unclear"]},"evidence":{"type":"string"}}}
REPLAY_SCHEMA = {"type":"object","additionalProperties":False,"required":["title","steps","checkpoint"],"properties":{"title":{"type":"string"},"steps":{"type":"array","minItems":3,"maxItems":3,"items":{"type":"string"}},"checkpoint":{"type":"string"}}}

def agent_hypotheses(episodes, category):
    result = response_json(
        "Act as two careful roles for a private developer-learning tool. Agent A proposes exactly two competing, non-clinical, falsifiable explanations from the supplied privacy-filtered episodes. Agent B immediately challenges each proposed explanation using the same evidence and marks it supported, contested, or insufficient_evidence. Use plain language: statement maximum 22 words, prediction maximum 18 words, probe maximum 18 words, and counterevidence one sentence of at most 20 words. Never mention episode IDs, file names, code, error lists, identifiers, intentions, abilities, or psychological causes. Never generate code or claim certainty.",
        {"category":category,"episodes":episodes}, "agent_a_b_review", AGENT_REVIEW_SCHEMA, timeout=45)
    hypotheses = result.get("hypotheses", [])
    return hypotheses if len(hypotheses) == 2 else []

def calibration_summary(con, user, workspace, category):
    """A per-signature Bayesian estimate with an honest evidence label.

    The prior is deliberately neutral.  Every resolved personal forecast moves
    this value, and sparse evidence remains visibly uncertain instead of
    producing a confident-looking percentage.
    """
    rows=con.execute("SELECT probability,outcome FROM forecast_records WHERE user_id=? AND workspace_id=? AND category=? AND outcome IS NOT NULL", (user,workspace,category)).fetchall()
    total=len(rows); failures=sum(int(row["outcome"]) for row in rows)
    mean=(failures + 1) / (total + 2)
    brier=(sum((float(row["probability"])-int(row["outcome"]))**2 for row in rows)/total) if total else None
    spread=math.sqrt(max(0.0, mean*(1-mean)/(total+3)))
    return {"total":total,"failures":failures,"probability":mean,"lower":max(0.0,mean-1.28*spread),"upper":min(1.0,mean+1.28*spread),"brier":brier,"status":"calibrated" if total>=8 else "learning" if total>=3 else "too_little_evidence"}

def personal_interval(con, user):
    """Return a private, data-derived review interval; no category constants."""
    stamps=[row["created_at"] for row in con.execute("SELECT created_at FROM run_observations WHERE user_id=? ORDER BY created_at DESC LIMIT 40", (user,)).fetchall()][::-1]
    gaps=[b-a for a,b in zip(stamps,stamps[1:]) if b>a]
    if len(gaps)<3: return None
    gaps.sort()
    return gaps[len(gaps)//2]

def append_learning_event(con, user, workspace, category, event_type, evidence):
    recent=con.execute("SELECT id FROM learning_events WHERE user_id=? AND workspace_id=? AND category=? AND event_type=? ORDER BY created_at DESC LIMIT 1", (user,workspace,category,event_type)).fetchone()
    if recent: return
    con.execute("INSERT INTO learning_events VALUES (?,?,?,?,?,?,?)", ("L-%d-%d" % (int(time.time()*1000),random.randint(100,999)),user,workspace,category,event_type,evidence[:400],time.time()))

def update_learning_states(con, user, workspace, category, happened):
    """Derive transfer, retention, and false-mastery only from later real runs."""
    now_at=time.time(); interval=personal_interval(con,user)
    prior_recovery=con.execute("SELECT created_at,workspace_id FROM run_observations WHERE user_id=? AND categories LIKE ? AND outcome='recovery' ORDER BY created_at DESC LIMIT 1", (user,'%' + category + '%')).fetchone()
    if happened:
        if prior_recovery and interval and now_at-float(prior_recovery["created_at"]) <= interval*2:
            append_learning_event(con,user,workspace,category,"false_mastery","The same pattern returned soon after a recorded recovery.")
        return []
    events=[]
    other=con.execute("SELECT workspace_id FROM run_observations WHERE user_id=? AND workspace_id<>? AND categories LIKE ? AND outcome='diagnostic' ORDER BY created_at DESC LIMIT 1", (user,workspace,'%' + category + '%')).fetchone()
    if other:
        append_learning_event(con,user,workspace,category,"transfer","A previously seen pattern was repaired in a different workspace.")
        events.append("transfer")
    if prior_recovery and interval and now_at-float(prior_recovery["created_at"]) >= interval:
        append_learning_event(con,user,workspace,category,"retention","A repair held across a personally meaningful time gap.")
        events.append("retention")
    if interval:
        check=con.execute("SELECT id FROM retention_checks WHERE user_id=? AND workspace_id=? AND category=? AND status='pending'", (user,workspace,category)).fetchone()
        if not check:
            con.execute("INSERT INTO retention_checks VALUES (?,?,?,?,?,?,?,?)", ("R-%d-%d" % (int(now_at*1000),random.randint(100,999)),user,workspace,category,now_at+interval,"pending",now_at,None))
    return events

def policy_summary(con, user, workspace, category):
    rows=con.execute("SELECT id,title,alpha,beta,completed,offered FROM intervention_arms WHERE user_id=? AND workspace_id=? AND category=? ORDER BY completed DESC", (user,workspace,category)).fetchall()
    arms=[]
    for row in rows:
        total=float(row["alpha"])+float(row["beta"])
        arms.append({"id":row["id"],"title":row["title"],"trials":row["completed"],"estimated_recovery":round(float(row["alpha"])/total,2),"uncertainty":round(1/math.sqrt(total),2)})
    enough=len(arms)>=2 and min(a["trials"] for a in arms)>=3
    status="collecting_outcomes"
    if enough:
        ranked=sorted(arms,key=lambda x:x["estimated_recovery"],reverse=True)
        gap=ranked[0]["estimated_recovery"]-ranked[-1]["estimated_recovery"]
        status="promoted_for_now" if gap>max(ranked[0]["uncertainty"],ranked[-1]["uncertainty"]) else "continue_comparison"
    return {"method":"randomized private comparison","status":status,"arms":arms}

def forecast_record(body):
    user=str(body.get("user_id","anonymous")); workspace=str(body.get("workspace_id", ""))[:80]
    category=str(body.get("category", ""))[:80]; decision=str(body.get("decision_context", ""))[:180]
    if not category: return {"error":"missing_category"}
    con=db(); summary=calibration_summary(con,user,workspace,category)
    signature=con.execute("SELECT count,recoveries,risk FROM signatures WHERE user_id=? AND category=?", (user,category)).fetchone()
    if not signature: con.close(); return {"error":"unknown_signature"}
    base=float(signature["risk"]); n=summary["total"]
    probability=(base*2 + summary["probability"]*n)/(n+2)
    forecast_id="F-%d-%d" % (int(time.time()*1000),random.randint(100,999))
    con.execute("INSERT INTO forecast_records(id,user_id,workspace_id,category,probability,created_at,decision_context) VALUES (?,?,?,?,?,?,?)", (forecast_id,user,workspace,category,probability,time.time(),decision))
    con.commit(); result={"id":forecast_id,"probability":probability,"calibration":calibration_summary(con,user,workspace,category)}; con.close(); return result

def resolve_forecasts_and_trials(body):
    user=str(body.get("user_id","anonymous")); workspace=str(body.get("workspace_id", ""))[:80]
    category=str(body.get("category", ""))[:80]; happened=bool(body.get("happened"));
    if not category: return {"error":"missing_category"}
    con=db(); now_at=time.time()
    forecasts=con.execute("SELECT id,probability FROM forecast_records WHERE user_id=? AND workspace_id=? AND category=? AND outcome IS NULL ORDER BY created_at ASC", (user,workspace,category)).fetchall()
    if forecasts:
        con.execute("UPDATE forecast_records SET outcome=?,resolved_at=? WHERE id=?", (1 if happened else 0,now_at,forecasts[0]["id"]))
    trials=con.execute("SELECT id,arm_id FROM intervention_trials WHERE user_id=? AND workspace_id=? AND category=? AND status='answered' ORDER BY created_at ASC", (user,workspace,category)).fetchall()
    for trial in trials[:1]:
        reward=0 if happened else 1
        con.execute("UPDATE intervention_trials SET status='measured',outcome=?,completed_at=? WHERE id=?", ('recurred' if happened else 'recovered',now_at,trial["id"]))
        if trial["arm_id"]:
            arm=con.execute("SELECT alpha,beta,completed,total_cost FROM intervention_arms WHERE id=?", (trial["arm_id"],)).fetchone()
            if arm:
                con.execute("UPDATE intervention_arms SET alpha=?,beta=?,completed=?,total_cost=? WHERE id=?", (float(arm["alpha"])+reward,float(arm["beta"])+(1-reward),int(arm["completed"])+1,float(arm["total_cost"])+1,trial["arm_id"]))
    learning_events=update_learning_states(con,user,workspace,category,happened)
    summary=calibration_summary(con,user,workspace,category)
    policy=policy_summary(con,user,workspace,category)
    con.commit(); con.close()
    return {"forecast_id":forecasts[0]["id"] if forecasts else None,"trial_id":trials[0]["id"] if trials else None,"calibration":summary,"learning_events":learning_events,"policy":policy}

def dynamic_intervention(user, workspace, category, hypotheses, episodes, purpose="probe"):
    """Generate candidate checks, then select one using Thompson sampling."""
    prompt=(
        "You design one gentle, single-question developer reflection from privacy-filtered evidence. "
        "The user answers in one short sentence; it is not a task, test, or experiment. "
        "Never ask them to run, save, edit, repeat, change settings, collect logs, or perform multiple steps. "
        "Do not generate code, solutions, task names, identifiers, or claims about ability. "
        "Ask only about one simple decision they made before the last run. Use everyday language, maximum 18 words. "
        "The input hint must show one short example answer."
    )
    trial_id="I-%d" % int(time.time()*1000)
    con=db(); rows=con.execute("SELECT * FROM intervention_arms WHERE user_id=? AND workspace_id=? AND category=? ORDER BY last_used_at DESC LIMIT 3", (user,workspace,category)).fetchall()
    if len(rows)<2:
        options=response_json(prompt+" Create two or three genuinely different short questions.",{"purpose":purpose,"category":category,"hypotheses":hypotheses,"episodes":episodes[-5:]},"intervention_options",INTERVENTION_OPTIONS_SCHEMA).get("options",[])
        if len(options)<2: con.close(); return None
        for option in options:
            clean={key:str(option.get(key,""))[:700] for key in ("title","modality","prompt","input_hint")}
            arm_digest=hashlib.sha256((category + "|" + clean["title"] + "|" + clean["prompt"]).encode()).hexdigest()[:16]
            arm_id="A-%s" % arm_digest
            con.execute("INSERT OR IGNORE INTO intervention_arms(id,user_id,workspace_id,category,title,modality,prompt,input_hint,last_used_at) VALUES (?,?,?,?,?,?,?,?,?)", (arm_id,user,workspace,category,clean["title"],clean["modality"],clean["prompt"],clean["input_hint"],time.time()))
        rows=con.execute("SELECT * FROM intervention_arms WHERE user_id=? AND workspace_id=? AND category=? ORDER BY last_used_at DESC LIMIT 3", (user,workspace,category)).fetchall()
    candidates=[]
    for row in rows:
        clean={key:str(row[key] or "")[:700] for key in ("title","modality","prompt","input_hint")}
        draw=random.betavariate(float(row["alpha"]),float(row["beta"]))
        candidates.append((draw,row,clean))
    draw,row,clean=max(candidates,key=lambda item:item[0])
    con.execute("UPDATE intervention_arms SET offered=offered+1,last_used_at=? WHERE id=?", (time.time(),row["id"]))
    con.execute("INSERT INTO intervention_trials(id,user_id,workspace_id,category,title,modality,status,created_at,arm_id,policy_draw) VALUES (?,?,?,?,?,?,?,?,?,?)",(trial_id,user,workspace,category,clean["title"],clean["modality"],"offered",time.time(),row["id"],draw))
    con.commit()
    policy=policy_summary(con,user,workspace,category)
    con.close()
    return {"id":trial_id,**clean,"purpose":purpose,"policy":{**policy,"arm_id":row["id"],"draw":draw,"completed":row["completed"],"success_rate":float(row["alpha"])/(float(row["alpha"])+float(row["beta"]))}}

def evaluate_probe_result(body):
    user=str(body.get("user_id","anonymous")); trial_id=str(body.get("trial_id", ""))[:100]
    category=str(body.get("category", ""))[:80]; answer=str(body.get("answer", ""))[:1000]
    if not trial_id or not category or not answer.strip(): return {"error":"missing_probe_result"}
    con=db(); row=con.execute("SELECT workspace_id FROM intervention_trials WHERE id=? AND user_id=?",(trial_id,user)).fetchone()
    if not row: con.close(); return {"error":"unknown_probe"}
    reviews=con.execute("SELECT review FROM hypothesis_reviews WHERE user_id=? AND category=? ORDER BY created_at DESC LIMIT 1",(user,category)).fetchone(); con.close()
    hypotheses=json.loads(reviews["review"]) if reviews else []
    result=response_json(
        "You evaluate a developer's short answer to a non-solution diagnostic. Use only the question context, hypotheses, and answer. Do not provide code or a solution. State whether this evidence supports, contests, or is insufficient for the leading explanation, and whether the check seemed helpful in plain language.",
        {"category":category,"hypotheses":hypotheses,"answer":answer},"probe_result",PROBE_RESULT_SCHEMA)
    if not result: return {"error":"AI returned no probe evaluation"}
    con=db(); con.execute("UPDATE intervention_trials SET status=?,self_report=? WHERE id=? AND user_id=?",("answered",result.get("outcome","unclear"),trial_id,user)); con.execute("INSERT INTO hypothesis_reviews(user_id,category,created_at,episode_ids,review) VALUES (?,?,?,?,?)",(user,category,time.time(),json.dumps([trial_id]),json.dumps([{**item,"state":result.get("state","insufficient_evidence"),"counterevidence":([result.get("evidence","")] if result.get("state")=="contested" else item.get("counterevidence",[]))} for item in hypotheses]))); con.commit(); con.close()
    return {"trial_id":trial_id,"category":category,"state":result.get("state"),"outcome":result.get("outcome"),"evidence":str(result.get("evidence", ""))[:500]}

def dynamic_replay(body):
    user=str(body.get("user_id","anonymous")); category=str(body.get("category", ""))[:80]
    con=db(); rows=con.execute("SELECT trace FROM episodes WHERE user_id=? AND categories LIKE ? ORDER BY created_at DESC LIMIT 5",(user,'%' + category + '%')).fetchall(); review=con.execute("SELECT review FROM hypothesis_reviews WHERE user_id=? AND category=? ORDER BY created_at DESC LIMIT 1",(user,category)).fetchone(); con.close()
    if not rows: return {"error":"no_episode_evidence"}
    result=response_json(
        "Create a three-step plain-language explanation from semantic behavior episodes, not source code. "
        "Step 1: what repeated. Step 2: one simple thing to check earlier next time. Step 3: what later run would confirm or challenge that idea. "
        "Use everyday words, at most 18 words per step. Never mention event labels, sessions, diagnostics, run/save, timestamps, code, identifiers, or psychological claims. "
        "The checkpoint must be one short observation, not an instruction or test.",
        {"category":category,"episodes":[row["trace"] for row in rows],"hypotheses":json.loads(review["review"]) if review else []},"dynamic_replay",REPLAY_SCHEMA)
    return result or {"error":"AI returned no replay"}

def category_name(category):
    return category.replace("runtime-", "").replace("-", " ").replace("_", " ").title() + " repeated pattern"

def adaptive_cluster(con, user, observed_category, vector_embedding):
    """Choose a personal signature without a fixed cross-user similarity rule.

    Exact recurring error families are safe cold-start evidence.  Once this user
    has embeddings, each signature gets its own acceptance boundary from its
    observed member similarities.  This lets clusters merge when their own
    evidence converges and remain separate when it does not.
    """
    rows=con.execute("SELECT category FROM signatures WHERE user_id=?", (user,)).fetchall()
    if not vector_embedding or not rows:
        return observed_category, 1.0 if observed_category in [r["category"] for r in rows] else 0.0, "new-or-exact"
    best_category, best_similarity, best_boundary = observed_category, -1.0, None
    for signature in rows:
        category=signature["category"]
        aliases=[category] + [item["member_category"] for item in con.execute("SELECT member_category FROM signature_clusters WHERE user_id=? AND signature_category=?", (user,category)).fetchall()]
        clauses=" OR ".join(["categories LIKE ?"] * len(aliases))
        members=con.execute(f"SELECT embedding FROM run_observations WHERE user_id=? AND ({clauses}) AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT 24", [user] + ['%' + item + '%' for item in aliases]).fetchall()
        scores=[cosine(vector_embedding, json.loads(member["embedding"])) for member in members if member["embedding"]]
        if not scores:
            continue
        scores.sort()
        boundary=scores[max(0, len(scores)//4)]
        candidate=sum(scores) / len(scores)
        if candidate > best_similarity:
            best_category, best_similarity, best_boundary=category, candidate, boundary
    if best_boundary is not None and best_similarity >= best_boundary:
        return best_category, best_similarity, "personal-similarity"
    return observed_category, max(0.0,best_similarity), "new-cluster"

def process_observation(body):
    """Persist one completed run outcome, never a source snapshot.

    Short attempts are useful for recurrence counting but are intentionally not
    called episodes.  Full problem-solving sessions arrive at /v1/episodes.
    """
    user = body.get("user_id", "anonymous")
    episode = body["episode"]
    workspace = str(episode.get("workspace_id", ""))[:80]
    trace = episode["trace"][:5000]
    kind = episode.get("kind", "diagnostic")
    categories = list(dict.fromkeys(episode.get("categories") or []))
    if not categories:
        return {"signatures":[],"forecast":None,"backend":"openai" if OPENAI_KEY else "persistence-only"}
    vector = episode.get("features", [])
    vector_embedding = embedding(trace)
    con = db()
    con.execute("INSERT OR REPLACE INTO run_observations (id,user_id,created_at,trace,categories,features,embedding,workspace_id,outcome) VALUES (?,?,?,?,?,?,?,?,?)", (episode["id"],user,time.time(),trace,json.dumps(categories),json.dumps(vector),json.dumps(vector_embedding) if vector_embedding else None,workspace,kind))
    result = {"signatures":[],"forecast":None,"backend":"openai" if OPENAI_KEY else "persistence-only"}
    for observed_category in categories:
        category, cluster_similarity, cluster_method = adaptive_cluster(con, user, observed_category, vector_embedding)
        con.execute("INSERT INTO signature_clusters(user_id,signature_category,member_category,similarity,seen_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id,signature_category,member_category) DO UPDATE SET similarity=excluded.similarity,seen_at=excluded.seen_at", (user,category,observed_category,cluster_similarity,time.time()))
        aliases=[category] + [item["member_category"] for item in con.execute("SELECT member_category FROM signature_clusters WHERE user_id=? AND signature_category=?", (user,category)).fetchall()]
        clauses=" OR ".join(["categories LIKE ?"] * len(aliases))
        previous=con.execute(f"SELECT * FROM run_observations WHERE user_id=? AND ({clauses}) AND id<>? AND outcome='diagnostic' ORDER BY created_at DESC LIMIT 12", [user] + ['%' + item + '%' for item in aliases] + [episode["id"]]).fetchall()
        similar=len(previous)
        row = con.execute("SELECT * FROM signatures WHERE user_id=? AND category=?", (user,category)).fetchone()
        prior_count = row["count"] if row else 0
        prior_recoveries = row["recoveries"] if row else 0
        count = prior_count + 1 if kind == "diagnostic" else prior_count
        recoveries = prior_recoveries + 1 if kind == "recovery" else prior_recoveries
        observations=count + recoveries
        risk=(count / observations) if observations else 0.0
        learned=count >= 2 and count > recoveries
        hypotheses = json.loads(row["hypotheses"]) if row else []
        display_name=str(episode.get("label") or (row["name"] if row else category_name(category)))[:180]
        if kind in ("diagnostic", "recovery"):
            con.execute("INSERT INTO signatures(user_id,category,name,count,risk,recoveries,hypotheses) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,category) DO UPDATE SET name=excluded.name,count=excluded.count,risk=excluded.risk,recoveries=excluded.recoveries,hypotheses=excluded.hypotheses", (user,category,display_name,count,risk,recoveries,json.dumps(hypotheses)))
            project_row=con.execute("SELECT failures,recoveries,last_failure_at,last_recovery_at,confidence_history FROM project_pattern_stats WHERE user_id=? AND workspace_id=? AND category=?", (user,workspace,category)).fetchone()
            project_failures=(project_row["failures"] if project_row else 0) + (1 if kind == "diagnostic" else 0)
            project_recoveries=(project_row["recoveries"] if project_row else 0) + (1 if kind == "recovery" else 0)
            confidence_history=json.loads(project_row["confidence_history"]) if project_row else []
            confidence_history=(confidence_history + [{"at":time.time(),"risk":risk,"event":kind}])[-40:]
            con.execute("INSERT INTO project_pattern_stats(user_id,workspace_id,category,failures,recoveries,last_failure_at,last_recovery_at,confidence_history) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,workspace_id,category) DO UPDATE SET failures=excluded.failures,recoveries=excluded.recoveries,last_failure_at=excluded.last_failure_at,last_recovery_at=excluded.last_recovery_at,confidence_history=excluded.confidence_history", (user,workspace,category,project_failures,project_recoveries,time.time() if kind == "diagnostic" else (project_row["last_failure_at"] if project_row else None),time.time() if kind == "recovery" else (project_row["last_recovery_at"] if project_row else None),json.dumps(confidence_history)))
        entry = {"category":category,"name":display_name,"count":count,"recoveries":recoveries,"risk":risk,"hypotheses":hypotheses,"learned":learned,"evidence":{"similar_observations":similar,"recoveries":recoveries,"last_event":kind,"cluster_similarity":round(cluster_similarity,3),"cluster_method":cluster_method}}
        result["signatures"].append(entry)
        if kind == "opportunity" and learned: result["forecast"] = entry
    con.commit(); con.close()
    return result

def process_episode(body):
    """Store a completed multi-step learning session and update Agent A/B.

    Episodes are deliberately separate from quick run observations.  This is
    what prevents five rapid test runs from masquerading as five reasoning
    sessions in the personal learning record.
    """
    user=body.get("user_id", "anonymous"); episode=body["episode"]
    trace=str(episode.get("trace", ""))[:5000]; categories=list(dict.fromkeys(episode.get("categories") or []))
    if not categories: return {"signatures":[],"forecast":None,"backend":"openai" if OPENAI_KEY else "persistence-only"}
    con=db(); workspace=str(episode.get("workspace_id", ""))[:80]
    con.execute("INSERT OR REPLACE INTO episodes (id,user_id,created_at,trace,categories,features,embedding,workspace_id) VALUES (?,?,?,?,?,?,?,?)", (episode["id"],user,time.time(),trace,json.dumps(categories),json.dumps(episode.get("features", [])),None,workspace))
    prepared=[]
    for category in categories:
        row=con.execute("SELECT * FROM signatures WHERE user_id=? AND category=?", (user,category)).fetchone()
        if not row:
            matching=con.execute(
                "SELECT outcome FROM run_observations WHERE user_id=? AND categories LIKE ?",
                (user, '%' + category + '%')
            ).fetchall()
            failures=sum(1 for item in matching if item["outcome"] == "diagnostic")
            recoveries=sum(1 for item in matching if item["outcome"] == "recovery")
            total=failures + recoveries
            con.execute(
                "INSERT INTO signatures(user_id,category,name,count,risk,recoveries,hypotheses) VALUES (?,?,?,?,?,?,?)",
                (user, category, category_name(category), failures, (failures / total) if total else 0.0, recoveries, "[]")
            )
            row=con.execute("SELECT * FROM signatures WHERE user_id=? AND category=?", (user,category)).fetchone()
        sessions=con.execute("SELECT id,trace FROM episodes WHERE user_id=? AND categories LIKE ? ORDER BY created_at DESC LIMIT 5", (user,'%' + category + '%')).fetchall()
        hypotheses=json.loads(row["hypotheses"] or '[]')
        review_count=con.execute("SELECT COUNT(*) AS n FROM hypothesis_reviews WHERE user_id=? AND category=?", (user,category)).fetchone()["n"]
        prepared.append({"category":category,"row":dict(row),"sessions":[dict(item) for item in sessions],"review_count":review_count,"hypotheses":hypotheses})
    con.commit(); con.close()

    result={"signatures":[],"forecast":None,"backend":"openai" if OPENAI_KEY else "persistence-only"}
    for item in prepared:
        category=item["category"]; row=item["row"]; sessions=item["sessions"]
        hypotheses=item["hypotheses"]; review_count=item["review_count"]
        if len(sessions) >= 2:
            compact=[{"id":session["id"],"trace":session["trace"]} for session in sessions]
            hypotheses=agent_hypotheses(compact,category)
            for hypothesis in hypotheses:
                if len(sessions) < 3:
                    hypothesis["state"]="insufficient_evidence"
                hypothesis["evidence_session_count"]=len(sessions)
                hypothesis["review_version"]=review_count + 1
                hypothesis["evidence_summary"]=(f"{len(sessions)} full coding sessions, updated after a new session. " + ("Enough session evidence to keep testing this explanation." if len(sessions)>=3 else "Too little session evidence to call this a conclusion."))
            if hypotheses:
                write_con=db()
                write_con.execute("UPDATE signatures SET hypotheses=? WHERE id=?", (json.dumps(hypotheses),row["id"]))
                write_con.execute("INSERT INTO hypothesis_reviews(user_id,category,created_at,episode_ids,review) VALUES (?,?,?,?,?)", (user,category,time.time(),json.dumps([session["id"] for session in sessions]),json.dumps(hypotheses)))
                write_con.commit(); write_con.close()
        result["signatures"].append({"category":category,"name":row["name"],"count":row["count"],"recoveries":row["recoveries"],"risk":row["risk"],"hypotheses":hypotheses,"learned":row["count"]>=2 and row["count"]>row["recoveries"],"evidence":{"full_sessions":len(sessions),"review_version":review_count + (1 if hypotheses else 0),"last_event":"meaningful-session"}})
    return result

INSPECTION_SCHEMA = {"type":"object","additionalProperties":False,"required":["state","category","label","confidence","decision","explanation"],"properties":{
  "state":{"type":"string","enum":["failure_present","risk_opportunity","clear"]},
  "category":{"type":"string"}, "label":{"type":"string"}, "confidence":{"type":"number"},
  "decision":{"type":"string"}, "explanation":{"type":"string"}
}}
PROJECT_SCHEMA = {"type":"object","additionalProperties":False,"required":["summary","quality_score","findings","strengths","next_focus"],"properties":{
  "summary":{"type":"string"}, "quality_score":{"type":"number"}, "next_focus":{"type":"string"},
  "strengths":{"type":"array","items":{"type":"string"}},
  "findings":{"type":"array","maxItems":12,"items":{"type":"object","additionalProperties":False,"required":["category","label","severity","count","suggestion"],"properties":{
    "category":{"type":"string"},"label":{"type":"string"},"severity":{"type":"string","enum":["low","medium","high"]},"count":{"type":"number"},"suggestion":{"type":"string"}
  }}}
}}
PROFESSIONAL_PROFILE_SCHEMA = {"type":"object","additionalProperties":False,"required":["readiness_score","summary","dimensions","strengths","next_focus"],"properties":{
  "readiness_score":{"type":"number"},"summary":{"type":"string"},"next_focus":{"type":"string"},
  "strengths":{"type":"array","items":{"type":"string"}},
  "dimensions":{"type":"array","minItems":3,"maxItems":8,"items":{"type":"object","additionalProperties":False,"required":["id","label","score","trend","evidence"],"properties":{
    "id":{"type":"string"},"label":{"type":"string"},"score":{"type":"number"},"trend":{"type":"string","enum":["improving","steady","needs_attention","insufficient_evidence"]},"evidence":{"type":"string"}
  }}}
}}
LEARNING_MODEL_SCHEMA={"type":"object","additionalProperties":False,"required":["strengths","learning_debt","prerequisites","roadmap"],"properties":{
 "strengths":{"type":"array","maxItems":4,"items":{"type":"object","additionalProperties":False,"required":["label","evidence"],"properties":{"label":{"type":"string"},"evidence":{"type":"string"}}}},
 "learning_debt":{"type":"array","maxItems":4,"items":{"type":"object","additionalProperties":False,"required":["label","evidence","next_step"],"properties":{"label":{"type":"string"},"evidence":{"type":"string"},"next_step":{"type":"string"}}}},
 "prerequisites":{"type":"array","maxItems":4,"items":{"type":"object","additionalProperties":False,"required":["before","then","evidence"],"properties":{"before":{"type":"string"},"then":{"type":"string"},"evidence":{"type":"string"}}}},
 "roadmap":{"type":"array","maxItems":4,"items":{"type":"object","additionalProperties":False,"required":["step","why"],"properties":{"step":{"type":"string"},"why":{"type":"string"}}}}
}}

def learned_profile(con, user):
    rows=con.execute("SELECT category,name,count,recoveries,risk FROM signatures WHERE user_id=?", (user,)).fetchall()
    return [{"category":r["category"],"name":r["name"],"failures":r["count"],"recoveries":r["recoveries"],"risk":r["risk"]} for r in rows]

def dynamic_learning_model(body):
    """A developer model generated only from this user's durable evidence."""
    user=str(body.get("user_id","anonymous")); con=db()
    patterns=learned_profile(con,user)
    events=[dict(row) for row in con.execute("SELECT category,event_type,evidence,workspace_id FROM learning_events WHERE user_id=? ORDER BY created_at DESC LIMIT 30",(user,)).fetchall()]
    checks=[dict(row) for row in con.execute("SELECT category,title,alpha,beta,completed FROM intervention_arms WHERE user_id=? ORDER BY completed DESC LIMIT 12",(user,)).fetchall()]
    if not patterns: con.close(); return {"error":"insufficient_evidence"}
    result=response_json(
        "You build a private developer-growth model from semantic evidence only. Do not seed topics or invent skills. "
        "Return an item only when evidence supports it. A strength needs observed recovery or transfer. Learning debt is a repeated unresolved pattern. "
        "A prerequisite is only valid when the evidence supports an ordering; otherwise return none. Use short, concrete, plain developer language. "
        "The roadmap should be the next 1-4 evidence-backed steps, not a curriculum or a test. Never mention code, paths, projects, identities, or scores.",
        {"patterns":patterns,"learning_events":events,"intervention_evidence":checks},"dynamic_learning_model",LEARNING_MODEL_SCHEMA,timeout=40)
    if result:
        con.execute("INSERT INTO learning_models(user_id,model,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET model=excluded.model,updated_at=excluded.updated_at",(user,json.dumps(result),time.time())); con.commit()
    con.close()
    return result or {"error":"AI returned no learning model"}

def inspect_code(body):
    """Ask the model for a semantic observation; code exists only in this call."""
    if not OPENAI_KEY: return {"state":"clear","backend":"key_not_configured"}
    user=body.get("user_id", "anonymous")
    code=str(body.get("code", ""))[:16000]
    language=str(body.get("language", "text"))[:40]
    if not code.strip(): return {"state":"clear","backend":"openai"}
    con=db(); profile=learned_profile(con,user); con.close()
    instructions=(
      "You are HypoTrace's personal code-learning observer. Inspect the temporary current code only. "
      "Do not generate or repair code. Return failure_present only for a concrete defect visible now. "
      "Return risk_opportunity only when the current line is a meaningful decision that resembles a listed personal learned pattern with at least two failures and more failures than recoveries. "
      "For risk_opportunity, category must exactly equal one category in personal_patterns. If none match exactly, return clear. "
      "Return clear for ordinary/incomplete typing or unrelated code. Do not invent a generic warning. "
      "Use a concise semantic category that describes the mechanism, not a language error name when a deeper mechanism is evident. "
      "The response must not quote source, identifiers, paths, or secrets."
    )
    result=response_json(instructions, {"language":language,"cursor_line":body.get("cursor_line",0),"personal_patterns":profile,"current_code":code}, "personal_code_observation", INSPECTION_SCHEMA)
    state=result.get("state", "clear")
    category=str(result.get("category", "")).strip().lower().replace(" ", "-")[:80]
    if state == "clear" or not category: return {"state":"clear","backend":"openai"}
    row=next((x for x in profile if x["category"] == category), None)
    if state == "risk_opportunity" and (not row or row["failures"] < 2 or row["failures"] <= row["recoveries"]):
        return {"state":"clear","backend":"openai"}
    return {"state":state,"category":category,"label":str(result.get("label", "Personal recurrence pattern"))[:180],"confidence":float(result.get("confidence",0)),"decision":str(result.get("decision", "current code decision"))[:220],"explanation":str(result.get("explanation", ""))[:300],"backend":"openai"}

def inspect_outcome(body):
    """Turn a real diagnostic/test outcome into a semantic observation.

    The raw message and current code are request-only inputs.  Neither is ever
    added to an episode or stored in SQLite.
    """
    if not OPENAI_KEY: return {"state":"clear","backend":"key_not_configured"}
    raw=str(body.get("outcome", ""))[:9000]
    error_lines=[]
    for line in raw.splitlines():
        clean=line.strip()
        if re.search(r'\b(?:SyntaxError|IndentationError|TabError|AssertionError|IndexError|KeyError|TypeError|ValueError|AttributeError|NameError|ImportError|ModuleNotFoundError|RuntimeError|Exception|Error)\b', clean):
            error_lines.append(clean[:500])
    observed="\n".join(error_lines[-4:])
    if not observed: return {"state":"clear","backend":"openai"}
    user=body.get("user_id", "anonymous"); con=db(); profile=learned_profile(con,user); con.close()
    instructions=(
      "You are HypoTrace's outcome observer. Convert a privacy-filtered compiler, language-server, test, or runtime outcome into one concise general failure mechanism. "
      "Use a short mechanism label such as missing-header-delimiter, list-index-out-of-range, expected-output-mismatch, or incompatible-value-shape when supported. Never use algorithm names, task names, function names, identifiers, paths, or details not present in the error class/message. Do not produce a fix. "
      "Return failure_present only when the supplied outcome supports a concrete failure; otherwise clear. "
      "Use the same stable category whenever the same standard error class appears. For example: AssertionError means assertion-failed, SyntaxError means syntax-error, and IndexError means index-out-of-range. "
      "Put additional detail in the label, not in the category. Do not derive a category from comments, task wording, or identifiers. For unfamiliar errors, use one concise mechanism label consistently."
    )
    result=response_json(instructions,{"language":str(body.get("language","text"))[:40],"outcome":observed,"personal_patterns":profile},"outcome_observation",INSPECTION_SCHEMA)
    category=str(result.get("category","")).strip().lower().replace(" ","-")[:80]
    if result.get("state") != "failure_present" or not category: return {"state":"clear","backend":"openai"}
    return {"state":"failure_present","category":category,"label":str(result.get("label","Observed failure mechanism"))[:180],"confidence":float(result.get("confidence",0)),"decision":"observed run or diagnostic outcome","explanation":str(result.get("explanation", ""))[:300],"backend":"openai"}

def inspect_project(body):
    """Produce a temporary project assessment without retaining any source."""
    if not OPENAI_KEY: return {"error":"key_not_configured"}
    user=body.get("user_id", "anonymous")
    files=body.get("files", [])[:24]
    safe_files=[]
    for item in files:
        content=str(item.get("content", ""))[:6000]
        if content.strip(): safe_files.append({"language":str(item.get("language", "text"))[:40],"content":content})
    if not safe_files: return {"summary":"No eligible source files were found yet.","quality_score":0,"findings":[],"strengths":[],"next_focus":"Start coding to build a project assessment.","backend":"openai"}
    con=db(); personal=learned_profile(con,user); con.close()
    instructions=(
      "You are HypoTrace's project assessment agent. Inspect temporary source files from one project. "
      "Do not generate code, quote source, identifiers, paths, or secrets. Return an evidence-based overview only. "
      "Classify actual or strongly supported risks using semantic, project-specific categories; do not force generic syntax or boundary labels. "
      "For algorithm quality, make a cautious suggestion only when the available code demonstrates a credible complexity or correctness concern; otherwise omit it. "
      "The score is a rough code-health snapshot, not a grade. Personal patterns are context only and must not become findings without support in code."
    )
    result=response_json(instructions,{"files":safe_files,"personal_patterns":personal},"project_assessment",PROJECT_SCHEMA,timeout=60)
    if not result: return {"error":"AI returned no structured assessment"}
    result["quality_score"]=max(0,min(100,round(float(result.get("quality_score",0)))))
    result["summary"]=str(result.get("summary", ""))[:500]
    result["next_focus"]=str(result.get("next_focus", ""))[:300]
    result["strengths"]=[str(x)[:160] for x in result.get("strengths",[])[:6]]
    result["findings"]=[{"category":str(x.get("category","")).lower().replace(" ","-")[:80],"label":str(x.get("label", "Finding"))[:180],"severity":x.get("severity","low"),"count":max(1,min(100,int(x.get("count",1)))),"suggestion":str(x.get("suggestion", ""))[:260]} for x in result.get("findings",[]) if x.get("category")]
    result["backend"]="openai"
    return result

def assess_professional_profile(body):
    """Assess personal growth from retained semantic evidence, never source code."""
    if not OPENAI_KEY: return {"error":"key_not_configured"}
    assessments=body.get("assessments", [])[:80]
    outcomes=body.get("outcomes", [])[:80]
    if not assessments and not outcomes:
        return {"error":"insufficient_evidence"}
    instructions=(
      "You are HypoTrace's professional-growth assessment agent. Assess one developer using only privacy-filtered, aggregated observations from their own coding history. "
      "Never claim employability, hiring suitability, seniority, or certainty. Do not mention projects, file names, code, or other people. "
      "Choose 3–8 evidence-supported dimensions such as algorithmic reasoning, code clarity, architecture, testing, debugging, reliability, performance, or security—but choose only dimensions justified by the supplied evidence. "
      "A score is a coaching snapshot, not a grade. Use insufficient_evidence when history does not support a trend. "
      "Write every label, evidence sentence, strength, and next step in short, plain language a developer can act on immediately. Focus on one practical next growth step."
    )
    result=response_json(instructions,{"project_assessments":assessments,"semantic_outcomes":outcomes},"professional_growth_profile",PROFESSIONAL_PROFILE_SCHEMA,timeout=45)
    if not result: return {"error":"AI returned no structured profile"}
    result["readiness_score"]=max(0,min(100,round(float(result.get("readiness_score",0)))))
    result["summary"]=str(result.get("summary", ""))[:500]
    result["next_focus"]=str(result.get("next_focus", ""))[:300]
    result["strengths"]=[str(x)[:160] for x in result.get("strengths",[])[:6]]
    result["dimensions"]=[{"id":str(x.get("id", "dimension")).lower().replace(" ","-")[:80],"label":str(x.get("label","Development dimension"))[:100],"score":max(0,min(100,round(float(x.get("score",0))))),"trend":str(x.get("trend","insufficient_evidence")),"evidence":str(x.get("evidence", ""))[:220]} for x in result.get("dimensions",[])][:8]
    result["backend"]="openai"
    return result

def reset_user_data(body):
    """Erase one user's semantic learning history, never another user's data.

    A reset is deliberately explicit and local.  It removes only the rows whose
    user id was supplied by the installed extension; source code and API keys
    are never present in these tables.
    """
    user_id=str(body.get("user_id", "")).strip()
    if not user_id:
        return {"error":"missing_user_id"}
    tables=(
        "episodes", "run_observations", "signatures", "outcomes",
        "hypothesis_reviews", "intervention_trials", "forecast_records",
        "intervention_arms", "project_pattern_stats", "signature_clusters",
        "learning_events", "retention_checks", "learning_models",
    )
    con=db()
    try:
        for table in tables:
            con.execute(f"DELETE FROM {table} WHERE user_id=?", (user_id,))
        con.commit()
        return {"ok":True, "erased":"personal_semantic_history"}
    finally:
        con.close()

def learning_state(body):
    """Return already-saved semantic reviews for a dashboard that reopens.

    This is a local hydration endpoint: it never sends source code and it lets
    a restarted extension display a review that was completed while its
    webview was closed or while a previous server was being repaired.
    """
    user_id=str(body.get("user_id", "")).strip()
    if not user_id:
        return {"signatures": []}
    con=db()
    try:
        rows=con.execute(
            "SELECT s.category,s.name,s.count,s.risk,s.recoveries,s.hypotheses,r.review "
            "FROM signatures s LEFT JOIN hypothesis_reviews r ON r.id=("
            "SELECT id FROM hypothesis_reviews WHERE user_id=s.user_id AND category=s.category ORDER BY created_at DESC LIMIT 1) "
            "WHERE s.user_id=? ORDER BY s.count DESC LIMIT 30", (user_id,)
        ).fetchall()
        signatures=[]
        for row in rows:
            try: hypotheses=json.loads(row["review"]) if row["review"] else json.loads(row["hypotheses"] or "[]")
            except (TypeError, json.JSONDecodeError): hypotheses=[]
            signatures.append({"category":row["category"],"name":row["name"],"count":row["count"],"risk":row["risk"],"recoveries":row["recoveries"],"hypotheses":hypotheses})
        return {"signatures":signatures}
    finally:
        con.close()

class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, payload):
        data=json.dumps(payload).encode(); self.send_response(code); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_POST(self):
        try:
            size=int(self.headers.get("Content-Length","0")); body=json.loads(self.rfile.read(size))
            if self.path == "/v1/episodes": return self.send_json(200,process_episode(body))
            if self.path == "/v1/observations": return self.send_json(200,process_observation(body))
            if self.path == "/v1/forecasts": return self.send_json(200,forecast_record(body))
            if self.path == "/v1/forecast-outcomes": return self.send_json(200,resolve_forecasts_and_trials(body))
            if self.path == "/v1/inspect": return self.send_json(200,inspect_code(body))
            if self.path == "/v1/outcome": return self.send_json(200,inspect_outcome(body))
            if self.path == "/v1/project-assessment": return self.send_json(200,inspect_project(body))
            if self.path == "/v1/professional-profile": return self.send_json(200,assess_professional_profile(body))
            if self.path == "/v1/learning-model": return self.send_json(200,dynamic_learning_model(body))
            if self.path == "/v1/learning-state": return self.send_json(200,learning_state(body))
            if self.path == "/v1/reset": return self.send_json(200,reset_user_data(body))
            if self.path == "/v1/intervention":
                return self.send_json(200,dynamic_intervention(str(body.get("user_id","anonymous")),str(body.get("workspace_id",""))[:80],str(body.get("category", ""))[:80],body.get("hypotheses",[])[:4],body.get("episodes",[])[:5],str(body.get("purpose","probe"))[:40]) or {"error":"AI returned no intervention"})
            if self.path == "/v1/probe-result": return self.send_json(200,evaluate_probe_result(body))
            if self.path == "/v1/replay": return self.send_json(200,dynamic_replay(body))
            return self.send_json(404,{"error":"not found"})
        except Exception as error: return self.send_json(500,{"error":str(error)})
    def do_GET(self):
        if self.path == "/health": return self.send_json(200,{"ok":True,"revision":BACKEND_REVISION,"openai_configured":bool(OPENAI_KEY),"key_source":KEY_SOURCE})
        if self.path == "/v1/verify": return self.send_json(200,verify_openai_key())
        return self.send_json(404,{"error":"not found"})
    def log_message(self, *_): pass

if __name__ == "__main__":
    port=int(os.environ.get("HYPOTRACE_PORT", "8787"))
    db().close(); print(f"HypoTrace backend on http://127.0.0.1:{port} (OpenAI: {KEY_SOURCE})")
    ThreadingHTTPServer(("127.0.0.1",port),Handler).serve_forever()
