import { genAI, GEMINI_SAFETY_SETTINGS, MODEL_NAME } from '../config.js';
import { worldState } from '../core/worldState.js';
import { eventQueue } from '../core/eventQueue.js';
import { ALL_TOOLS_SCHEMAS, executeTool } from '../tools/index.js';
import { runFirewall } from '../security/firewall.js';
import { logger } from '../utils/logger.js';
import { broadcast, broadcastDecision, broadcastToken } from '../utils/broadcast.js';
import { AuditEntry } from '../models/AuditEntry.js';
import { Incident } from '../models/Incident.js';

const MAX_REACT_ITERATIONS = 3;
const _processingIds = new Set();
const _consecutiveFailures = { count: 0, lastFailAt: 0 };
const DEGRADED_THRESHOLD = 3;

const _errorTracker = {
  _ts: [],
  record() {
    const now = Date.now();
    this._ts = [...this._ts.filter(ts => now - ts < 60_000), now];
    if (this._ts.length >= 2) {
      logger.warn(`Warning: ${this._ts.length} errors/min - check Gemini quota`);
    }
  },
};

const TOOL_THINKING = {
  getAvailableUnits: a => `Checking available ${a.type || 'emergency'} units${a.zone ? ` in ${a.zone}` : ''}...`,
  getRoute: a => `Calculating fastest route: ${a.origin} -> ${a.destination}...`,
  blockRoad: a => `Closing road edge ${a.edgeId} - ${a.reason || 'structural failure'}...`,
  dispatchUnit: a => `Dispatching unit ${a.unitId} to zone ${a.destination}...`,
  returnUnit: a => `Recalling unit ${a.unitId} back to base...`,
  getHospitalCapacity: a => `Checking hospital beds${a.zone ? ` near ${a.zone}` : ''}...`,
  updateHospitalCapacity: a => `Updating hospital ${a.hospitalId} intake...`,
  getWeather: a => `Reading wind and fire spread data for zone ${a.zone}...`,
  notifyCitizens: a => `Broadcasting public alert to zone ${a.zone}...`,
};

const COORDINATOR_SYSTEM_PROMPT = `You are AEGIS, the AI emergency coordinator for Delhi.

Always begin by calling getAvailableUnits() first.
Then call getRoute() for each unit you plan to dispatch.
Then call dispatchUnit() for each chosen unit.
For fires, also call getWeather().
For casualties, call getHospitalCapacity() before routing patients.

Delhi zones: CP=Connaught Place, RP=Rajpath, KB=Karol Bagh, LN=Lajpat Nagar,
DW=Dwarka, RH=Rohini, SD=Shahdara, NP=Nehru Place, IGI=Airport, OKH=Okhla.
Yamuna Bridge is edge e5 (CP<->SD).

Decision priority: life safety > property > infrastructure.
Match unit specialty to incident type. Dispatch the minimum viable response first.
Every decision is logged. Be decisive and specific.`;

const FAST_PATH_UNIT_MAP = {
  vehicle_accident: 'police',
  structural_fire: 'fire',
  medical_emergency: 'ems',
  mass_casualty: 'ems',
  power_outage: 'traffic',
  hazmat: 'fire',
  building_collapse: 'ems',
};

export async function startCoordinatorLoop() {
  logger.success('Coordinator loop started');

  while (true) {
    try {
      const event = await eventQueue.dequeue();
      await processEvent(event);
    } catch (err) {
      logger.error('Coordinator loop error:', err.message);
      await sleep(1000);
    }
  }
}

