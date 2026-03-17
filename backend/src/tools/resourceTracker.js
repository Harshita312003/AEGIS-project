import { worldState } from '../core/worldState.js';
import { logger } from '../utils/logger.js';
import { broadcast } from '../utils/broadcast.js';

export async function getAvailableUnits({ type = null, zone = null } = {}) {
  logger.tool('getAvailableUnits', { type, zone });

  const units = worldState.getAvailableUnits(type, zone);
  const summary = {
    police: units.filter(unit => unit.type === 'police').length,
    fire: units.filter(unit => unit.type === 'fire').length,
    ems: units.filter(unit => unit.type === 'ems').length,
    traffic: units.filter(unit => unit.type === 'traffic').length,
  };

  return {
    success: true,
    totalAvailable: units.length,
    summary,
    units: units.map(unit => ({
      id: unit.id,
      name: unit.name,
      callSign: unit.callSign,
      type: unit.type,
      subtype: unit.subtype,
      currentZone: unit.currentZone,
      specialty: unit.specialty,
      capacity: unit.capacity,
      equipment: unit.equipment,
    })),
    note: units.length === 0
      ? `No ${type || 'any'} units available${zone ? ` in ${zone}` : ''}. All units may be dispatched.`
      : `${units.length} unit(s) available for dispatch.`,
  };
}

export async function dispatchUnit({ unitId, destination, incidentId }) {
  logger.tool('dispatchUnit', { unitId, destination, incidentId });

  const unit = worldState.getUnit(unitId);
  if (unit && unit.status !== 'available') {
    const alternatives = worldState.getAvailableUnits(unit.type);
    safeBroadcast({
      type: 'CONFLICT_DETECTED',
      payload: {
        requestedUnit: unitId,
        requestedBy: incidentId,
        currentlyServing: unit.incidentId,
        unitType: unit.type,
        alternativesCount: alternatives.length,
        resolution: alternatives.length > 0
          ? `Redirected to ${alternatives[0].name} (${alternatives[0].currentZone})`
          : 'No alternatives - queued for next available unit',
        timestamp: new Date().toISOString(),
      },
    });

    logger.warn(`Conflict detected for ${unitId}: already serving ${unit.incidentId}`);
    return {
      success: false,
      error: `${unit.name} is dispatched to incident ${unit.incidentId}`,
      alternatives: alternatives.slice(0, 3).map(alternative => ({
        id: alternative.id,
        name: alternative.name,
        currentZone: alternative.currentZone,
      })),
      resolution: alternatives.length > 0
        ? `Use ${alternatives[0].id} (${alternatives[0].name}) instead`
        : 'All units of this type are deployed',
    };
  }

  try {
    const dispatchedUnit = worldState.dispatchUnit(unitId, destination, incidentId);
    return {
      success: true,
      unit: {
        id: dispatchedUnit.id,
        name: dispatchedUnit.name,
        callSign: dispatchedUnit.callSign,
        type: dispatchedUnit.type,
        currentZone: dispatchedUnit.currentZone,
        destination,
      },
      incidentId,
      message: `${dispatchedUnit.callSign} dispatched to ${destination} for incident ${incidentId}. Status: DISPATCHED.`,
    };
  } catch (err) {
    logger.error('dispatchUnit failed:', err.message);
    const alternatives = worldState.getAvailableUnits(unit?.type);
    return {
      success: false,
      error: err.message,
      alternatives: alternatives.slice(0, 3).map(alternative => ({
        id: alternative.id,
        name: alternative.name,
        zone: alternative.currentZone,
      })),
    };
  }
}

export async function returnUnit({ unitId }) {
  logger.tool('returnUnit', { unitId });

  try {
    const unit = worldState.returnUnit(unitId);
    return {
      success: true,
      unit: { id: unit.id, name: unit.name, currentZone: unit.currentZone },
      message: `${unit.name} returned to available status in zone ${unit.currentZone}.`,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function notifyCitizens({ zone, message, severity }) {
  logger.tool('notifyCitizens', { zone, message, severity });

  const notification = {
    id: `notif-${Date.now()}`,
    zone,
    message,
    severity,
    timestamp: new Date().toISOString(),
    channel: 'public_alert_system',
  };

  worldState.emit('citizenNotification', notification);
  worldState.emit('stateChange', {
    type: 'CITIZEN_NOTIFICATION',
    payload: notification,
  });

  return {
    success: true,
    notification,
    message: `Public alert broadcast to ${zone} (severity: ${severity}): "${message}"`,
  };
}

function safeBroadcast(payload) {
  try {
    broadcast(payload);
  } catch (err) {
    logger.warn('Conflict broadcast failed:', err.message);
  }
}

const ZONE_ENUM = ['CP', 'RP', 'KB', 'LN', 'DW', 'RH', 'SD', 'NP', 'IGI', 'OKH'];

export const getAvailableUnitsSchema = {
  type: 'function',
  function: {
    name: 'getAvailableUnits',
    description:
      'Get all available (non-dispatched) emergency units. ' +
      'Filter by type (police/fire/ems/traffic) and/or zone to find nearest units to an incident. ' +
      'Always call this before dispatching to verify unit availability.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Filter by unit type. Omit to get all types.',
          enum: ['police', 'fire', 'ems', 'traffic'],
        },
        zone: {
          type: 'string',
          description: 'Filter to only units currently in this zone. Omit for city-wide search.',
          enum: ZONE_ENUM,
        },
      },
      required: [],
    },
  },
};

export const dispatchUnitSchema = {
  type: 'function',
  function: {
    name: 'dispatchUnit',
    description:
      'Dispatch a specific emergency unit to a destination zone for an incident. ' +
      'The unit status immediately changes to dispatched. ' +
      'Always get the route first to confirm travel time, then dispatch.',
    parameters: {
      type: 'object',
      properties: {
        unitId: {
          type: 'string',
          description: 'Unit ID from getAvailableUnits (e.g. "P-1", "F-2", "E-3", "T-1")',
        },
        destination: {
          type: 'string',
          description: 'Destination zone ID where the unit should go.',
          enum: ZONE_ENUM,
        },
        incidentId: {
          type: 'string',
          description: 'The incident ID this unit is being dispatched for.',
        },
      },
      required: ['unitId', 'destination', 'incidentId'],
    },
  },
};

export const returnUnitSchema = {
  type: 'function',
  function: {
    name: 'returnUnit',
    description:
      'Return a dispatched unit to available status. ' +
      'Use during replan to recall units that are en-route via a now-blocked road, ' +
      'or after an incident is resolved.',
    parameters: {
      type: 'object',
      properties: {
        unitId: {
          type: 'string',
          description: 'ID of the unit to return to available status.',
        },
      },
      required: ['unitId'],
    },
  },
};

export const notifyCitizensSchema = {
  type: 'function',
  function: {
    name: 'notifyCitizens',
    description:
      'Send a public emergency alert to citizens in a specific zone. ' +
      'Use for evacuation orders, road closures, shelter-in-place directives, or safety warnings.',
    parameters: {
      type: 'object',
      properties: {
        zone: {
          type: 'string',
          description: 'Zone ID to broadcast the alert to.',
          enum: ZONE_ENUM,
        },
        message: {
          type: 'string',
          description: 'Clear, actionable alert message for citizens. Keep it under 100 characters.',
        },
        severity: {
          type: 'string',
          description: 'Alert severity level.',
          enum: ['low', 'medium', 'high', 'critical'],
        },
      },
      required: ['zone', 'message', 'severity'],
    },
  },
};
