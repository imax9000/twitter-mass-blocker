import { openDB, DBSchema } from 'idb';

import { Log } from 'state_structs';

export interface ILogger {
  debug(text: string, opts?: Partial<Log.Entry>): Promise<any>;
  info(text: string, opts?: Partial<Log.Entry>): Promise<any>;
  warn(text: string, opts?: Partial<Log.Entry>): Promise<any>;
  error(text: string, opts?: Partial<Log.Entry>): Promise<any>;
}

export async function debug(text: string, opts?: Partial<Log.Entry>) {
  return log('debug', text, opts);
}
export async function info(text: string, opts?: Partial<Log.Entry>) {
  return log('info', text, opts);
}
export async function warn(text: string, opts?: Partial<Log.Entry>) {
  return log('warn', text, opts);
}
export async function error(text: string, opts?: Partial<Log.Entry>) {
  return log('error', text, opts);
}

export class Logger implements ILogger {
  private opts: Partial<Log.Entry>;

  constructor(opts: Partial<Log.Entry>) {
    this.opts = opts;
  }

  async debug(text: string, opts?: Partial<Log.Entry>) {
    return debug(text, { ...this.opts, ...(opts || {}) });
  }
  async info(text: string, opts?: Partial<Log.Entry>) {
    return info(text, { ...this.opts, ...(opts || {}) });
  }
  async warn(text: string, opts?: Partial<Log.Entry>) {
    return warn(text, { ...this.opts, ...(opts || {}) });
  }
  async error(text: string, opts?: Partial<Log.Entry>) {
    return error(text, { ...this.opts, ...(opts || {}) });
  }
}

export async function recordError(error: any, opts?: Partial<Log.ErrorRecord>) {
  return (await db).add('errors', {
    timestamp: Date.now(),
    ...(opts || {}),
    error: JSON.parse(JSON.stringify(error)),
  });
}

export async function lastEntries(count: number) {
  const idb = await db;

  const tx = idb.transaction('entries');
  let cursor = await tx.objectStore('entries').openCursor(null, 'prev');
  const results: Log.Entry[] = [];
  while (cursor && results.length < count) {
    results.unshift(cursor.value);
    cursor = await cursor.continue();
  }
  return results;
}

export function formatEntry(entry: Log.Entry): string {
  let r = entry.severity[0].toUpperCase();
  r += (new Date(entry.timestamp)).toLocaleString();
  if (entry.context?.operation) {
    r += ` [${entry.context.operation}]`;
  }
  r += `: ${entry.text}`;
  if (entry.data) {
    r += `: ${JSON.stringify(entry.data)}`;
  }
  return r;
}

// Implementation details

interface LogDB extends DBSchema {
  entries: {
    value: Log.Entry;
    key: number;
    indexes: {
      timestamp: number;
      operation: string;
    };
  };
  errors: {
    value: Log.ErrorRecord,
    key: number;
    indexes: {
      timestamp: number;
    };
  },
}

let db = openDB<LogDB>('logs', 1, {
  async upgrade(database, oldVersion, newVersion, transaction) {
    const migrations: (() => Promise<void>)[] = [
      async () => { }, // Dummy to fill index 0.
      async () => {
        const entries = database.createObjectStore('entries', { autoIncrement: true });
        entries.createIndex('timestamp', 'timestamp');
        entries.createIndex('operation', 'context.operation');

        const errors = database.createObjectStore('errors', { autoIncrement: true });
        errors.createIndex('timestamp', 'timestamp');
      },
    ];
    for (let i = oldVersion + 1; i < migrations.length; i++) {
      await migrations[i]();
    }
  },
});

async function log(severity: Log.Severity, text: string, opts?: Partial<Log.Entry>) {
  const entry = {
    timestamp: Date.now(),
    ...(opts || {}),
    severity,
    text,
  }
  let console_log: typeof console.log | undefined;
  switch (severity) {
    case 'debug':
      console_log = console.debug;
      break;
    case 'info':
      console_log = console.log;
      break;
    case 'warn':
      console_log = console.warn;
      break;
    case 'error':
      console_log = console.error;
      break;
  }
  let fmt = `${severity[0].toUpperCase()}${(new Date(entry.timestamp)).toLocaleString()}`;
  let args: string[] = [];
  if (entry.context?.operation) {
    fmt += ' [%s]';
    args.push(entry.context.operation);
  }
  fmt += ': %s';
  args.push(entry.text);
  if (entry.data) {
    fmt += ': %o';
    args.push(entry.data);
    entry.data = JSON.parse(JSON.stringify(entry.data));
  }
  console_log(fmt, ...args);
  return (await db).add('entries', entry);
}


