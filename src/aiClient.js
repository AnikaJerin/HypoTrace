/* OpenAI Responses API client. The extension supplies only sanitized episode objects. */
const https = require('https');
const API = 'https://api.openai.com/v1/responses';

function postJson(url, apiKey, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = JSON.stringify(payload);
    const request = https.request({ hostname:target.hostname, path:target.pathname, method:'POST', headers:{
      'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body), 'Authorization':`Bearer ${apiKey}`
    }}, response => {
      let text = '';
      response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let parsed; try { parsed = JSON.parse(text); } catch (_) { return reject(new Error(`OpenAI returned invalid JSON (HTTP ${response.statusCode}).`)); }
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`OpenAI API ${response.statusCode}: ${String(parsed.error?.message || text).slice(0,180)}`));
        resolve(parsed);
      });
    });
    request.on('error', reject); request.write(body); request.end();
  });
}

const hypothesisSchema = {
  type: 'object', additionalProperties: false,
  required: ['hypotheses'], properties: {
    hypotheses: { type: 'array', minItems: 2, maxItems: 3, items: {
      type: 'object', additionalProperties: false,
      required: ['statement','mechanism_type','supporting_episode_ids','counterevidence_episode_ids','testable_prediction','diagnostic_probe','confidence','candidate_intervention'],
      properties: {
        statement:{type:'string'}, mechanism_type:{type:'string',enum:['planning','representation','debugging','transfer','attention','other']},
        supporting_episode_ids:{type:'array',items:{type:'string'}}, counterevidence_episode_ids:{type:'array',items:{type:'string'}},
        testable_prediction:{type:'string'}, diagnostic_probe:{type:'string'}, confidence:{type:'number',minimum:0,maximum:1}, candidate_intervention:{type:'string'}
      }
    }}
  }
};
const falsifierSchema = {
  type: 'object', additionalProperties: false,
  required: ['alternative_explanations','strongest_counterevidence','confounds','discriminating_test','recommended_confidence_delta','recommended_intervention'],
  properties: {
    alternative_explanations:{type:'array',items:{type:'string'},minItems:1,maxItems:3}, strongest_counterevidence:{type:'array',items:{type:'string'}},
    confounds:{type:'array',items:{type:'string'}}, discriminating_test:{type:'string'}, recommended_confidence_delta:{type:'number',minimum:-.5,maximum:.2}, recommended_intervention:{type:'string'}
  }
};
const coachSchema = {
  type:'object', additionalProperties:false,
  required:['diagnosis','why_it_happened','minimal_fix','learning_focus','practice_prompt'],
  properties:{
    diagnosis:{type:'string'}, why_it_happened:{type:'string'}, minimal_fix:{type:'string'},
    learning_focus:{type:'string'}, practice_prompt:{type:'string'}
  }
};
const evolutionSchema = {
  type:'object', additionalProperties:false,
  required:['decision','rationale','variant_procedure','expected_mechanism','evaluation_plan'],
  properties:{
    decision:{type:'string',enum:['mutate','promote','retire','hold']}, rationale:{type:'string'}, variant_procedure:{type:'string'},
    expected_mechanism:{type:'string'}, evaluation_plan:{type:'string'}
  }
};

async function structured({ apiKey, model, name, schema, instructions, input }) {
  const body = await postJson(API, apiKey, {
    model, store:false, instructions, input: JSON.stringify(input),
    text:{format:{type:'json_schema',name,strict:true,schema}}
  });
  const outputText = body.output_text || (body.output || []).flatMap(item => item.content || []).find(content => content.type === 'output_text')?.text;
  if (!outputText) {
    const refusal = (body.output || []).flatMap(item => item.content || []).find(content => content.type === 'refusal')?.refusal;
    if (refusal) throw new Error(`OpenAI declined this request: ${refusal}`);
    throw new Error(`OpenAI returned no structured text (status: ${body.status || 'unknown'}).`);
  }
  try { return JSON.parse(outputText); }
  catch (_) { throw new Error('OpenAI returned structured output that was not valid JSON.'); }
}

async function runHypothesisAgent(apiKey, model, episodes, signature) {
  return structured({apiKey,model,name:'hypothesis_output',schema:hypothesisSchema,
    instructions:'You are Hypothesis Scientist for a developer-learning system. Infer 2–3 competing, non-clinical, falsifiable behavioral mechanisms. Do not generate, repair, or quote code. Treat every conclusion as uncertain. Use only the supplied semantic traces; do not infer private facts.',
    input:{role:'HypothesisAgent', signature, episodes}});
}
async function runFalsifierAgent(apiKey, model, evidence, hypothesis) {
  const blinded = {...hypothesis}; delete blinded.confidence;
  return structured({apiKey,model,name:'falsifier_output',schema:falsifierSchema,
    instructions:'You are Falsifier Agent. Challenge the supplied hypothesis without seeing its confidence. Seek rival behavioral explanations, counterevidence, confounds, and the smallest diagnostic that could disprove it. Do not generate code or solutions. Return a negative confidence delta only when warranted by evidence.',
    input:{role:'FalsifierAgent', evidence, hypothesis:blinded}});
}
async function embedEpisode(apiKey, trace) {
  const body = await postJson('https://api.openai.com/v1/embeddings',apiKey,{model:'text-embedding-3-small',input:trace});
  if(!body.data?.[0]?.embedding) throw new Error('Embedding request returned no vector.');
  return body.data[0].embedding;
}
async function runCodeCoach(apiKey, model, language, code, context) {
  return structured({apiKey,model,name:'code_coach_output',schema:coachSchema,
    instructions:'You are an educational code coach. Explain a likely bug and the smallest correction in the supplied code. Give a concise corrected fragment only when it is needed to demonstrate the fix. Then connect it to a transferable learning focus and a short independent practice prompt. Never claim certainty; do not expose secrets.',
    input:{language,code,context}});
}
async function runSkillEvolutionAgent(apiKey, model, skill, evidence) {
  return structured({apiKey,model,name:'skill_evolution_output',schema:evolutionSchema,
    instructions:'You are the intervention-skill evolution agent in a developer-learning system. Choose only from mutate, promote, retire, or hold. Use durable evidence (transfer, retention, recurrence, interruption cost, independence), not task completion alone. If mutating, propose one constrained non-solution variation. Never generate code.',
    input:{skill,evidence}});
}
module.exports={runHypothesisAgent,runFalsifierAgent,embedEpisode,runCodeCoach,runSkillEvolutionAgent};