export async function processEvent(event) {
  const incidentId = event.id;

  if (_processingIds.has(incidentId)) {
    logger.warn(`Duplicate processing attempt for ${incidentId} - skipped`);
    return;
  }
  _processingIds.add(incidentId);

  try {
    const fw = await runFirewall(event).catch(() => ({ passed: true, event }));
    if (!fw?.passed) {
      logger.firewall('BLOCK', `Event ${incidentId} quarantined`);
      return;
    }

    const incident = worldState.createIncident({
      id: incidentId,
      type: event.type,
      subtype: event.subtype,
      zone: event.zone,
      priority: event.priority,
      description: event.description,
      metadata: event,
    });

    Incident.create({
      incidentId,
      type: event.type,
      subtype: event.subtype,
      zone: event.zone,
      priority: event.priority,
      description: event.description,
      metadata: event,
    }).catch(() => {});

    safeBroadcast({ type: 'INCIDENT_RECEIVED', payload: { ...incident } });

    if (event.priority <= 3 && event._source === 'simulation_fallback') {
      await fastPathDispatch(event, incidentId);
      return;
    }

    if (isInDegradedMode()) {
      logger.warn(`Degraded mode - fast-path for ${incidentId}`);
      await fastPathDispatch(event, incidentId, { degradedMode: true });
      return;
    }

    safeBroadcast({
      type: 'THOUGHT_START',
      payload: { agentId: 'coordinator', incidentId, eventType: event.type, zone: event.zone },
    });

    const sourceLabel = event._source === 'live_news'
      ? '[LIVE NEWS]'
      : event._source === 'simulation_fallback'
        ? '[SIMULATION]'
        : event._scenario
          ? '[DEMO]'
          : '[INCIDENT]';

    const openingText =
      `${sourceLabel} ${event.type.replace(/_/g, ' ').toUpperCase()} in ${event.zone} - Priority ${event.priority}/10\n` +
      `${event._headline ? `Source: "${event._headline}"\n` : ''}` +
      'Analyzing city state and available resources...\n\n';

    safeBroadcastToken('coordinator', incidentId, openingText, false);

    const geminiTools = convertToGeminiTools(ALL_TOOLS_SCHEMAS);
    const snapshot = worldState.getSnapshot();
    const userMessage = buildUserMessage(event, snapshot);
    let fullReasoning = openingText;
    const toolCallLog = [];

    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction: COORDINATOR_SYSTEM_PROMPT,
      safetySettings: GEMINI_SAFETY_SETTINGS,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 600,
      },
      tools: [{ functionDeclarations: geminiTools }],
    });

    const chat = model.startChat({ history: [] });

    let iterations = 0;
    let currentMsg = userMessage;

    while (iterations < MAX_REACT_ITERATIONS) {
      iterations++;

      let stepText = '';
      let functionCalls = [];

      try {
        const streamResult = await runGeminiStream(chat, currentMsg);

        for await (const chunk of streamResult.stream) {
          try {
            const text = chunk.text();
            if (text) {
              stepText += text;
              safeBroadcastToken('coordinator', incidentId, text, false);
              fullReasoning += text;
            }
          } catch {}

          const candidate = chunk.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if (part.functionCall) {
                functionCalls.push(part.functionCall);
              }
            }
          }
        }

        const finalResponse = await streamResult.response;
        const finalCalls = finalResponse.functionCalls?.() || [];
        if (finalCalls.length > 0) {
          functionCalls = finalCalls;
        }

        _consecutiveFailures.count = 0;
      } catch (streamErr) {
        logger.error('Gemini stream error:', streamErr.message);
        _errorTracker.record(streamErr.message);
        _consecutiveFailures.count++;
        _consecutiveFailures.lastFailAt = Date.now();

        if (isRateLimitError(streamErr)) {
          logger.warn('Rate limit - pausing 60s and re-queuing');
          safeBroadcastToken(
            'coordinator',
            incidentId,
            '\nRate limit reached - retrying in 60 seconds\n',
            false,
          );
          await sleep(60_000);
          eventQueue.enqueue(event);
          safeBroadcast({
            type: 'THOUGHT_END',
            payload: { agentId: 'coordinator', incidentId, decision: 'Rate limited - re-queued' },
          });
          return;
        }

        if (isInvalidArgumentError(streamErr)) {
          logger.error(`Gemini invalid argument for ${incidentId}: ${serializeForLog(currentMsg)}`);
        }

        const finishReason = streamErr?.response?.candidates?.[0]?.finishReason;
        if (finishReason === 'SAFETY') {
          logger.warn('Gemini safety filter triggered - failing open');
          break;
        }

        break;
      }

      if (!functionCalls || functionCalls.length === 0) {
        logger.agent('coordinator', `Done after ${iterations} step(s)`);
        break;
      }

      const functionResponses = [];

      for (const fc of functionCalls) {
        const toolName = fc.name;
        const toolArgs = fc.args || {};

        const thinkingMsg = TOOL_THINKING[toolName]?.(toolArgs) || `Running ${toolName}...`;
        safeBroadcastToken('coordinator', incidentId, `\n${thinkingMsg}`, false);
        fullReasoning += `\n${thinkingMsg}`;

        let toolResult;
        try {
          const execResult = await executeTool(toolName, JSON.stringify(toolArgs));
          toolResult = execResult.result;
        } catch (toolErr) {
          logger.error(`Tool ${toolName} failed:`, toolErr.message);
          toolResult = { success: false, error: toolErr.message };
        }

        toolCallLog.push({
          name: toolName,
          arguments: toolArgs,
          result: toolResult,
          step: iterations,
        });

        const summary = buildResultSummary(toolName, toolResult, toolArgs);
        safeBroadcastToken('coordinator', incidentId, `\n${summary}`, false);
        fullReasoning += `\n${summary}`;

        safeBroadcast({
          type: 'TOOL_EXECUTED',
          payload: {
            agentId: 'coordinator',
            incidentId,
            tool: toolName,
            args: toolArgs,
            result: toolResult,
          },
        });

        if (toolName === 'dispatchUnit' && toolResult?.success) {
          broadcastUnitRoute(toolCallLog, toolResult, incidentId);
        }

        functionResponses.push({
          functionResponse: {
            name: toolName,
            response: trimForContext(toolName, toolResult),
          },
        });
      }

      currentMsg = functionResponses;
    }

    const finalDecision = buildAutoSummary(toolCallLog, event);
    await finalizeIncident({
      event,
      incidentId,
      fullReasoning,
      toolCallLog,
      finalDecision,
      iterations,
    });
  } catch (err) {
    logger.error('processEvent fatal error:', err.message);
    _errorTracker.record(err.message);
    safeBroadcast({
      type: 'THOUGHT_END',
      payload: { agentId: 'coordinator', incidentId, decision: `Error: ${err.message}` },
    });
  } finally {
    _processingIds.delete(incidentId);
  }
}

