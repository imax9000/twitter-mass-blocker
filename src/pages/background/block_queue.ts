import { TwitterProxyClient, ExtensionConfigStore } from 'twitter-proxy-client';
import * as credentials from 'credentials';
import * as _ from 'global';
import { UserHandle, Operation } from 'state_structs';
import * as log from 'logging';

import * as operations from './operations';

const blockQueueOpType = 'block_queue';
const muteQueueOpType = 'mute_queue';

type QueueType = Operation.BlockQueue.QueueType;
type State = Operation.BlockQueue.State;

const client = new TwitterProxyClient(new ExtensionConfigStore(), credentials.clientID);

export type UserCallback = (user: UserHandle) => any;
const onMuted: UserCallback[] = [];
const onBlocked: UserCallback[] = [];

export function addOnMuteListener(cb: UserCallback) { onMuted.push(cb); }
export function addOnBlockListener(cb: UserCallback) { onBlocked.push(cb); }
function runCallbacks(u: UserHandle, cbs: UserCallback[]) { cbs.forEach((cb) => cb(u)); }

async function append(prefix: QueueType, entries: UserHandle[]): Promise<void> {
  const id = `${prefix}:${crypto.randomUUID()}`;
  const v: { [key: string]: any } = {};
  v[id] = entries;
  return browser.storage.local.set(v);
}

async function getStateWithMergedAppends(prefix: QueueType): Promise<State> {
  let r: UserHandle[] = [];
  const storage = await browser.storage.local.get();
  const to_delete: string[] = [];
  for (const id in storage) {
    if (id.startsWith(`${prefix}:`)) {
      to_delete.push(id);
      r = r.concat(storage[id]);
    }
  }

  let state: State | undefined = storage[operations.storageKey(prefix)];
  if (state === undefined) {
    state = {
      type: prefix,
      users: [],
    };
  }
  const existing_ids: { [key: string]: boolean } = {};
  for (const user of state.users) {
    existing_ids[user.id] = true;
  }
  state.users = state.users.concat(r.filter((user) => !existing_ids[user.id]));
  await operations.add(prefix, state);
  // Now that the merged list is persisted in the main state entry, we can safely
  // delete the appends that we merged in.
  browser.storage.local.remove(to_delete);
  return state;
}

export async function queueBlocks(entries: UserHandle[]): Promise<void> {
  return append(blockQueueOpType, entries);
}

export async function queueMutes(entries: UserHandle[]): Promise<void> {
  return append(muteQueueOpType, entries);
}

async function processQueue(id: string, state_: Operation.State): Promise<void> {
  if (id != blockQueueOpType && id != muteQueueOpType) {
    throw `Unknown queue ID "${id}"`;
  }
  const state = await getStateWithMergedAppends(id as QueueType);
  const result = await client.consume(state.users,
    (user) => {
      return {
        method: 'POST',
        endpoint: id == blockQueueOpType ? '/2/users/:id/blocking' : '/2/users/:id/muting',
        data: { target_user_id: user.id },
      }
    },
    (user, error) => storeError(id, user, error.response ? error.response : error),
    (user) => runCallbacks(user, id == blockQueueOpType ? onBlocked : onMuted));
  await operations.add(id, state);
  if ('done' in result) {
    operations.scheduleAlarm(id, Date.now() + 300 * 1000);
  } else if ('resume_after' in result) {
    operations.scheduleAlarm(id, result.resume_after);
  } else {
    operations.scheduleAlarm(id, Date.now() + 300 * 1000);
    throw result.error;
  }
}

operations.registerHandler(blockQueueOpType, processQueue);
operations.registerHandler(muteQueueOpType, processQueue);

async function storeError(queue: QueueType, user: UserHandle, error: any) {
  return log.recordError(error, { context: { user, operation: queue } });
}

[blockQueueOpType, muteQueueOpType].forEach(async (queue) => {
  const key = `errors:${queue}`;
  const errors = (await browser.storage.local.get(key)) as Record<string, { user: UserHandle, error: any }[]>;
  if (errors[key]) {
    for (const e of errors[key]) {
      log.recordError(e.error, { context: { user: e.user, operation: queue } });
    }
    browser.storage.local.remove(key);
  }
});

(async () => {
  const ops = await browser.storage.local.get([operations.storageKey(blockQueueOpType), operations.storageKey(muteQueueOpType)]);
  // Only schedule alarms if there was no state in the storage.
  // If there is - it'll be scheduled in onStartup handler.
  if (!ops[operations.storageKey(blockQueueOpType)]) {
    await operations.add(blockQueueOpType, { type: blockQueueOpType, users: [] } as Operation.State);
    operations.scheduleAlarm(blockQueueOpType, Date.now() + 5000);
  }
  if (!ops[operations.storageKey(muteQueueOpType)]) {
    await operations.add(muteQueueOpType, { type: muteQueueOpType, users: [] } as Operation.State);
    operations.scheduleAlarm(muteQueueOpType, Date.now() + 5000);
  }
})();
