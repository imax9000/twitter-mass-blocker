import type { Alarms, Storage } from 'webextension-polyfill';
import * as tt from 'twitter-types';
import { openDB } from 'idb';

import { TwitterProxyClient, ExtensionConfigStore } from 'twitter-proxy-client';
import * as credentials from 'credentials';
import * as _ from 'global';
import { Operation } from 'state_structs';
import * as logging from 'logging';

const client = new TwitterProxyClient(new ExtensionConfigStore(), credentials.clientID);
const alarms: Record<string, Alarms.Alarm> = {};

function setValues(el: HTMLElement, values: Record<string, string>) {
  for (const selector in values) {
    const e = el.querySelector<HTMLElement>(selector);
    if (e) { e.innerText = values[selector] };
  }
}

function updateAlarm(el: HTMLElement, alarm: Alarms.Alarm) {
  setValues(el, {
    '.name': alarm.name,
    '.trigger_time': new Date(alarm.scheduledTime).toLocaleString(),
  });
}

async function renderAlarms() {
  const alarmList = await browser.alarms.getAll();
  const newAlarms: Record<string, Alarms.Alarm> = {};
  for (const alarm of alarmList) {
    newAlarms[alarm.name] = alarm;
  }

  for (const alarm in alarms) {
    if (!(alarm in newAlarms)) {
      // Deleted.
      document.getElementById(`alarm_${alarm}`)!.remove();
      delete alarms[alarm];
      continue;
    }
    // Still exists.
    alarms[alarm] = newAlarms[alarm];
    updateAlarm(document.getElementById(`alarm_${alarm}`)!, alarms[alarm]);
  }

  for (const alarm in newAlarms) {
    if (!(alarm in alarms)) {
      // New alarm.
      alarms[alarm] = newAlarms[alarm];
      const div = document.createElement('div');
      div.id = `alarm_${alarm}`;
      div.appendChild((document.getElementById('alarm_tmpl')! as HTMLTemplateElement).content.cloneNode(true));
      updateAlarm(div, alarms[alarm]);
      document.getElementById('alarms')!.appendChild(div);
    }
  }

  setTimeout(renderAlarms, 1000);
}

renderAlarms();

const operationTemplate: Record<string, { template: string, update: (el: HTMLElement, id: string, state: Operation.State) => void }> = {
  'block_queue': {
    template: 'queue_tmpl',
    update: updateQueueOp,
  },
  'mute_queue': {
    template: 'queue_tmpl',
    update: updateQueueOp,
  },
  [Operation.BlockLikers.TypeName]: {
    template: 'block_likers_tmpl',
    update: updateBlockLikersOp,
  },
  [Operation.UserList.BlockTypeName]: {
    template: 'collect_block_mute_tmpl',
    update: updateBlockMuteListOp,
  },
  [Operation.UserList.MuteTypeName]: {
    template: 'collect_block_mute_tmpl',
    update: updateBlockMuteListOp,
  },
};

function updateQueueOp(el: HTMLElement, id: string, state_: Operation.State) {
  const state = state_ as Operation.BlockQueue.State;
  setValues(el, {
    '.name': id,
    '.length': String(state.users.length),
  });
}

async function updateBlockLikersOp(el: HTMLElement, id: string, state_: Operation.State) {
  const state = state_ as Operation.BlockLikers.State;

  setValues(el, {
    '.name': id,
    '.likers': String(state.users.length),
    '.follows': String(state.follows?.length),
    '.followers': String(state.followers?.length),
  });

  const resp = await client.get<tt.GETTweetsIdResponse>('/2' + tt.GETTweetsIdRoute(state.tweet_id), {
    'tweet.fields': ['text', 'public_metrics'],
    'user.fields': ['username'],
    'expansions': ['author_id'],
  });

  if (resp.status == 200) {
    el.querySelector<HTMLAnchorElement>('.tweet_link')!.href = `https://twitter.com/${resp.data.includes?.users![0].username}/status/${state.tweet_id}`;
    setValues(el, {
      '.text': resp.data.data.text,
      '.like_count': String(resp.data.data.public_metrics?.like_count),
      '.username': '@' + resp.data.includes?.users![0].username,
    });
  }
}

