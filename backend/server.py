"""HypoTrace personal learning backend.

The only endpoint that accepts source code is /v1/inspect.  It holds the
snippet in memory for one OpenAI request and deliberately never writes it,
terminal output, identifiers, or file names to SQLite.  Everything retained is
a small semantic label, evidence score, and recovery score for one user.
"""
import json, math, os, platform, socket, sqlite3, ssl, subprocess, time, urllib.error, urllib.request
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
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.executescript("""
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at REAL NOT NULL,
        trace TEXT NOT NULL, categories TEXT NOT NULL, features TEXT NOT NULL, embedding TEXT
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
    """)
    # Existing hackathon databases predate recovery scoring.
    try: con.execute("ALTER TABLE signatures ADD COLUMN recoveries INTEGER NOT NULL DEFAULT 0")
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
        # Status is sufficient for diagnosis (401 invalid key, 429 quota/rate
        # limit, etc.). Do not return headers, body, credentials, or model data.
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

def agent_hypotheses(episodes, category):
    # Agent A proposes explanations from privacy-filtered behavior only.
    proposed = response_json(
        "You are Hypothesis Agent A for developer learning. Given privacy-filtered behavioral episodes, propose exactly two competing, non-clinical, falsifiable explanations. Write in plain language for a developer: say what may be happening, what a future observation would support it, and one small check. Never generate code or claim certainty.",
        {"category":category,"episodes":episodes}, "hypotheses", HYPOTHESES_SCHEMA).get("hypotheses", [])
    if len(proposed) != 2: return []
    # Agent B receives A's candidates and must try to disprove each one.
    reviewed = response_json(
        "You are Falsifier Agent B. Challenge each proposed behavioral hypothesis using only the supplied privacy-filtered episodes. Mark each supported, contested, or insufficient_evidence; identify what could disprove it in plain language. Never generate code.",
        {"category":category,"episodes":episodes,"proposals":proposed}, "falsification", FALSIFICATION_SCHEMA).get("assessments", [])
    return [{**proposal, **(reviewed[index] if index < len(reviewed) else {"state":"insufficient_evidence","counterevidence":[]})} for index, proposal in enumerate(proposed)]

def category_name(category):
    # The category comes from the semantic observer or similarity retrieval;
    # this only turns that learned label into readable UI text.
    return category.replace("runtime-", "").replace("-", " ").replace("_", " ").title() + " repeated pattern"

def process_episode(body):
    user = body.get("user_id", "anonymous")
    episode = body["episode"]
    trace = episode["trace"][:5000]
    kind = episode.get("kind", "diagnostic")
    categories = list(dict.fromkeys(episode.get("categories") or []))
    if not categories:
        return {"signatures":[],"forecast":None,"backend":"openai" if OPENAI_KEY else "persistence-only"}
    vector = episode.get("features", [])
    vector_embedding = embedding(trace)
    con = db()
    con.execute("INSERT OR REPLACE INTO episodes VALUES (?,?,?,?,?,?,?)", (episode["id"],user,time.time(),trace,json.dumps(categories),json.dumps(vector),json.dumps(vector_embedding) if vector_embedding else None))
    result = {"signatures":[],"forecast":None,"backend":"openai" if OPENAI_KEY else "persistence-only"}
    for observed_category in categories:
        # Retrieve from all past diagnostics rather than a fixed list of error
        # types. Similar embeddings let a new LLM label join an existing
        # personal pattern when the underlying failure mechanism is alike.
        candidates = con.execute("SELECT * FROM episodes WHERE user_id=? AND trace LIKE '%episode_kind: diagnostic%' AND id<>? ORDER BY created_at DESC LIMIT 60", (user, episode["id"])).fetchall()
        ranked = []
        for prior in candidates:
            prior_categories = json.loads(prior["categories"])
            similarity = cosine(vector_embedding, json.loads(prior["embedding"])) if vector_embedding and prior["embedding"] else 0
            if observed_category in prior_categories or similarity >= .78:
                ranked.append((similarity, prior, prior_categories))
        ranked.sort(key=lambda item: item[0], reverse=True)
        previous = [item[1] for item in ranked[:12]]
        similarities = [item[0] for item in ranked]
        similar = len(ranked)
        category = observed_category
        if ranked and ranked[0][0] >= .78 and ranked[0][2]:
            category = ranked[0][2][0]
        row = con.execute("SELECT * FROM signatures WHERE user_id=? AND category=?", (user,category)).fetchone()
        prior_count = row["count"] if row else 0
        prior_recoveries = row["recoveries"] if row else 0
        count = prior_count + 1 if kind == "diagnostic" else prior_count
        recoveries = prior_recoveries + 1 if kind == "recovery" else prior_recoveries
        # A user's score rises with independently observed recurrence and falls
        # only after repeated resolved, comparable decisions.  It is a personal
        # calibration score, not a generic error probability.
        evidence = max(0, count - recoveries * .70)
        learned = evidence >= 2
        risk = min(.95, max(.05, .16 + .20*evidence + .22*(max(similarities) if similarities else 0) + .08*min(similar,3)))
        # Two prior, same-category episodes are enough to make the next related
        # editing opportunity worth a minimal forecast, even while calibration grows.
        if learned: risk = max(.72, risk)
        hypotheses = json.loads(row["hypotheses"]) if row else []
        if kind == "diagnostic" and count >= 2 and not hypotheses:
            compact = [{"id":r["id"],"trace":r["trace"]} for r in previous[:4]] + [{"id":episode["id"],"trace":trace}]
            hypotheses = agent_hypotheses(compact, category)
            if hypotheses:
                con.execute("INSERT INTO hypothesis_reviews(user_id,category,created_at,episode_ids,review) VALUES (?,?,?,?,?)", (user, category, time.time(), json.dumps([item["id"] for item in compact]), json.dumps(hypotheses)))
        display_name=str(episode.get("label") or (row["name"] if row else category_name(category)))[:180]
        if kind in ("diagnostic", "recovery"):
            con.execute("INSERT INTO signatures(user_id,category,name,count,risk,recoveries,hypotheses) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,category) DO UPDATE SET name=excluded.name,count=excluded.count,risk=excluded.risk,recoveries=excluded.recoveries,hypotheses=excluded.hypotheses", (user,category,display_name,count,risk,recoveries,json.dumps(hypotheses)))
        entry = {"category":category,"name":display_name,"count":count,"recoveries":recoveries,"risk":risk,"hypotheses":hypotheses,"learned":learned}
        result["signatures"].append(entry)
        # Forecast only on a matching decision point after two diagnostic examples.
        if kind == "opportunity" and learned and risk >= .70: result["forecast"] = entry
    con.commit(); con.close()
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

