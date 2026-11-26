// Transport: Supabase Realtime Broadcast, or BroadcastChannel in local test mode.
// One channel per room: gn-<code lowercase>, broadcast event "m".
import { isLocalMode } from './proto.js';

export function createNet(room, { onMessage, onStatus } = {}) {
  const name = 'gn-' + room.toLowerCase();
  const local = isLocalMode();
  let status = 'connecting';
  const setStatus = (s) => { if (s !== status) { status = s; onStatus && onStatus(s); } };
  const deliver = (msg) => {
    if (!msg || typeof msg !== 'object' || msg.room !== room) return;
    try { onMessage && onMessage(msg); } catch (e) { console.error(e); }
  };
  const tap = []; // test/debug listeners on raw outbound + inbound traffic

  if (local) {
    const bc = new BroadcastChannel(name);
    bc.onmessage = (e) => { tap.forEach((f) => f('in', e.data)); deliver(e.data); };
    queueMicrotask(() => setStatus('local'));
    return {
      local: true,
      get status() { return status; },
      send(msg) { tap.forEach((f) => f('out', msg)); try { bc.postMessage(msg); } catch (e) { console.warn(e); } },
      close() { bc.close(); },
      tap,
    };
  }

  const cfg = window.GN_CONFIG;
  if (!window.supabase) throw new Error('supabase-js failed to load');
  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 20 } },
  });
  const ch = client.channel(name, { config: { broadcast: { self: false, ack: false } } });
  ch.on('broadcast', { event: 'm' }, ({ payload }) => { tap.forEach((f) => f('in', payload)); deliver(payload); });
  ch.subscribe((s) => {
    if (s === 'SUBSCRIBED') setStatus('online');
    else if (s === 'CLOSED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') setStatus('offline');
  });
  return {
    local: false,
    get status() { return status; },
    send(msg) {
      tap.forEach((f) => f('out', msg));
      if (status !== 'online') return; // periodic resends will catch up
      ch.send({ type: 'broadcast', event: 'm', payload: msg }).catch(() => {});
    },
    close() { try { client.removeChannel(ch); } catch {} },
    tap,
  };
}