async function updateBlockMuteListOp(el: HTMLElement, id: string, state_: Operation.State) {
  const state = state_ as Operation.UserList.State;
  setValues(el, {
    '.name': id,
    '.count': String(state.users.length),
  });
}

function updateOperation(el: HTMLElement, id: string, state: Operation.State) {
  setValues(el, {
    '.name': id,
    '.state': JSON.stringify(state, undefined, 2),
  });
}

function addFromTemplate(id: string, templateId: string, parentId: string): HTMLDivElement {
  const div = document.createElement('div');
  div.id = id;
  div.appendChild((document.getElementById(templateId)! as HTMLTemplateElement).content.cloneNode(true));
  document.getElementById(parentId)!.appendChild(div);
  return div;
}

function addOperation(id: string, state: Operation.State) {
  let tmpl = operationTemplate[state.type as string];
  if (!tmpl) {
    tmpl = { template: 'operation_tmpl', update: updateOperation };
  }
  const div = addFromTemplate(id, tmpl.template, 'operations');
  tmpl.update(div, id, state);
}

async function monitorOperations(changes: Record<string, Storage.StorageChange>, areaName: string) {
  if (areaName != 'local') {
    return;
  }
  for (const key in changes) {
    if (!key.startsWith('operation:')) {
      continue;
    }
    if (changes[key].newValue === undefined) {
      document.getElementById(key)!.remove();
    } else if (changes[key].oldValue === undefined) {
      addOperation(key, changes[key].newValue);
    } else {
      let tmpl = operationTemplate[changes[key].newValue.type as string];
      if (!tmpl) {
        tmpl = { template: 'operation_tmpl', update: updateOperation };
      }
      tmpl.update(document.getElementById(key)!, key, changes[key].newValue);
    }
  }
}

async function updateBlockMuteList(el: HTMLElement, id: string) {
  setValues(el, {
    '.name': id,
  });
  const storeNames = {
    [Operation.UserList.BlockedListKey]: ['Blocked', 'BlockedOnTwitter'],
    [Operation.UserList.MutedListKey]: ['Muted', 'MutedOnTwitter'],
  }[id]!;
  const db = await openDB('blocked_and_muted');
  const [cached, complete] = await Promise.all(storeNames.map(store => db.count(store)));
  setValues(el, {
    '.count': String(complete),
    '.cached_count': String(cached),
  });
  db.close();
}

const monitoredStoredEntries: Record<string, { template: string, update: (el: HTMLElement, id: string) => void }> = {
  [Operation.UserList.BlockedListKey]: { template: 'block_list_tmpl', update: updateBlockMuteList },
  [Operation.UserList.MutedListKey]: { template: 'block_list_tmpl', update: updateBlockMuteList },
};


Object.keys(monitoredStoredEntries).forEach(key => {
  const tmpl = monitoredStoredEntries[key];
  addFromTemplate(key, tmpl.template, 'storage');

  const loop = () => {
    tmpl.update(document.getElementById(key)!, key);
    setTimeout(loop, 60 * 1000);
  };
  loop();
});


(async () => {
  const storage = await browser.storage.local.get();
  for (const key in storage) {
    if (key.startsWith('operation:')) {
      addOperation(key, storage[key]);
    }
  }
  browser.storage.onChanged.addListener(monitorOperations);
})();

(async () => {
  const el = document.getElementById('logs') as HTMLTextAreaElement;
  const update = async () => {
    const at_the_bottom = el.scrollTop == el.scrollHeight;
    el.value = (await logging.lastEntries(30)).map(logging.formatEntry).join('\n');
    if (at_the_bottom) { el.scrollTop = el.scrollHeight; }
    setTimeout(update, 5000);
  };
  update();
})();
