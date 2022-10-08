import { openDB, DBSchema, StoreNames, StoreValue, StoreKey } from 'idb';

import { UserHandle } from 'state_structs';

interface DB extends DBSchema {
  Blocked: {
    value: UserHandle;
    key: string;
  };
  Muted: {
    value: UserHandle;
    key: string;
  };
  MutedOnTwitter: {
    value: UserHandle;
    key: string;
  };
  BlockedOnTwitter: {
    value: UserHandle;
    key: string;
  };
}

let db = openDB<DB>('blocked_and_muted', 2, {
  async upgrade(database, oldVersion, newVersion, transaction) {
    const migrations: (() => Promise<void>)[] = [
      async () => { }, // Dummy to fill index 0.
      async () => {
        database.createObjectStore('Blocked', { keyPath: 'id' });
        database.createObjectStore('Muted', { keyPath: 'id' });
      },
      async () => {
        const blockedStore = database.createObjectStore('BlockedOnTwitter', { keyPath: 'id' });
        const mutedStore = database.createObjectStore('MutedOnTwitter', { keyPath: 'id' });
      },
    ];
    for (let i = oldVersion + 1; i < migrations.length; i++) {
      await migrations[i]();
    }
  },
});

export async function put(objStore: StoreNames<DB>, value: any): Promise<string> {
  return (await db).put(objStore, value);
}

export async function add(objStore: StoreNames<DB>, value: any): Promise<string> {
  return (await db).add(objStore, value);
}

export async function get<Name extends StoreNames<DB>>(storeName: Name, query: StoreKey<DB, Name> | IDBKeyRange): Promise<StoreValue<DB, Name> | undefined> {
  return (await db).get(storeName, query);
}

export async function clear(name: StoreNames<DB>): Promise<void> {
  return (await db).clear(name);
}

export async function del<Name extends StoreNames<DB>>(storeName: Name, key: StoreKey<DB, Name> | IDBKeyRange): Promise<void> {
  return (await db).delete(storeName, key);
}

export async function getAllKeys<Name extends StoreNames<DB>>(storeName: Name, query?: StoreKey<DB, Name> | IDBKeyRange | null, count?: number): Promise<StoreKey<DB, Name>[]> {
  return (await db).getAllKeys(storeName, query, count);
}

function setSubtract<T>(a: Set<T>, b: Set<T>): Set<T> {
  const r = new Set(a);
  b.forEach(el => r.delete(el))
  return r;
}

function setIntersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  const r = new Set<T>();
  a.forEach(el => { if (b.has(el)) { r.add(el) } });
  return r;
}

export async function updateStore(objStoreName: 'BlockedOnTwitter' | 'MutedOnTwitter', users: UserHandle[]) {
  const oldIds = new Set(await getAllKeys(objStoreName));
  const newIds = new Set(users.map(u => u.id));

  const added = setSubtract(newIds, oldIds);
  await Promise.all(users.filter(u => added.has(u.id)).map(u => add(objStoreName, u)));

  const removed = setSubtract(oldIds, newIds);
  await Promise.all(Array.from(removed.values()).map(id => del(objStoreName, id)));
}

export async function removeFromStore(objStoreName: 'Blocked' | 'Muted', users: UserHandle[]) {
  const idbKeys = new Set(await getAllKeys(objStoreName));
  const toRemove = setIntersect(new Set(users.map(u => u.id)), idbKeys);
  await Promise.all(Array.from(toRemove.values()).map(id => del(objStoreName, id)));
}
