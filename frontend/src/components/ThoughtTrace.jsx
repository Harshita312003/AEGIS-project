// import { useEffect, useRef } from 'react';
// import { useWorldStore } from '../store/useWorldStore.js';

// const TOOL_READABLE = {
//   getAvailableUnits: '🔍 Checked available units',
//   getRoute: '📍 Calculated fastest route',
//   blockRoad: '🚧 Closed blocked road',
//   dispatchUnit: '🚀 Dispatched unit to scene',
//   returnUnit: '↩️ Recalled unit to base',
//   notifyCitizens: '📢 Broadcast public alert',
//   getHospitalCapacity: '🏥 Checked hospital beds',
//   updateHospitalCapacity: '🏥 Updated hospital intake',
//   getWeather: '🌬️ Read wind and fire spread data',
// };

// const INCIDENT_ICONS = {
//   structural_fire: '🔥',
//   vehicle_accident: '🚗',
//   infrastructure_failure: '🌉',
//   mass_casualty: '🏥',
//   building_collapse: '🏗️',
//   power_outage: '⚡',
//   medical_emergency: '🚑',
//   hazmat: '☣️',
//   flooding: '🌊',
//   crime: '🚨',
// };

// const HIDDEN_PREFIXES = ['[Step', '[INCIDENT]', '[LIVE NEWS]', '[DEMO]', '[SIMULATION]', 'Status: Analyzing'];
// const EMPHASIS_PREFIXES = ['🔍', '📍', '🚧', '🚀', '📢', '🏥', '🌬️', '✓', '✗'];

// function toolLabel(name) {
//   return TOOL_READABLE[name] || `→ ${name}`;
// }

// function eventTypeLabel(type) {
//   return (type || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
// }

// function zoneLabel(zone) {
//   const map = {
//     CP: 'Connaught Place',
//     RP: 'Rajpath',
//     KB: 'Karol Bagh',
//     LN: 'Lajpat Nagar',
//     DW: 'Dwarka',
//     RH: 'Rohini',
//     SD: 'Shahdara',
//     NP: 'Nehru Place',
//     IGI: 'IGI Airport',
//     OKH: 'Okhla',
//   };
//   return map[zone] || zone;
// }

// function extractThoughtMeta(thought) {
//   const fallbackType = (thought.tokens.match(/Type: ([^\n]+)/) || [])[1]?.trim();
//   const fallbackZone = (thought.tokens.match(/Zone: ([^\s|]+)/) || [])[1]?.trim();
//   const eventType = thought.eventType || fallbackType || '';
//   const zone = thought.zone || fallbackZone || '';
//   return { eventType, zone };
// }

// function isMeaningfulReasoningLine(line) {
//   if (!line) return false;
//   if (HIDDEN_PREFIXES.some(prefix => line.startsWith(prefix))) return false;
//   if (/^(Source:|Type:|Zone:|Priority:|ID:)/.test(line)) return false;
//   if (/^Analyzing city state/i.test(line)) return false;
//   return true;
// }

// function getVisibleThoughtLines(tokens) {
//   const normalizedLines = (tokens || '')
//     .split(/\r?\n/)
//     .map(line => line.trim())
//     .filter(Boolean)
//     .filter(isMeaningfulReasoningLine)
//     .filter(line => {
//       if (EMPHASIS_PREFIXES.some(prefix => line.startsWith(prefix))) return true;
//       return /[a-z]/i.test(line);
//     });

//   const combined = normalizedLines.join('\n');
//   const clipped = combined.length > 800 ? combined.slice(-800) : combined;
//   return clipped.split('\n').map(line => line.trim()).filter(Boolean);
// }

// function lineStyle(line) {
//   const emphasized = EMPHASIS_PREFIXES.some(prefix => line.startsWith(prefix));
//   if (!emphasized) return {};

//   return {
//     color: line.startsWith('✗') ? '#f87171' : '#fbbf24',
//     background: line.startsWith('✗') ? 'rgba(239,68,68,0.08)' : 'rgba(234,179,8,0.08)',
//     borderRadius: '4px',
//     padding: '2px 6px',
//   };
// }

// function ActiveCard({ thought }) {
//   const scrollRef = useRef(null);
//   const toolCalls = thought.toolCalls || [];
//   const visibleLines = getVisibleThoughtLines(thought.tokens);
//   const dispatched = toolCalls.filter(tool => tool.tool === 'dispatchUnit' && tool.result?.success);
//   const { eventType, zone } = extractThoughtMeta(thought);
//   const incidentIcon = INCIDENT_ICONS[eventType] || '🧠';
//   const title = `${incidentIcon} ${eventTypeLabel(eventType) || 'Incident'}${zone ? ` — ${zoneLabel(zone)}` : ''}`;

