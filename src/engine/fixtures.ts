import type { NodeId } from './events';
import type { InspectorTree, SimModule } from './module';

/** Single node counts to 3 via self-timers. Exercises init + timer effects. */
export interface CounterState {
  self: NodeId;
  count: number;
}

export const counter: SimModule<CounterState, null> = {
  id: 'counter',
  chaos: [],
  init: (nodeId) => ({ self: nodeId, count: 0 }),
  reduce: (state, event) => {
    if (event.kind === 'init') return [state, [{ type: 'timer', delay: 10, payload: null }]];
    if (event.kind === 'timer') {
      const next = { ...state, count: state.count + 1 };
      return [next, next.count < 3 ? [{ type: 'timer', delay: 10, payload: null }] : []];
    }
    return [state, []];
  },
  metrics: () => [],
  inspect: (s) => ({ ...s }) as InspectorTree,
};

/** 'a' pings 'b'; 'b' pongs back. Exercises send effects + from-field. */
export interface EchoState {
  self: NodeId;
  got: string[];
}

export const echo: SimModule<EchoState, { msg: string } | null> = {
  id: 'echo',
  chaos: [],
  init: (nodeId) => ({ self: nodeId, got: [] }),
  reduce: (state, event) => {
    if (event.kind === 'init' && state.self === 'a')
      return [state, [{ type: 'send', to: 'b', payload: { msg: 'ping' } }]];
    if (event.kind === 'message') {
      const { msg } = event.payload as { msg: string };
      const next = { ...state, got: [...state.got, msg] };
      if (msg === 'ping') return [next, [{ type: 'send', to: event.from!, payload: { msg: 'pong' } }]];
      return [next, []];
    }
    return [state, []];
  },
  metrics: () => [],
  inspect: (s) => ({ ...s }) as InspectorTree,
};

/**
 * Ring of nodes that never stops talking: every node re-arms a jittered
 * timer forever and forwards hops. Generates an unbounded, RNG-dependent
 * event stream — used for determinism and scrubbing tests.
 */
export interface ChatState {
  self: NodeId;
  next: NodeId;
  heard: number;
}

export const chatty: SimModule<ChatState, { hop: number } | null> = {
  id: 'chatty',
  chaos: ['partition', 'delay', 'drop', 'duplicate', 'kill-node'],
  init: (nodeId, config) => {
    const ids = config.nodeIds;
    return { self: nodeId, next: ids[(ids.indexOf(nodeId) + 1) % ids.length], heard: 0 };
  },
  reduce: (state, event, rng) => {
    if (event.kind === 'init')
      return [state, [
        { type: 'send', to: state.next, payload: { hop: 1 } },
        { type: 'timer', delay: rng.int(1, 5), payload: null },
      ]];
    if (event.kind === 'message') {
      const { hop } = event.payload as { hop: number };
      return [{ ...state, heard: state.heard + 1 }, [{ type: 'send', to: state.next, payload: { hop: hop + 1 } }]];
    }
    if (event.kind === 'timer')
      return [state, [
        { type: 'send', to: state.next, payload: { hop: 0 } },
        { type: 'timer', delay: rng.int(1, 5), payload: null },
      ]];
    return [state, []];
  },
  metrics: (states) => {
    let sum = 0;
    for (const s of states.values()) sum += s.heard;
    return [{ name: 'messages-heard', value: sum }];
  },
  inspect: (s) => ({ ...s }) as InspectorTree,
};
