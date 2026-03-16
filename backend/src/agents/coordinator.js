import { groq, MODEL } from '../config.js';
import { worldState } from '../core/worldState.js';
import { eventQueue } from '../core/eventQueue.js';
import { ALL_TOOLS_SCHEMAS, executeTool } from '../tools/index.js';
import { runFirewall } from '../security/firewall.js';
import { logger } from '../utils/logger.js';
import { broadcast, broadcastToken, broadcastDecision } from '../utils/broadcast.js';
import { AuditEntry } from '../models/AuditEntry.js';
import { Incident } from '../models/Incident.js';

const MAX_REACT_ITERATIONS = 6;

const TOOL_THINKING = {
  getAvailableUnits: args => `🔍 Checking available ${args.type || 'emergency'} units${args.zone ? ` in ${args.zone}` : ''}...`,
  getRoute: args => `📍 Calculating fastest route: ${args.origin} -> ${args.destination}...`,
  blockRoad: args => `🚧 Closing road edge ${args.edgeId} — ${args.reason || 'structural failure'}...`,
  dispatchUnit: args => `🚀 Dispatching unit ${args.unitId} to zone ${args.destination}...`,
  returnUnit: args => `↩️ Recalling unit ${args.unitId} back to base...`,
  getHospitalCapacity: args => `🏥 Checking hospital beds${args.zone ? ` near ${args.zone}` : ''}...`,
  updateHospitalCapacity: args => `🏥 Updating hospital ${args.hospitalId} intake...`,
  getWeather: args => `🌬️ Reading wind and fire spread data for zone ${args.zone}...`,
  notifyCitizens: args => `📢 Broadcasting public alert to zone ${args.zone}...`,
};

const COORDINATOR_SYSTEM_PROMPT = `You are AEGIS — the AI emergency coordinator for Delhi.

ALWAYS begin your response by calling getAvailableUnits() first — no exceptions.
Then call getRoute() for each unit you plan to dispatch.
Then call dispatchUnit() for each chosen unit.
For fires: also call getWeather() to check wind direction.
For casualties: call getHospitalCapacity() before routing patients.

DELHI ZONES: CP=Connaught Place, RP=Rajpath, KB=Karol Bagh, LN=Lajpat Nagar,
DW=Dwarka, RH=Rohini, SD=Shahdara, NP=Nehru Place, IGI=Airport, OKH=Okhla
Yamuna Bridge = edge e5 (CP↔SD)

DECISION PRIORITY: Life safety > property > infrastructure
Match unit specialty to incident type. Dispatch minimum viable response first.
Every decision is logged. Be decisive and specific.`;