async function fastPathDispatch(event, incidentId, options = {}) {
  safeBroadcast({
    type: 'THOUGHT_START',
    payload: { agentId: 'coordinator', incidentId, eventType: event.type, zone: event.zone },
  });

  const unitType = FAST_PATH_UNIT_MAP[event.type] || 'police';
  const allUnits = worldState.getAvailableUnits(unitType);
  const unit = allUnits.find(candidate => candidate.currentZone === event.zone) || allUnits[0];
  const toolCallLog = [];

  let summary;
  if (!unit) {
    summary = options.degradedMode
      ? `[RULE-BASED] Gemini unavailable and no ${unitType} units are free for ${event.type} in ${event.zone}.`
      : `[RULE-BASED] No ${unitType} units available for ${event.type} in ${event.zone}. Monitoring.`;
    safeBroadcastToken('coordinator', incidentId, summary, false);
  } else {
    const routeResult = await executeTool(
      'getRoute',
      JSON.stringify({ origin: unit.currentZone, destination: event.zone }),
    );
    const dispatchResult = await executeTool(
      'dispatchUnit',
      JSON.stringify({ unitId: unit.id, destination: event.zone, incidentId }),
    );

    toolCallLog.push({
      name: routeResult.name,
      arguments: routeResult.parsedArgs,
      result: routeResult.result,
      step: 1,
    });
    toolCallLog.push({
      name: dispatchResult.name,
      arguments: dispatchResult.parsedArgs,
      result: dispatchResult.result,
      step: 1,
    });

    safeBroadcast({
      type: 'TOOL_EXECUTED',
      payload: {
        agentId: 'coordinator',
        incidentId,
        tool: routeResult.name,
        args: routeResult.parsedArgs,
        result: routeResult.result,
      },
    });
    safeBroadcast({
      type: 'TOOL_EXECUTED',
      payload: {
        agentId: 'coordinator',
        incidentId,
        tool: dispatchResult.name,
        args: dispatchResult.parsedArgs,
        result: dispatchResult.result,
      },
    });

    if (dispatchResult.result?.success && routeResult.result?.path) {
      safeBroadcast({
        type: 'UNIT_ROUTE',
        payload: {
          unitId: unit.id,
          unitType: unit.type,
          unitName: unit.name,
          path: routeResult.result.path,
          origin: routeResult.result.path[0],
          destination: event.zone,
          etaMinutes: routeResult.result.totalTimeMinutes,
          incidentId,
        },
      });
      worldState.updateIncident(incidentId, { unitsDispatched: [unit.id] });
    }

    summary = options.degradedMode
      ? `[RULE-BASED] ${unit.name} dispatched to ${event.zone}. ETA: ${routeResult.result?.totalTimeMinutes || '?'} min.`
      : `[RULE-BASED] ${unit.name} dispatched to ${event.zone}. ETA: ${routeResult.result?.totalTimeMinutes || '?'} min.`;
    safeBroadcastToken('coordinator', incidentId, summary, false);
  }

  safeBroadcastDecision('coordinator', incidentId, summary, toolCallLog, summary, event.type, event.zone);
  safeBroadcast({
    type: 'THOUGHT_END',
    payload: { agentId: 'coordinator', incidentId, decision: summary },
  });
}