def learned_profile(con, user):
    rows=con.execute("SELECT category,name,count,recoveries,risk FROM signatures WHERE user_id=?", (user,)).fetchall()
    return [{"category":r["category"],"name":r["name"],"failures":r["count"],"recoveries":r["recoveries"],"risk":r["risk"]} for r in rows]

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
      "Return clear for ordinary/incomplete typing or unrelated code. Do not invent a generic warning. "
      "Use a concise semantic category that describes the mechanism, not a language error name when a deeper mechanism is evident. "
      "The response must not quote source, identifiers, paths, or secrets."
    )
    result=response_json(instructions, {"language":language,"cursor_line":body.get("cursor_line",0),"personal_patterns":profile,"current_code":code}, "personal_code_observation", INSPECTION_SCHEMA)
    state=result.get("state", "clear")
    category=str(result.get("category", "")).strip().lower().replace(" ", "-")[:80]
    if state == "clear" or not category: return {"state":"clear","backend":"openai"}
    # Do not let a model make the first warning. It may report a concrete
    # failure, but forecast eligibility is calculated from this user's DB.
    row=next((x for x in profile if x["category"] == category), None)
    if state == "risk_opportunity" and not row: return {"state":"clear","backend":"openai"}
    return {"state":state,"category":category,"label":str(result.get("label", "Personal recurrence pattern"))[:180],"confidence":float(result.get("confidence",0)),"decision":str(result.get("decision", "current code decision"))[:220],"explanation":str(result.get("explanation", ""))[:300],"backend":"openai"}

def inspect_outcome(body):
    """Turn a real diagnostic/test outcome into a semantic observation.

    The raw message and current code are request-only inputs.  Neither is ever
    added to an episode or stored in SQLite.
    """
    if not OPENAI_KEY: return {"state":"clear","backend":"key_not_configured"}
    raw=str(body.get("outcome", ""))[:9000]
    if not raw.strip(): return {"state":"clear","backend":"openai"}
    user=body.get("user_id", "anonymous"); con=db(); profile=learned_profile(con,user); con.close()
    instructions=(
      "You are HypoTrace's outcome observer. Convert a temporary compiler, language-server, test, or runtime outcome into one concise semantic failure mechanism. "
      "Do not quote code, names, paths, secrets, or terminal text. Do not produce a fix. "
      "Return failure_present only when the supplied outcome supports a concrete failure; otherwise clear. "
      "Use a specific semantic category, never a generic fixed list."
    )
    result=response_json(instructions,{"language":str(body.get("language","text"))[:40],"outcome":raw,"personal_patterns":profile},"outcome_observation",INSPECTION_SCHEMA)
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

class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, payload):
        data=json.dumps(payload).encode(); self.send_response(code); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_POST(self):
        try:
            size=int(self.headers.get("Content-Length","0")); body=json.loads(self.rfile.read(size))
            if self.path == "/v1/episodes": return self.send_json(200,process_episode(body))
            if self.path == "/v1/inspect": return self.send_json(200,inspect_code(body))
            if self.path == "/v1/outcome": return self.send_json(200,inspect_outcome(body))
            if self.path == "/v1/project-assessment": return self.send_json(200,inspect_project(body))
            if self.path == "/v1/professional-profile": return self.send_json(200,assess_professional_profile(body))
            return self.send_json(404,{"error":"not found"})
        except Exception as error: return self.send_json(500,{"error":str(error)})
    def do_GET(self):
        if self.path == "/health": return self.send_json(200,{"ok":True,"openai_configured":bool(OPENAI_KEY),"key_source":KEY_SOURCE})
        if self.path == "/v1/verify": return self.send_json(200,verify_openai_key())
        return self.send_json(404,{"error":"not found"})
    def log_message(self, *_): pass

if __name__ == "__main__":
    db().close(); print(f"HypoTrace backend on http://127.0.0.1:8787 (OpenAI: {KEY_SOURCE})")
    ThreadingHTTPServer(("127.0.0.1",8787),Handler).serve_forever()