export async function startCoordinatorLoop() {
  logger.success('🧠 Coordinator loop started');

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

async function processEvent(event) {
  const incidentId = event.id;
  logger.agent('coordinator', `Processing: ${event.type} in ${event.zone} [P${event.priority}]`);

  const firewallResult = await runFirewall(event).catch(() => ({ passed: true, event }));
  if (!firewallResult || !firewallResult.passed) {
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
    metadata: event.metadata || event,
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

  broadcast({ type: 'INCIDENT_RECEIVED', payload: { ...incident } });
  broadcast({
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
    `${sourceLabel} ${event.type.replace(/_/g, ' ').toUpperCase()} in ${event.zone} — Priority ${event.priority}/10\n` +
    `${event._headline ? `Source: "${event._headline}"\n` : ''}` +
    'Analyzing city state...\n\n';

  broadcastToken('coordinator', incidentId, openingText, false);

  let fullReasoning = openingText;
  const toolCallLog = [];
  let iterations = 1;
  let messages = [];
  let finalDecision = '';

  if (shouldUseLowPrioritySimulationFastPath(event)) {
    const fastPathText = '\nLow-priority simulation fallback detected. Running limited coordination path.\n';
    broadcastToken('coordinator', incidentId, fastPathText, false);
    fullReasoning += fastPathText;

    const fastPathTools = [
      { toolName: 'getAvailableUnits', parsedArgs: { zone: event.zone } },
      {
        toolName: 'notifyCitizens',
        parsedArgs: {
          zone: event.zone,
          message: buildLowPriorityNotification(event),
          severity: 'low',
        },
      },
    ];

    for (const plannedTool of fastPathTools) {
      const executedTool = await executeCoordinatorTool({
        incidentId,
        toolName: plannedTool.toolName,
        parsedArgs: plannedTool.parsedArgs,
        step: 1,
      });
      toolCallLog.push(executedTool.logEntry);
      fullReasoning += executedTool.reasoningDelta;
    }

    finalDecision = buildLowPrioritySimulationDecision(event);
  } else {
    const snapshot = worldState.getSnapshot();
    messages = [
      { role: 'system', content: COORDINATOR_SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(event, snapshot) },
    ];

    try {
      const firstResponse = await groq.chat.completions.create({
        model: MODEL,
        messages,
        tools: ALL_TOOLS_SCHEMAS,
        tool_choice: 'required',
        max_tokens: 300,
        temperature: 0.1,
        stream: false,
      });

      const firstMessage = firstResponse.choices[0].message;
      const firstTools = firstMessage.tool_calls || [];

      if (firstTools.length === 0) {
        logger.warn('Groq returned 0 tools even with required — using text response');
        const fallbackText = firstMessage.content || 'Assessed incident. Monitoring situation.';
        broadcastToken('coordinator', incidentId, fallbackText, false);
        fullReasoning += fallbackText;
        messages.push({ role: 'assistant', content: fallbackText });
      } else {
        if (firstMessage.content) {
          broadcastToken('coordinator', incidentId, firstMessage.content, false);
          fullReasoning += firstMessage.content;
        }

        messages.push({ role: 'assistant', content: firstMessage.content || '', tool_calls: firstTools });

        const toolResultMessages = [];
        for (const toolCall of firstTools) {
          let parsedArgs;
          try {
            parsedArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            parsedArgs = {};
          }

          const executedTool = await executeCoordinatorTool({
            incidentId,
            toolName: toolCall.function.name,
            parsedArgs,
            rawArgs: toolCall.function.arguments,
            step: 1,
          });

          toolCallLog.push(executedTool.logEntry);
          fullReasoning += executedTool.reasoningDelta;
          toolResultMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(executedTool.result),
          });
        }
        messages.push(...toolResultMessages);
      }
    } catch (err) {
      logger.error('First Groq call failed:', err.message);
      broadcastToken('coordinator', incidentId, `\nError contacting AI: ${err.message}\n`, false);
    }

    const shouldSkipContinuation =
      event.priority < 8 &&
      toolCallLog.some(toolCall => toolCall.name === 'dispatchUnit' && toolCall.result?.success);

    if (shouldSkipContinuation) {
      const finalizeText = '\nSimple incident handled in step 1. Finalizing response.\n';
      broadcastToken('coordinator', incidentId, finalizeText, false);
      fullReasoning += finalizeText;
    } else {
      while (iterations < MAX_REACT_ITERATIONS) {
        iterations += 1;

        const stepText = `\n[Step ${iterations} — Continuing coordination...]\n`;
        broadcastToken('coordinator', incidentId, stepText, false);
        fullReasoning += stepText;

        const { text, toolCalls } = await streamGroqCall(messages, incidentId);
        if (text) fullReasoning += text;

        if (toolCalls.length === 0) {
          logger.agent('coordinator', `Coordination complete after ${iterations} step(s)`);
          break;
        }

        messages.push({ role: 'assistant', content: text || '', tool_calls: toolCalls });

        const toolResultMessages = [];
        for (const toolCall of toolCalls) {
          let parsedArgs;
          try {
            parsedArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            parsedArgs = {};
          }

          const executedTool = await executeCoordinatorTool({
            incidentId,
            toolName: toolCall.function.name,
            parsedArgs,
            rawArgs: toolCall.function.arguments,
            step: iterations,
          });

          toolCallLog.push(executedTool.logEntry);
          fullReasoning += executedTool.reasoningDelta;
          toolResultMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(executedTool.result),
          });
        }
        messages.push(...toolResultMessages);
      }
    }

    finalDecision = extractFinalDecision(messages) || buildAutoSummary(toolCallLog, event);
  }

  finalDecision ||= buildAutoSummary(toolCallLog, event);

  const finalText = `\n\n[DECISION]\n${finalDecision}`;
  broadcastToken('coordinator', incidentId, finalText, false);

  broadcastDecision('coordinator', incidentId, fullReasoning, toolCallLog, finalDecision, event.type, event.zone);
  broadcast({ type: 'THOUGHT_END', payload: { agentId: 'coordinator', incidentId, decision: finalDecision } });

  const dispatched = toolCallLog
    .filter(toolCall => toolCall.name === 'dispatchUnit' && toolCall.result?.success)
    .map(toolCall => toolCall.result.unit.id);

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
    `✅ Done in ${iterations} steps. Dispatched: ${dispatched.length} unit(s). Tools used: ${toolCallLog.length}`,
  );
}