async function finalizeIncident({ event, incidentId, fullReasoning, toolCallLog, finalDecision, iterations }) {
  safeBroadcastToken('coordinator', incidentId, `\n\n[DECISION]\n${finalDecision}`, false);
  safeBroadcastDecision(
    'coordinator',
    incidentId,
    fullReasoning,
    toolCallLog,
    finalDecision,
    event.type,
    event.zone,
  );
  safeBroadcast({
    type: 'THOUGHT_END',
    payload: { agentId: 'coordinator', incidentId, decision: finalDecision },
  });

  const dispatched = toolCallLog
    .filter(tc => tc.name === 'dispatchUnit' && tc.result?.success)
    .map(tc => tc.result.unit.id);

  if (dispatched.length > 0) {
    worldState.updateIncident(incidentId, { unitsDispatched: dispatched });
  }

  AuditEntry.create({
    incidentId,
    agentType: 'coordinator',
    eventType: event.type,
    zone: event.zone,
    priority: event.priority,
    reasoning: fullReasoning,
    toolCalls: toolCallLog,
    decision: finalDecision,
    metadata: { iterations, dispatched },
  }).catch(() => {});

  logger.agent(
    'coordinator',
    `Done in ${iterations} step(s). Dispatched: ${dispatched.length} unit(s). Tools used: ${toolCallLog.length}`,
  );
}

async function runGeminiStream(chat, input, attempt = 0) {
  try {
    return await chat.sendMessageStream(input);
  } catch (err) {
    if (isServiceUnavailableError(err) && attempt === 0) {
      logger.warn('Gemini service unavailable - retrying once in 5 seconds');
      await sleep(5000);
      return runGeminiStream(chat, input, 1);
    }
    throw err;
  }
}

function convertToGeminiTools(openaiSchemas) {
  return openaiSchemas.map(schema => {
    const fn = schema.function;
    return {
      name: fn.name,
      description: (fn.description || '').slice(0, 200),
      parameters: {
        type: 'OBJECT',
        properties: convertProps(fn.parameters?.properties || {}),
        required: fn.parameters?.required || [],
      },
    };
  });
}