//   useEffect(() => {
//     if (scrollRef.current) {
//       scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
//     }
//   }, [thought.tokens, visibleLines.length]);

//   return (
//     <div style={{ border: '1px solid rgba(0,255,136,0.25)', borderRadius: '10px', background: 'rgba(0,255,136,0.03)', overflow: 'hidden' }}>
//       <div
//         style={{
//           display: 'flex',
//           alignItems: 'center',
//           gap: '10px',
//           padding: '10px 14px',
//           background: 'rgba(0,0,0,0.2)',
//           borderBottom: '1px solid rgba(0,255,136,0.1)',
//         }}
//       >
//         <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#00ff88', boxShadow: '0 0 8px #00ff88', animation: 'pulse 0.8s ease-in-out infinite', flexShrink: 0 }} />
//         <div style={{ minWidth: 0, flex: 1 }}>
//           <div style={{ fontSize: '13px', fontWeight: '600', color: '#00ff88', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
//             {title}
//           </div>
//           <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px', flexWrap: 'wrap' }}>
//             <span style={{ fontSize: '11px', color: '#475569' }}>
//               {toolCalls.length} action{toolCalls.length !== 1 ? 's' : ''} taken
//             </span>
//             {dispatched.length > 0 && (
//               <span style={{ fontSize: '10px', color: '#00ff88', background: 'rgba(0,255,136,0.1)', padding: '1px 6px', borderRadius: '10px', fontWeight: '700' }}>
//                 {dispatched.length} unit{dispatched.length !== 1 ? 's' : ''} deployed
//               </span>
//             )}
//           </div>
//         </div>
//       </div>

//       <div
//         ref={scrollRef}
//         style={{
//           padding: '12px 14px',
//           maxHeight: '220px',
//           overflowY: 'auto',
//           fontFamily: 'var(--font-mono)',
//           fontSize: '12px',
//           color: '#94a3b8',
//           lineHeight: 1.8,
//           whiteSpace: 'pre-wrap',
//           wordBreak: 'break-word',
//           display: 'flex',
//           flexDirection: 'column',
//           gap: '4px',
//         }}
//       >
//         {visibleLines.length > 0 ? (
//           visibleLines.map((line, index) => (
//             <div key={`${line}-${index}`} style={lineStyle(line)}>
//               {line}
//             </div>
//           ))
//         ) : (
//           <div>Starting analysis...</div>
//         )}
//         <span style={{ color: '#00ff88', animation: 'blink 1s step-end infinite' }}>▋</span>
//       </div>

//       {toolCalls.length > 0 && (
//         <div style={{ padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: '4px', borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: '10px' }}>
//           <div style={{ fontSize: '10px', fontWeight: '600', color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '2px' }}>
//             Actions taken
//           </div>
//           {toolCalls.map((toolCall, index) => {
//             const ok = toolCall.result?.success !== false;
//             return (
//               <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '4px 8px', borderRadius: '5px', background: ok ? 'rgba(234,179,8,0.06)' : 'rgba(239,68,68,0.06)' }}>
//                 <span style={{ color: ok ? '#fbbf24' : '#f87171', flex: 1 }}>{toolLabel(toolCall.tool)}</span>
//                 {toolCall.result?.message && (
//                   <span style={{ fontSize: '10px', color: '#475569', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
//                     {toolCall.result.message}
//                   </span>
//                 )}
//                 <span style={{ color: ok ? '#22c55e' : '#ef4444', flexShrink: 0 }}>{ok ? '✓' : '✗'}</span>
//               </div>
//             );
//           })}
//         </div>
//       )}
//     </div>
//   );
// }

// function HistoryPill({ thought }) {
//   const toolCalls = thought.toolCalls || [];
//   const dispatched = toolCalls.filter(tool => tool.tool === 'dispatchUnit' && tool.result?.success).length;
//   const { eventType, zone } = extractThoughtMeta(thought);
//   const incidentIcon = INCIDENT_ICONS[eventType] || '🧠';
//   const title = eventType
//     ? `${incidentIcon} ${eventTypeLabel(eventType)}${zone ? ` — ${zoneLabel(zone)}` : ''}`
//     : 'Incident handled';

