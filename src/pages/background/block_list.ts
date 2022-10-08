import * as tt from 'twitter-types';

import { Request, TwitterProxyClient, ExtensionConfigStore } from 'twitter-proxy-client';
import * as credentials from 'credentials';
import type * as _ from 'global';
import { UserHandle, Operation } from 'state_structs';
import * as logging from 'logging';

import * as operations from './operations';
import * as block_queue from './block_queue';
import * as db from './db';

const client = new TwitterProxyClient(new ExtensionConfigStore(), credentials.clientID);

const collectIntervalMs = 8 * 3600 * 1000;

async function collectUsers(id: string, state_: Operation.State) {
  const state = state_ as Operation.UserList.State;

  if (state.last_completion) {
    if (state.last_completion + collectIntervalMs > Date.now()) {
      operations.scheduleAlarm(id, state.last_completion + collectIntervalMs);
      return;
    }
  }

  const endpoint = {
    [Operation.UserList.BlockTypeName]: '/2/users/:id/blocking',
    [Operation.UserList.MuteTypeName]: '/2/users/:id/muting'
  }[state.type];

  const req: Request = { endpoint, method: 'GET', params: { max_results: 1000 } };
  const result = await client.collect(req, state.collect_state,
    (resp): UserHandle[] => resp.data.data.map((v: tt.APIUser) => {
      return { id: v.id, username: v.username }
    }));

  state.collect_state = result.state;
  state.users = state.users.concat(result.collected_items);
  await operations.add(id, state);
  if ('done' in result.result) {
    const listStore = {
      [Operation.UserList.BlockTypeName]: 'BlockedOnTwitter',
      [Operation.UserList.MuteTypeName]: 'MutedOnTwitter',
    }[state.type] as 'BlockedOnTwitter' | 'MutedOnTwitter';
    const cacheStore = {
      [Operation.UserList.BlockTypeName]: 'Blocked',
      [Operation.UserList.MuteTypeName]: 'Muted',
    }[state.type] as 'Blocked' | 'Muted';

    await Promise.all([
      db.updateStore(listStore, state.users),
      db.removeFromStore(cacheStore, state.users),
    ]);

    const newState: Operation.UserList.State = {
      type: state.type,
      users: [],
      collect_state: {},
      last_completion: Date.now(),
    };
    await operations.add(id, newState);
    operations.scheduleAlarm(id, Date.now() + collectIntervalMs);
  } else if ('resume_after' in result.result) {
    operations.scheduleAlarm(id, result.result.resume_after);
  } else if ('error' in result.result) {
    logging.warn(result.result.error.message, { context: { operation: id }, data: result.result.error });
    operations.scheduleAlarm(id, Date.now() + 300 * 1000);
  }
}

operations.registerHandler(Operation.UserList.BlockTypeName, collectUsers);
operations.registerHandler(Operation.UserList.MuteTypeName, collectUsers);

block_queue.addOnBlockListener(async (u) => { db.put('Blocked', u); });
block_queue.addOnMuteListener(async (u) => { db.put('Muted', u); });

const cachedQueues: Record<string, Set<string>> = {
  [operations.storageKey(Operation.BlockQueue.BlockQueueName)]: new Set(),
  [operations.storageKey(Operation.BlockQueue.MuteQueueName)]: new Set(),
};

(async () => {
  const queue = await browser.storage.local.get(Object.keys(cachedQueues));
  for (const key in queue) {
    cachedQueues[key] = new Set(queue[key].users);
  }
})();

browser.storage.onChanged.addListener((changes, area) => {
  if (area != 'local') { return; }
  for (const key in changes) {
    if (!(key in cachedQueues)) { continue; }
    cachedQueues[key] = new Set(changes[key].newValue?.users);
  }
});

async function checkUser(user_id: string, recentStore: 'Blocked' | 'Muted', listStore: 'BlockedOnTwitter' | 'MutedOnTwitter', opType: Operation.BlockQueue.QueueType): Promise<boolean> {
  const recent = await db.get(recentStore, user_id);
  if (recent) { return true; }

  const stored = await db.get(listStore, user_id);
  if (stored) { return true; }

  return cachedQueues[operations.storageKey(opType)].has(user_id);
}

export async function isMuted(user_id: string): Promise<boolean> {
  return checkUser(user_id, 'Muted', 'MutedOnTwitter', 'mute_queue');
}
export async function isBlocked(user_id: string): Promise<boolean> {
  return checkUser(user_id, 'Blocked', 'BlockedOnTwitter', 'block_queue');
}

async function initState() {
  const ops = await browser.storage.local.get([
    Operation.UserList.BlockTypeName,
    Operation.UserList.MuteTypeName].map(operations.storageKey));

  if (!ops[operations.storageKey(Operation.UserList.BlockTypeName)]) {
    const state: Operation.UserList.State = {
      type: Operation.UserList.BlockTypeName,
      users: [],
      collect_state: {},
    };
    await operations.add(Operation.UserList.BlockTypeName, state);
  }
  operations.scheduleAlarm(Operation.UserList.BlockTypeName, Date.now() + 5000);

  if (!ops[operations.storageKey(Operation.UserList.MuteTypeName)]) {
    const state: Operation.UserList.State = {
      type: Operation.UserList.MuteTypeName,
      users: [],
      collect_state: {},
    };
    await operations.add(Operation.UserList.MuteTypeName, state);
  }
  operations.scheduleAlarm(Operation.UserList.MuteTypeName, Date.now() + 5000);
}

async function deleteState() {
  const ops = [
    Operation.UserList.BlockTypeName,
    Operation.UserList.MuteTypeName,
  ];
  ops.forEach(async (op) => {
    browser.alarms.clear(op);
    await operations.remove(op);
  });
  browser.storage.local.remove([Operation.UserList.BlockedListKey, Operation.UserList.MutedListKey]);
  await Promise.all([db.clear('Blocked'), db.clear('Muted')]);
}

(async () => {
  const keyToStore: Record<string, 'BlockedOnTwitter' | 'MutedOnTwitter'> = {
    [Operation.UserList.BlockedListKey]: 'BlockedOnTwitter',
    [Operation.UserList.MutedListKey]: 'MutedOnTwitter',
  };
  for (const key in keyToStore) {
    const { [key]: list } = await browser.storage.local.get(key);
    if (list) {
      await Promise.all((list as Operation.UserList.StoredList).users.map(u => db.put(keyToStore[key], u)));
      await browser.storage.local.remove(key);
    }
  }
})();