function convertProps(props) {
  const out = {};

  for (const [key, val] of Object.entries(props)) {
    const geminiType = (val.type || 'string').toUpperCase();
    out[key] = {
      type: geminiType === 'INTEGER' ? 'NUMBER' : geminiType,
      description: (val.description || '').slice(0, 200),
    };

    if (val.enum && geminiType === 'STRING') {
      out[key].enum = val.enum;
    }

    if (val.type === 'object' && val.properties) {
      out[key].type = 'OBJECT';
      out[key].properties = convertProps(val.properties);
    }

    if (val.type === 'array' && val.items) {
      const itemType = (val.items.type || 'string').toUpperCase();
      out[key].type = 'ARRAY';
      out[key].items = {
        type: itemType === 'INTEGER' ? 'NUMBER' : itemType,
        ...(val.items.description ? { description: val.items.description.slice(0, 200) } : {}),
      };
    }
  }

  return out;
}

function trimForContext(toolName, result) {
  if (!result || result.success === false) {
    return result;
  }

  switch (toolName) {
    case 'getAvailableUnits':
      return {
        success: true,
        totalAvailable: result.totalAvailable,
        summary: result.summary,
        units: (result.units || []).map(unit => ({
          id: unit.id,
          name: unit.name,
          type: unit.type,
          currentZone: unit.currentZone,
        })),
        note: result.note,
      };
    case 'getHospitalCapacity':
      return {
        success: true,
        recommendation: result.recommendation,
        totalAvailableBeds: result.totalAvailableBeds,
        totalAvailableIcu: result.totalAvailableIcu,
        hospitals: (result.hospitals || []).slice(0, 3).map(hospital => ({
          id: hospital.id,
          name: hospital.name,
          zone: hospital.zone,
          availableBeds: hospital.availableBeds,
          availableIcu: hospital.availableIcu,
          status: hospital.status,
        })),
      };
    case 'getRoute':
      return {
        success: result.success,
        path: result.path,
        totalTimeMinutes: result.totalTimeMinutes,
        error: result.error,
        suggestion: result.suggestion,
      };
    default:
      return result;
  }
}

function buildResultSummary(toolName, result, args) {
  if (result?.success === false) {
    return `  Failed: ${result.error || 'unknown error'}`;
  }

  switch (toolName) {
    case 'getAvailableUnits':
      return `  ${result.totalAvailable} units available (P:${result.summary?.police} F:${result.summary?.fire} E:${result.summary?.ems} T:${result.summary?.traffic})`;
    case 'getRoute':
      return result.success
        ? `  Route: ${result.pathNames?.join(' -> ')} - ETA ${result.totalTimeMinutes} min`
        : `  No route: ${result.error}`;
    case 'blockRoad':
      return `  ${result.edgeName || args.edgeId} CLOSED - all routing rerouted`;
    case 'dispatchUnit':
      return `  ${result.unit?.callSign || args.unitId} -> ${args.destination}`;
    case 'returnUnit':
      return `  ${result.unit?.name || args.unitId} returned to base`;
    case 'getHospitalCapacity':
      return `  ${result.recommendation || `${result.totalAvailableBeds} beds available`}`;
    case 'getWeather':
      return `  Wind: ${result.weather?.windSpeed}km/h ${result.weather?.windDirection} - Fire spread: ${result.weather?.fireSpreadRisk}`;
    case 'notifyCitizens':
      return `  Alert sent to zone ${args.zone} [${(args.severity || 'high').toUpperCase()}]`;
    default:
      return `  ${toolName} completed`;
  }
}

function buildAutoSummary(toolCallLog, event) {
  const dispatched = toolCallLog.filter(tc => tc.name === 'dispatchUnit' && tc.result?.success);
  const blocked = toolCallLog.filter(tc => tc.name === 'blockRoad' && tc.result?.success);

  if (dispatched.length === 0 && blocked.length === 0) {
    return `Assessed ${event.type.replace(/_/g, ' ')} in ${event.zone}. No units were dispatched.`;
  }

  const lines = [];

  if (blocked.length > 0) {
    lines.push(`Closed ${blocked.length} road(s). All routing rerouted automatically.`);
  }

  if (dispatched.length > 0) {
    const names = dispatched.map(d => d.result?.unit?.name || d.arguments?.unitId).join(', ');
    lines.push(`Dispatched ${dispatched.length} unit(s): ${names}.`);
  }

  return lines.join(' ');
}

