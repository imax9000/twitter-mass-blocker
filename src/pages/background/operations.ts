import * as _ from 'global';
import { Log, Operation, UserHandle } from 'state_structs';
import * as logging from 'logging';
import { CollectLoopState, Request, TwitterProxyClient } from 'twitter-proxy-client';
import { AxiosResponse } from 'axios';
import { AxiosError } from 'axios';

export interface OperationState {
  type: string;
}

type Handler = (id: string, state: OperationState) => Promise<void>;
interface HandlerClass {
  run: Handler;
}

const handlers: { [key: string]: Handler } = {};
const opPrefix = 'operation:';

export function storageKey(id: string): string {
  return `${opPrefix}${id}`;
}

export async function add(id: string, state: OperationState): Promise<void> {
  return browser.storage.local.set({ [storageKey(id)]: state });
}

export async function getState(id: string): Promise<OperationState | undefined> {
  const r = await browser.storage.local.get(storageKey(id));
  return r[storageKey(id)];
}

export async function list(): Promise<string[]> {
  const storage = await browser.storage.local.get();
  const ops: string[] = [];
  for (const k in storage) {
    if (k.startsWith(opPrefix)) {
      ops.push(k.slice(opPrefix.length));
    }
  }
  return ops;
}

export async function remove(id: string): Promise<void> {
  return browser.storage.local.remove(storageKey(id));
}

export function registerHandler(type: string, handler: Handler | HandlerClass) {
  if ('run' in handler) {
    handlers[type] = (...args) => handler.run(...args);
  } else {
    handlers[type] = handler;
  }
}

export function scheduleAlarm(id: string, when_ms: number) {
  browser.alarms.create(id, {
    when: when_ms,
  });
}

browser.alarms.onAlarm.addListener(async (info) => {
  const state = await getState(info.name);
  if (!state) {
    console.error(`Missing state for the operation ${info.name}. Very likely this is a bug.`);
    return;
  }
  const handler = handlers[state.type];
  if (!handler) {
    console.error(`Missing handler for the operation type ${state.type}`);
    return;
  }
  try {
    await handler(info.name, state);
  } catch (e) {
    console.group(`${info.name} error`);
    console.error(e);
    console.groupEnd();
  } finally {
    const [state, alarm] = await Promise.all([getState(info.name), browser.alarms.get(info.name)]);
    if (state && !alarm) {
      console.error(`Operation ${info.name} did not complete, but did not set an alarm for resuming. Setting an alarm for it with a default duration.`);
      browser.alarms.create(info.name, { delayInMinutes: 1 });
    }
  }
});

async function scheduleMissingAlarms(stagger: boolean) {
  let nextAlarm = Date.now() + (stagger ? 300 * 1000 : 1000);
  const ops = await list();
  const alarms = await browser.alarms.getAll();
  const existing_alarms: { [key: string]: boolean } = {};
  for (const alarm of alarms) {
    existing_alarms[alarm.name] = true;
  }
  for (const op of ops) {
    if (existing_alarms[op]) {
      continue;
    }
    scheduleAlarm(op, nextAlarm);
    if (stagger) {
      nextAlarm += 60 * 1000;
    }
  }
}

browser.runtime.onInstalled.addListener(() => { scheduleMissingAlarms(false) });
browser.runtime.onStartup.addListener(() => { scheduleMissingAlarms(true) });

export interface StageDone {
  stage_done: true;
}

export interface SleepUntil {
  sleep_until: number;
}

export type StageResult = StageDone | SleepUntil;

export abstract class MultiStageOperation<T extends Operation.StagedState> {
  id: string;
  state: T;
  log: logging.Logger;

  abstract stages(): [string, () => Promise<StageResult>][];

  constructor(id: string, state: OperationState) {
    this.id = id;
    this.state = state as T;
    this.log = this.logger();
  }

  loggerConfig(): Partial<Log.Entry> {
    return {
      context: {
        operation: this.id,
        stage: this.state.stage,
      }
    };
  }

  logger(): logging.Logger {
    return new logging.Logger(this.loggerConfig());
  }

  async done() {
    await remove(this.id);
  }

  async execute() {
    const stages = this.stages();
    if (!this.state.stage) {
      this.state.stage = stages[0][0];
    }
    this.log = this.logger();
    const idx = stages.map(([s, h]) => s).indexOf(this.state.stage);
    if (idx < 0) {
      throw `State references unknown stage "${this.state.stage}"`;
    }
    let [stage, handler] = stages[idx];
    while (true) {
      const result: StageResult = await handler();
      if ('sleep_until' in result) {
        await add(this.id, this.state);
        scheduleAlarm(this.id, result.sleep_until);
        return;
      } else if ('stage_done' in result) {
        const idx = stages.map(([s, h]) => s).indexOf(this.state.stage);
        if (idx < stages.length - 1) {
          [this.state.stage, handler] = stages[idx + 1];
          await add(this.id, this.state);
          this.log = this.logger();
          continue;
        } else {
          await this.done();
          return;
        }
      }
    }
  }

  static async run<T extends Operation.StagedState, C extends MultiStageOperation<T>>(this: new (id: string, state: OperationState) => C, id: string, state: OperationState) {
    const handler = new this(id, state);
    await handler.execute();
  }
}

export abstract class CollectStage<T, R = any> {
  state?: CollectLoopState;

  abstract request(): Request;
  abstract mapResponse(response: AxiosResponse<R>): T[];
  abstract client(): TwitterProxyClient;
  abstract storeItems(items: T[], new_state: CollectLoopState): void;

  async done() { };
  async rateLimited(until: number) { };
  async error(e: AxiosError) { };

  handler(): () => Promise<StageResult> {
    return async () => {
      const result = await this.client().collect(
        this.request(),
        this.state || {},
        resp => this.mapResponse(resp));

      this.state = result.state;
      this.storeItems(result.collected_items, result.state);

      if ('done' in result.result) {
        await this.done();
        return { stage_done: true };
      } else if ('resume_after' in result.result) {
        await this.rateLimited(result.result.resume_after);
        return { sleep_until: result.result.resume_after };
      } else {
        await this.error(result.result.error);
        throw result.result.error;
      }
    };
  }
}
