import { createGeminiModel } from '../config.js';
import { worldState } from '../core/worldState.js';
import { executeTool } from '../tools/index.js';
import { COMMS_TOOLS, EMS_TOOLS, FIRE_TOOLS, POLICE_TOOLS, TRAFFIC_TOOLS } from '../tools/index.js';
import { logger } from '../utils/logger.js';
import { broadcast, broadcastToken } from '../utils/broadcast.js';
import { AuditEntry } from '../models/AuditEntry.js';

const AGENT_CONFIGS = {
  police: {
    name: 'Police Command',
    tools: POLICE_TOOLS,
    system: `You are the Delhi Police Command sub-agent for AEGIS.
Your domain: law enforcement, crowd control, crime response, perimeter security, traffic offence management.
Assess the incident, use police tools decisively, and return concise tactical guidance.`,
  },
  fire: {
    name: 'Fire Command',
    tools: FIRE_TOOLS,
    system: `You are the Delhi Fire Command sub-agent for AEGIS.
Your domain: structural fires, hazmat incidents, vehicle fires, fire suppression, rescue operations.
Use getWeather() when relevant and return concise tactical guidance.`,
  },
  ems: {
    name: 'EMS Command',
    tools: EMS_TOOLS,
    system: `You are the Delhi EMS Command sub-agent for AEGIS.
Your domain: medical emergencies, casualty transport, mass casualty triage, hospital coordination.
Use getHospitalCapacity() before routing patients and return concise guidance.`,
  },
  traffic: {
    name: 'Traffic Control',
    tools: TRAFFIC_TOOLS,
    system: `You are the Delhi Traffic Control sub-agent for AEGIS.
Your domain: signal management, road closures, bridge monitoring, evacuation corridor establishment, accident scene management.
Use blockRoad() when needed and return concise guidance.`,
  },
  comms: {
    name: 'Citizen Comms',
    tools: COMMS_TOOLS,
    system: `You are the Delhi Citizen Communications sub-agent for AEGIS.
Craft clear public alerts in plain language and return concise guidance.`,
  },
};

export async function runSubAgent(agentType, incident, directive = '') {
  const config = AGENT_CONFIGS[agentType];
  if (!config) throw new Error(`Unknown sub-agent type: ${agentType}`);

  const incidentId = incident.id;
  logger.agent(agentType, `Sub-agent activated for incident ${incidentId}`);

  safeBroadcast({
    type: 'SUBAGENT_START',
    payload: { agentId: agentType, incidentId, agentName: config.name },
  });

  const snapshot = worldState.getSnapshot();
  const userMessage = buildSubAgentMessage(incident, snapshot, directive);
  const model = createGeminiModel(convertSchemasToGemini(config.tools), {
    maxOutputTokens: 512,
    temperature: 0.1,
    systemInstruction: config.system,
  });
  const chat = model.startChat({ history: [] });

  let fullText = '';
  const toolLog = [];
  const streamResult = await chat.sendMessageStream(userMessage);

  for await (const chunk of streamResult.stream) {
    const text = typeof chunk.text === 'function' ? chunk.text() : '';
    if (text) {
      fullText += text;
      safeBroadcastToken(agentType, incidentId, text, false);
    }
  }

  const response = await streamResult.response;
  const functionCalls = extractFunctionCalls(response);

  for (const functionCall of functionCalls) {
    const { name, parsedArgs, result } = await executeTool(functionCall.name, JSON.stringify(functionCall.args || {}));
    toolLog.push({ name, arguments: parsedArgs, result });
    safeBroadcast({
      type: 'TOOL_EXECUTED',
      payload: { agentId: agentType, incidentId, tool: name, args: parsedArgs, result },
    });
  }

  safeBroadcastToken(agentType, incidentId, '', true);
  safeBroadcast({
    type: 'SUBAGENT_COMPLETE',
    payload: { agentId: agentType, incidentId, reasoning: fullText, toolCalls: toolLog },
  });

  AuditEntry.create({
    incidentId,
    agentType,
    eventType: incident.type,
    zone: incident.zone,
    priority: incident.priority,
    reasoning: fullText,
    toolCalls: toolLog,
    decision: fullText.slice(0, 300),
  }).catch(err => logger.error(`${agentType} audit write failed:`, err.message));

  logger.agent(agentType, `Sub-agent complete - ${toolLog.length} tool(s) executed`);
  return { agentType, reasoning: fullText, toolCalls: toolLog };
}

function buildSubAgentMessage(incident, snapshot, directive) {
  return `INCIDENT BRIEFING:
Type: ${incident.type}${incident.subtype ? `/${incident.subtype}` : ''}
Zone: ${incident.zone}
Priority: ${incident.priority}/10
Description: ${incident.description}
Incident ID: ${incident.id}

AVAILABLE UNITS:
${snapshot.units
    .filter(unit => unit.status === 'available')
    .map(unit => `  ${unit.id}: ${unit.name} (${unit.type}) at zone ${unit.currentZone}`)
    .join('\n') || '  None available'}

BLOCKED ROADS: ${snapshot.blockedEdges.length > 0 ? snapshot.blockedEdges.join(', ') : 'None'}

${directive ? `COORDINATOR DIRECTIVE: ${directive}` : ''}

Respond and act now.`;
}

function convertSchemasToGemini(openAiSchemas) {
  return openAiSchemas.map(schema => ({
    name: schema.function.name,
    description: schema.function.description,
    parameters: convertSchemaNode(schema.function.parameters || { type: 'object', properties: {} }),
  }));
}

function convertSchemaNode(node) {
  const type = toGeminiType(node?.type || 'object');
  const converted = { type };

  if (node?.description) converted.description = node.description;
  if (node?.enum) converted.enum = [...node.enum];

  if (type === 'OBJECT') {
    converted.properties = {};
    for (const [key, value] of Object.entries(node?.properties || {})) {
      converted.properties[key] = convertSchemaNode(value);
    }
    if (node?.required?.length) converted.required = [...node.required];
  }

  if (type === 'ARRAY') {
    converted.items = convertSchemaNode(node?.items || { type: 'string' });
  }

  return converted;
}

function toGeminiType(type) {
  switch ((type || 'string').toLowerCase()) {
    case 'object':
      return 'OBJECT';
    case 'array':
      return 'ARRAY';
    case 'number':
      return 'NUMBER';
    case 'integer':
      return 'INTEGER';
    case 'boolean':
      return 'BOOLEAN';
    default:
      return 'STRING';
  }
}

function extractFunctionCalls(response) {
  if (typeof response?.functionCalls === 'function') {
    return (response.functionCalls() || []).map(call => ({
      name: call.name,
      args: call.args || {},
    }));
  }

  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter(part => part.functionCall)
    .map(part => ({
      name: part.functionCall.name,
      args: part.functionCall.args || {},
    }));
}

function safeBroadcast(payload) {
  try {
    broadcast(payload);
  } catch (err) {
    logger.warn('Sub-agent broadcast failed:', err.message);
  }
}

function safeBroadcastToken(agentId, incidentId, token, done) {
  try {
    broadcastToken(agentId, incidentId, token, done);
  } catch (err) {
    logger.warn('Sub-agent token broadcast failed:', err.message);
  }
}