function buildUserMessage(event, snapshot) {
  const stats = snapshot.stats;
  const availableUnits = snapshot.units.filter(unit => unit.status === 'available');
  const activeIncidents = snapshot.activeIncidents.filter(incident => incident.id !== event.id);

  return `EMERGENCY REQUIRING IMMEDIATE RESPONSE:

Type: ${event.type}${event.subtype ? `/${event.subtype}` : ''}
Zone: ${event.zone}
Priority: ${event.priority}/10
Description: ${(event.description || '').slice(0, 120)}
ID: ${event.id}

CITY STATE:
Available units: ${stats.availableUnits}/${stats.totalUnits}
  Police: ${availableUnits.filter(unit => unit.type === 'police').length}
  Fire:   ${availableUnits.filter(unit => unit.type === 'fire').length}
  EMS:    ${availableUnits.filter(unit => unit.type === 'ems').length}
  Traffic:${availableUnits.filter(unit => unit.type === 'traffic').length}
Blocked roads: ${stats.blockedRoads > 0 ? snapshot.blockedEdges.join(', ') : 'none'}
Other active: ${activeIncidents.length > 0 ? activeIncidents.map(incident => `${incident.type} in ${incident.zone}`).join('; ') : 'none'}

Call getAvailableUnits() first, then coordinate your response.`;
}

function broadcastUnitRoute(toolCallLog, dispatchResult, incidentId) {
  const matchingRoute = [...toolCallLog].reverse().find(t =>
    t.name === 'getRoute' && t.result?.success && t.result?.path,
  );

  if (!matchingRoute) {
    return;
  }

  safeBroadcast({
    type: 'UNIT_ROUTE',
    payload: {
      unitId: dispatchResult.unit.id,
      unitType: dispatchResult.unit.type,
      unitName: dispatchResult.unit.name,
      path: matchingRoute.result.path,
      origin: matchingRoute.result.path[0],
      destination: matchingRoute.result.path[matchingRoute.result.path.length - 1],
      etaMinutes: matchingRoute.result.totalTimeMinutes,
      incidentId,
    },
  });
}

function isInDegradedMode() {
  if (_consecutiveFailures.count >= DEGRADED_THRESHOLD) {
    if (Date.now() - _consecutiveFailures.lastFailAt > 300_000) {
      _consecutiveFailures.count = 0;
      logger.success('Gemini recovered - exiting degraded mode');
      return false;
    }
    return true;
  }

  return false;
}

function isRateLimitError(err) {
  return err?.status === 429 || /429|resource_exhausted|rate limit/i.test(err?.message || '');
}

function isServiceUnavailableError(err) {
  return err?.status === 503 || /503|service unavailable|unavailable/i.test(err?.message || '');
}

function isInvalidArgumentError(err) {
  return err?.status === 400 || /400|invalid argument/i.test(err?.message || '');
}

function serializeForLog(value) {
  try {
    return typeof value === 'string' ? value.slice(0, 600) : JSON.stringify(value).slice(0, 600);
  } catch {
    return '[unserializable input]';
  }
}

function safeBroadcast(payload) {
  try {
    broadcast(payload);
  } catch (err) {
    logger.warn('Broadcast failed:', err.message);
  }
}

function safeBroadcastToken(agentId, incidentId, token, done = false) {
  try {
    broadcastToken(agentId, incidentId, token, done);
  } catch (err) {
    logger.warn('Token broadcast failed:', err.message);
  }
}

function safeBroadcastDecision(agentId, incidentId, reasoning, toolCalls, decision, eventType, zone) {
  try {
    broadcastDecision(agentId, incidentId, reasoning, toolCalls, decision, eventType, zone);
  } catch (err) {
    logger.warn('Decision broadcast failed:', err.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