//   let statusBadge = null;
//   if (dispatched > 0) {
//     statusBadge = {
//       label: `${dispatched} unit${dispatched !== 1 ? 's' : ''} sent`,
//       color: '#00ff88',
//       background: 'rgba(0,255,136,0.1)',
//     };
//   } else if (toolCalls.length === 0) {
//     statusBadge = {
//       label: 'no action taken',
//       color: '#94a3b8',
//       background: 'rgba(148,163,184,0.1)',
//     };
//   } else {
//     statusBadge = {
//       label: 'assessed — no units available',
//       color: '#fbbf24',
//       background: 'rgba(251,191,36,0.1)',
//     };
//   }

//   return (
//     <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 12px', borderRadius: '6px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
//       <span style={{ fontSize: '13px' }}>{incidentIcon}</span>
//       <div style={{ flex: 1, minWidth: 0 }}>
//         <div style={{ fontSize: '11px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
//           {title}
//         </div>
//       </div>
//       <span style={{ fontSize: '10px', color: statusBadge.color, background: statusBadge.background, padding: '1px 6px', borderRadius: '10px', flexShrink: 0 }}>
//         {statusBadge.label}
//       </span>
//     </div>
//   );
// }

// export default function ThoughtTrace() {
//   const activeThought = useWorldStore(s => s.activeThought);
//   const thoughtHistory = useWorldStore(s => s.thoughtHistory);
//   const isEmpty = !activeThought && thoughtHistory.length === 0;

//   return (
//     <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: '10px' }}>
//       <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
//         <div style={{ width: 7, height: 7, borderRadius: '50%', background: activeThought ? '#00ff88' : '#00d4ff', boxShadow: `0 0 6px ${activeThought ? '#00ff88' : '#00d4ff'}`, ...(activeThought ? { animation: 'pulse 0.8s ease-in-out infinite' } : {}) }} />
//         <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--c-cyan)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>AI Thought Stream</span>
//         {activeThought && <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#00ff88', fontWeight: '600' }}>● LIVE</span>}
//       </div>

//       <div style={{ flex: 1, overflowY: 'auto', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
//         {isEmpty && (
//           <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px', textAlign: 'center' }}>
//             <div style={{ fontSize: '36px' }}>🧠</div>
//             <div style={{ fontSize: '13px', color: '#475569' }}>
//               System monitoring Delhi — trigger a scenario to see live AI reasoning
//             </div>
//           </div>
//         )}

//         {activeThought && <ActiveCard thought={activeThought} />}

//         {thoughtHistory.length > 0 && (
//           <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
//             {activeThought && (
//               <div style={{ fontSize: '10px', color: '#334155', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '4px 0 2px' }}>
//                 Previous
//               </div>
//             )}
//             {thoughtHistory.map((thought, index) => (
//               <HistoryPill key={index} thought={thought} />
//             ))}
//           </div>
//         )}
//       </div>
//     </div>
//   );
// }








import { useRef, useEffect } from 'react';
import { useWorldStore } from '../store/useWorldStore.js';

const TOOL_READABLE = {
  getAvailableUnits:      '🔍 Checked available units',
  getRoute:               '📍 Calculated fastest route',
  blockRoad:              '🚧 Closed blocked road',
  dispatchUnit:           '🚀 Dispatched unit to scene',
  returnUnit:             '↩️  Recalled unit to base',
  notifyCitizens:         '📢 Broadcast public alert',
  getHospitalCapacity:    '🏥 Checked hospital beds',
  updateHospitalCapacity: '🏥 Updated hospital intake',
  getWeather:             '🌬️  Read wind & fire spread data',
};

function toolLabel(name) {
  return TOOL_READABLE[name] || `→ ${name}`;
}

const ZONE_NAMES = {
  CP:'Connaught Place', RP:'Rajpath', KB:'Karol Bagh', LN:'Lajpat Nagar',
  DW:'Dwarka', RH:'Rohini', SD:'Shahdara', NP:'Nehru Place',
  IGI:'IGI Airport', OKH:'Okhla',
};

function zoneLabel(z) { return ZONE_NAMES[z] || z; }

// Extract type + zone from the first line of the streaming text
// Format: "[LIVE NEWS] STRUCTURAL FIRE in LN — Priority 8/10"
function parseFirstLine(tokens) {
  const firstLine = (tokens || '').split('\n')[0] || '';
  const stripped  = firstLine.replace(/^\[[^\]]+\]\s*/, '');           // strip [SOURCE]
  const zoneMatch = stripped.match(/\bin\s+([A-Z]{2,3})\b/);
  const zone      = zoneMatch ? zoneMatch[1] : null;
  const typeRaw   = stripped.replace(/\s*—.*$/, '').replace(/\bin\s+[A-Z]{2,3}.*/, '').trim();
  const type      = typeRaw.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).slice(0, 32) || null;
  return { type, zone };
}

