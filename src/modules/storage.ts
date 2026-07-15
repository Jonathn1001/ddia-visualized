// src/modules/storage.ts
import type { NodeId } from '../engine/events';
import type { InspectorTree, MetricSample, SimModule } from '../engine/module';
import {
  LSM, writeAmp, type StoragePayload,
} from './storage-shared';
import { lsmInit, lsmReduce, lsmInspect, lsmGet, lsmSpaceAmp, type LsmState } from './lsm';
import { btreeInit, btreeReduce, btreeInspect, btreeGet, type BtreeState } from './btree';

export type StorageState = LsmState | BtreeState;

/** LSM space amplification — single source of truth lives in lsm.ts (also on LsmInspect). */
export const spaceAmpLsm = lsmSpaceAmp;

export const storage: SimModule<StorageState, StoragePayload> = {
  id: 'storage-engines',
  chaos: ['crash-mid-write', 'torn-write', 'disk-full'],

  init(nodeId, config) {
    return nodeId === LSM ? lsmInit(config) : btreeInit(config);
  },

  reduce(state, event) {
    return state.engine === 'lsm'
      ? lsmReduce(state, event as Parameters<typeof lsmReduce>[1])
      : btreeReduce(state, event as Parameters<typeof btreeReduce>[1]);
  },

  metrics(states) {
    const out: MetricSample[] = [];
    for (const s of states.values()) {
      if (s.engine === 'lsm') {
        out.push({ name: 'lsm/write-amp', value: writeAmp(s) });
        out.push({ name: 'lsm/read-amp', value: s.lastReadCost });
        out.push({ name: 'lsm/space-amp', value: spaceAmpLsm(s) });
        out.push({ name: 'lsm/disk-writes', value: s.diskWrites });
      } else {
        out.push({ name: 'btree/write-amp', value: writeAmp(s) });
        out.push({ name: 'btree/read-amp', value: s.lastReadCost });
        out.push({ name: 'btree/height', value: s.height });
        out.push({ name: 'btree/disk-writes', value: s.diskWrites });
      }
    }
    return out;
  },

  inspect(state) {
    return (state.engine === 'lsm' ? lsmInspect(state) : btreeInspect(state)) as unknown as InspectorTree;
  },
};

/** Read a key from a node's engine — used by challenge verifiers (does not mutate the sim). */
export function readValue(states: Map<NodeId, StorageState>, node: NodeId, key: string): string | undefined {
  const s = states.get(node);
  if (!s) return undefined;
  return s.engine === 'lsm' ? lsmGet(s, key).value : btreeGet(s, key).value;
}