async function streamGroqCall(messages, incidentId) {
  let fullText = '';
  const toolCalls = [];

  try {
    const stream = await groq.chat.completions.create({
      model: MODEL,
      messages,
      tools: ALL_TOOLS_SCHEMAS,
      tool_choice: 'auto',
      max_tokens: 500,
      temperature: 0.1,
      stream: true,
    });

    const accumulator = {};
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        fullText += delta.content;
        broadcastToken('coordinator', incidentId, delta.content, false);
      }

      if (delta.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          if (!accumulator[toolCall.index]) {
            accumulator[toolCall.index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }

          const entry = accumulator[toolCall.index];
          if (toolCall.id) entry.id = toolCall.id;
          if (toolCall.function?.name) entry.function.name = toolCall.function.name;
          if (toolCall.function?.arguments) entry.function.arguments += toolCall.function.arguments;
        }
      }
    }

    Object.values(accumulator).forEach(toolCall => toolCalls.push(toolCall));
    broadcastToken('coordinator', incidentId, '', true);
  } catch (err) {
    logger.error('Groq streaming error:', err.message);
    broadcastToken('coordinator', incidentId, `\n⚠ AI error: ${err.message}`, true);
  }

  return { text: fullText, toolCalls };
}

async function executeCoordinatorTool({ incidentId, toolName, parsedArgs, rawArgs = parsedArgs, step }) {
  const thinkingMsg = TOOL_THINKING[toolName] ? TOOL_THINKING[toolName](parsedArgs) : `→ ${toolName}...`;
  broadcastToken('coordinator', incidentId, `\n${thinkingMsg}`, false);

  const { name, result } = await executeTool(toolName, rawArgs);
  const summary = buildResultSummary(name, result, parsedArgs);
  broadcastToken('coordinator', incidentId, `\n${summary}`, false);

  broadcast({
    type: 'TOOL_EXECUTED',
    payload: { agentId: 'coordinator', incidentId, tool: name, args: parsedArgs, result },
  });

  return {
    result,
    logEntry: { name, arguments: parsedArgs, result, step },
    reasoningDelta: `\n${thinkingMsg}\n${summary}`,
  };
}

function buildResultSummary(toolName, result, args) {
  if (result.success === false) return `  ✗ Failed: ${result.error || 'unknown error'}`;

  switch (toolName) {
    case 'getAvailableUnits':
      return `  ✓ ${result.totalAvailable} units available (P:${result.summary?.police} F:${result.summary?.fire} E:${result.summary?.ems} T:${result.summary?.traffic})`;
    case 'getRoute':
      return result.success
        ? `  ✓ Route: ${result.pathNames?.join(' -> ')} — ETA ${result.totalTimeMinutes} min`
        : `  ✗ No route: ${result.error}`;
    case 'blockRoad':
      return `  ✓ ${result.edgeName || args.edgeId} CLOSED — all routing rerouted`;
    case 'dispatchUnit':
      return `  ✓ ${result.unit?.callSign || args.unitId} -> ${args.destination}`;
    case 'returnUnit':
      return `  ✓ ${result.unit?.name || args.unitId} returned to base`;
    case 'getHospitalCapacity':
      return `  ✓ ${result.recommendation || `${result.totalAvailableBeds} beds available`}`;
    case 'getWeather':
      return `  ✓ Wind: ${result.weather?.windSpeed}km/h ${result.weather?.windDirection} — Fire spread: ${result.weather?.fireSpreadRisk}`;
    case 'notifyCitizens':
      return `  ✓ Alert sent to zone ${args.zone} [${(args.severity || 'high').toUpperCase()}]`;
    default:
      return `  ✓ ${toolName} completed`;
  }
}

function shouldUseLowPrioritySimulationFastPath(event) {
  return event.priority < 5 && event._source === 'simulation_fallback';
}

function buildLowPriorityNotification(event) {
  const label = event.type.replace(/_/g, ' ');
  return `Low-priority ${label} reported in ${event.zone}. Avoid the area and await updates.`;
}

function buildLowPrioritySimulationDecision(event) {
  return `Low-priority simulation in ${event.zone} assessed. Unit availability was checked and a public advisory was issued. No dispatch or hospital escalation is required at this time.`;
}

function buildAutoSummary(toolCallLog, event) {
  const dispatched = toolCallLog.filter(toolCall => toolCall.name === 'dispatchUnit' && toolCall.result?.success);
  const blocked = toolCallLog.filter(toolCall => toolCall.name === 'blockRoad' && toolCall.result?.success);

  if (dispatched.length === 0 && blocked.length === 0) {
    return `Assessed ${event.type.replace(/_/g, ' ')} in ${event.zone}. All units currently allocated to active incidents. Monitoring situation — will dispatch when capacity available.`;
  }

  const lines = [];
  if (blocked.length > 0) lines.push(`Closed ${blocked.length} road(s). All routing rerouted automatically.`);
  if (dispatched.length > 0) {
    const names = dispatched.map(toolCall => toolCall.result?.unit?.name || toolCall.arguments?.unitId).join(', ');
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
Description: ${event.description}
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

function extractFinalDecision(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'assistant' && message.content?.trim()) {
      return message.content.trim();
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