// ─── Active Card ──────────────────────────────────────────────────────────────

function ActiveCard({ thought }) {
  const scrollRef = useRef(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [thought.tokens]);

  const tools      = thought.toolCalls || [];
  const dispatched = tools.filter(t => (t.tool || t.name) === 'dispatchUnit' && t.result?.success);
  const { type, zone } = parseFirstLine(thought.tokens);

  return (
    <div style={{ border:'1px solid rgba(0,255,136,0.25)', borderRadius:'10px', background:'rgba(0,255,136,0.03)', overflow:'hidden' }}>

      {/* Header — shows incident type + zone + live counters */}
      <div style={{ display:'flex', alignItems:'center', gap:'10px', padding:'10px 14px', background:'rgba(0,0,0,0.2)', borderBottom:'1px solid rgba(0,255,136,0.1)' }}>
        <div style={{ width:8, height:8, borderRadius:'50%', background:'#00ff88', boxShadow:'0 0 8px #00ff88', animation:'pulse 0.8s ease-in-out infinite', flexShrink:0 }} />
        <div style={{ flex:1 }}>
          <div style={{ fontSize:'12px', fontWeight:'700', color:'#e2e8f0', lineHeight:1 }}>
            {type && zone ? `${type} — ${zoneLabel(zone)}` : type || 'AI coordinating response'}
          </div>
          <div style={{ fontSize:'10px', color:'#475569', marginTop:'2px' }}>AI is thinking now</div>
        </div>
        <div style={{ display:'flex', gap:'8px', alignItems:'center', flexShrink:0 }}>
          {tools.length > 0 && (
            <span style={{ fontSize:'10px', color:'#64748b' }}>
              {tools.length} action{tools.length > 1 ? 's' : ''}
            </span>
          )}
          {dispatched.length > 0 && (
            <span style={{ fontSize:'10px', color:'#00ff88', background:'rgba(0,255,136,0.1)', padding:'1px 7px', borderRadius:'10px', border:'1px solid rgba(0,255,136,0.3)' }}>
              {dispatched.length} dispatched
            </span>
          )}
        </div>
      </div>

      {/* Live streaming text */}
      <div
        ref={scrollRef}
        style={{ padding:'12px 14px', maxHeight:'200px', overflowY:'auto', fontFamily:'var(--font-mono)', fontSize:'12px', color:'#94a3b8', lineHeight:1.8, whiteSpace:'pre-wrap', wordBreak:'break-word' }}
      >
        {thought.tokens || 'Starting analysis...'}
        <span style={{ color:'#00ff88', animation:'blink 1s step-end infinite' }}>▊</span>
      </div>

      {/* Tool calls executed so far */}
      {tools.length > 0 && (
        <div style={{ padding:'0 14px 12px', display:'flex', flexDirection:'column', gap:'4px', borderTop:'1px solid rgba(255,255,255,0.04)', paddingTop:'10px' }}>
          <div style={{ fontSize:'10px', fontWeight:'600', color:'#475569', letterSpacing:'0.08em', textTransform:'uppercase', marginBottom:'2px' }}>Actions taken</div>
          {tools.map((tc, i) => {
            const name = tc.tool || tc.name;
            const ok   = tc.result?.success !== false;
            const msg  = tc.result?.message || tc.result?.recommendation || tc.result?.note;
            return (
              <div key={i} style={{ display:'flex', alignItems:'center', gap:'8px', fontSize:'12px', padding:'4px 8px', borderRadius:'5px', background: ok ? 'rgba(234,179,8,0.06)' : 'rgba(239,68,68,0.06)' }}>
                <span style={{ color: ok ? '#fbbf24' : '#f87171', flex:1 }}>{toolLabel(name)}</span>
                {msg && <span style={{ fontSize:'10px', color:'#475569', maxWidth:'180px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{String(msg).slice(0,60)}</span>}
                <span style={{ color: ok ? '#22c55e' : '#ef4444', flexShrink:0 }}>{ok ? '✓' : '✗'}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── History Pill — uses pre-computed _summary fields from store ──────────────

function HistoryPill({ thought }) {
  // Use pre-computed fields set in useWorldStore.appendToken when done=true
  const type       = thought._type       || 'Incident';
  const zone       = thought._zone       ? zoneLabel(thought._zone) : null;
  const summary    = thought._summary    || 'Processed';
  const dispatched = thought._dispatched || 0;
  const blocked    = thought._blocked    || 0;
  const toolCount  = thought._toolCount  || thought.toolCalls?.length || 0;
  const time       = thought._completedAt
    ? new Date(thought._completedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
    : '';

  // Badge style based on outcome
  const badge = dispatched > 0
    ? { text:`${dispatched} unit${dispatched>1?'s':''} sent`, bg:'rgba(0,255,136,0.1)',  color:'#00ff88', border:'rgba(0,255,136,0.3)' }
    : blocked > 0
    ? { text:'road closed',                                   bg:'rgba(255,107,53,0.1)', color:'#ff6b35', border:'rgba(255,107,53,0.3)' }
    : toolCount > 0
    ? { text:'assessed',                                      bg:'rgba(255,215,0,0.08)', color:'#ffd700', border:'rgba(255,215,0,0.3)' }
    : { text:'no action',                                     bg:'rgba(100,116,139,0.08)', color:'#64748b', border:'rgba(100,116,139,0.2)' };

  return (
    <div style={{ display:'flex', flexDirection:'column', padding:'8px 12px', borderRadius:'7px', background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.05)', gap:'4px' }}>

      {/* Row 1: type + zone + time */}
      <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
        <span style={{ fontSize:'12px' }}>🧠</span>
        <span style={{ fontSize:'11px', fontWeight:'600', color:'#94a3b8', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {type}{zone ? ` — ${zone}` : ''}
        </span>
        <span style={{ fontSize:'9px', color:'#334155', flexShrink:0 }}>{time}</span>
      </div>

      {/* Row 2: what the AI actually did */}
      <div style={{ display:'flex', alignItems:'center', gap:'6px', paddingLeft:'18px' }}>
        <span style={{ fontSize:'10px', color:'#64748b', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {summary}
        </span>
        <span style={{ fontSize:'9px', fontWeight:'600', padding:'1px 7px', borderRadius:'10px', background:badge.bg, color:badge.color, border:`1px solid ${badge.border}`, flexShrink:0 }}>
          {badge.text}
        </span>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ThoughtTrace() {
  const activeThought  = useWorldStore(s => s.activeThought);
  const thoughtHistory = useWorldStore(s => s.thoughtHistory);
  const isEmpty = !activeThought && thoughtHistory.length === 0;

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', background:'var(--c-surface)', border:'1px solid var(--c-border)', borderRadius:'10px' }}>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'10px 14px', borderBottom:'1px solid rgba(255,255,255,0.05)', flexShrink:0 }}>
        <div style={{ width:7, height:7, borderRadius:'50%', background: activeThought ? '#00ff88' : '#00d4ff', boxShadow:`0 0 6px ${activeThought ? '#00ff88' : '#00d4ff'}`, ...(activeThought ? { animation:'pulse 0.8s ease-in-out infinite' } : {}) }} />
        <span style={{ fontSize:'12px', fontWeight:'600', color:'var(--c-cyan)', letterSpacing:'0.08em', textTransform:'uppercase' }}>AI Thought Stream</span>
        {activeThought && <span style={{ marginLeft:'auto', fontSize:'11px', color:'#00ff88', fontWeight:'600' }}>● LIVE</span>}
      </div>

      {/* Content */}
      <div style={{ flex:1, overflowY:'auto', padding:'10px', display:'flex', flexDirection:'column', gap:'8px' }}>

        {isEmpty && (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:'12px', textAlign:'center' }}>
            <div style={{ fontSize:'36px' }}>🧠</div>
            <div style={{ fontSize:'13px', color:'#475569' }}>System monitoring Delhi</div>
            <div style={{ fontSize:'11px', color:'#334155', lineHeight:1.7 }}>
              Go to <strong style={{ color:'#64748b' }}>Control Room</strong><br />
              and trigger a scenario to watch<br />
              the AI reason live
            </div>
          </div>
        )}

        {/* Active thought — always on top, full card */}
        {activeThought && <ActiveCard thought={activeThought} />}

        {/* Completed thoughts — two-row pills with real summary */}
        {thoughtHistory.length > 0 && (
          <div style={{ display:'flex', flexDirection:'column', gap:'5px' }}>
            {activeThought && (
              <div style={{ fontSize:'10px', color:'#334155', letterSpacing:'0.08em', textTransform:'uppercase', padding:'4px 0 2px' }}>Previous</div>
            )}
            {thoughtHistory.map((t, i) => <HistoryPill key={t.id || i} thought={t} />)}
          </div>
        )}
      </div>
    </div>
  );
}