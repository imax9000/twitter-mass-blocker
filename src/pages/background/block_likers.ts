import type { AxiosResponse } from 'axios';
import * as tt from 'twitter-types';

import { TwitterProxyClient, ExtensionConfigStore, CollectLoopState, Request } from 'twitter-proxy-client';
import * as credentials from 'credentials';
import * as _ from 'global';
import { UserHandle, Operation } from 'state_structs';

import * as operations from './operations';
import { StageResult } from './operations';
import * as block_queue from './block_queue';
import * as block_list from './block_list';

const client = new TwitterProxyClient(new ExtensionConfigStore(), credentials.clientID);

export async function blockLikers(data: any): Promise<string> {
  const uuid = crypto.randomUUID();

  if (!(data.include_likers || data.include_retweeters)) {
    throw 'No users are selected to block/mute';
  }

  const state: Operation.BlockLikers.State = {
    type: Operation.BlockLikers.TypeName,
    tweet_id: data.tweet_id,
    action: data.action,
    exclude_followers: data.exclude_followers,
    exclude_follows: data.exclude_follows,
    include_likers: data.include_likers,
    include_retweeters: data.include_retweeters,
    users: [],
    id: uuid,
  };
  await operations.add(uuid, state);
  operations.scheduleAlarm(uuid, Date.now() + 1000);

  return uuid;
}

class BlockLikers extends operations.MultiStageOperation<Operation.BlockLikers.State> {
  stages(): [string, () => Promise<StageResult>][] {
    return [
      ['follows', () => this.collectFollows()],
      ['followers', () => this.collectFollowers()],
      ['likers', () => this.collectLikers()],
      ['retweeters', () => this.collectRetweeters()],
      ['schedule', () => this.scheduleActions()],
    ];
  }

  async execute() {
    if (this.state.likers) {
      const users = new Set(this.state.users.map(u => u.id));
      this.state.users = this.state.users.concat(this.state.likers.filter(u => !users.has(u.id)));
      this.state.likers = undefined;
    }
    super.execute();
  }

  async collectFollows(): Promise<StageResult> {
    if (!this.state.exclude_follows) {
      return { stage_done: true };
    }
    if (this.state.follows === undefined) {
      this.state.follows = [];
    }
    const self = this;
    const subclass = class extends CollectUsers {
      storeItems(items: UserHandle[], new_state: CollectLoopState): void {
        self.state.follows = self.state.follows!.concat(items);
        self.state.collect_state = new_state;
      }
      async done() {
        self.log.info(`[${self.state.stage}] Collected ${self.state.follows!.length} users.`);
      };
      async rateLimited(until: number) {
        self.log.info(`[${self.state.stage}] Hit rate limit, collected ${self.state.follows!.length} users so far. Sleeping until ${new Date(until).toLocaleString()}`)
      };
    }
    return new subclass(this.state.collect_state || {}, '/2/users/:id/following').handler()();
  }

  async collectFollowers(): Promise<StageResult> {
    if (!this.state.exclude_followers) {
      return { stage_done: true };
    }
    if (this.state.followers === undefined) {
      this.state.followers = [];
    }
    const self = this;
    const subclass = class extends CollectUsers {
      storeItems(items: UserHandle[], new_state: CollectLoopState): void {
        self.state.followers = self.state.followers!.concat(items);
        self.state.collect_state = new_state;
      }
      async done() {
        self.log.info(`[${self.state.stage}] Collected ${self.state.followers!.length} users.`);
      };
      async rateLimited(until: number) {
        self.log.info(`[${self.state.stage}] Hit rate limit, collected ${self.state.followers!.length} users so far. Sleeping until ${new Date(until).toLocaleString()}`)
      };
    }
    return new subclass(this.state.collect_state || {}, '/2/users/:id/followers').handler()();
  }

  async collectLikers(): Promise<StageResult> {
    if (!this.state.include_likers) {
      return { stage_done: true };
    }
    const self = this;
    const subclass = class extends CollectUsers {
      storeItems(items: UserHandle[], new_state: CollectLoopState): void {
        const existing = new Set(self.state.users.map(u => u.id));
        self.state.users = self.state.users!.concat(items.filter(u => !existing.has(u.id)));
        self.state.collect_state = new_state;
      }
      async done() {
        self.log.info(`[${self.state.stage}] Collected ${self.state.users!.length} users.`);
      };
      async rateLimited(until: number) {
        self.log.info(`[${self.state.stage}] Hit rate limit, collected ${self.state.users!.length} users so far. Sleeping until ${new Date(until).toLocaleString()}`)
      };
    }
    return new subclass(this.state.collect_state || {}, '/2' + tt.GETTweetsIdLikingUsersRoute(this.state.tweet_id)).handler()();
  }

  async collectRetweeters(): Promise<StageResult> {
    if (!this.state.include_retweeters) {
      return { stage_done: true };
    }
    const self = this;
    const subclass = class extends CollectUsers {
      storeItems(items: UserHandle[], new_state: CollectLoopState): void {
        const existing = new Set(self.state.users.map(u => u.id));
        self.state.users = self.state.users!.concat(items.filter(u => !existing.has(u.id)));
        self.state.collect_state = new_state;
      }
      async done() {
        self.log.info(`[${self.state.stage}] Collected ${self.state.users!.length} users.`);
      };
      async rateLimited(until: number) {
        self.log.info(`[${self.state.stage}] Hit rate limit, collected ${self.state.users!.length} users so far. Sleeping until ${new Date(until).toLocaleString()}`)
      };
    }
    return new subclass(this.state.collect_state || {}, '/2' + tt.GETTweetsIdRetweetedByRoute(this.state.tweet_id)).handler()();
  }

  async scheduleActions(): Promise<StageResult> {
    let follows: Set<string> = new Set();
    let followers: Set<string> = new Set();
    if (this.state.exclude_follows) {
      follows = new Set(this.state.follows!.map(u => u.id));
      const bad_follows = this.state.users.filter((user) => follows.has(user.id));
      if (bad_follows.length > 0) {
        this.log.warn(`Some of the people you follow have liked the tweet ${this.state.tweet_id}:`, { data: bad_follows });
      }
    }
    if (this.state.exclude_followers) {
      followers = new Set(this.state.followers!.map(u => u.id));
      const bad_followers = this.state.users.filter((user) => followers.has(user.id));
      if (bad_followers.length > 0) {
        this.log.warn(`Some of your followers have liked the tweet ${this.state.tweet_id}:`, { data: bad_followers });
      }
    }
    switch (this.state.action) {
      case 'block':
        const blocked = await Promise.all(this.state.users.map(u => block_list.isBlocked(u.id)));
        const to_block = this.state.users.filter((user, i) => !(user.id in follows || user.id in followers || blocked[i]));
        await block_queue.queueBlocks(to_block);
        this.log.info(`Queued ${to_block.length} users for blocking`);
        break;
      case 'mute':
        const muted = await Promise.all(this.state.users.map(u => block_list.isMuted(u.id)));
        const to_mute = this.state.users.filter((user, i) => !(user.id in follows || user.id in followers || muted[i]))
        await block_queue.queueMutes(to_mute);
        this.log.info(`Queued ${to_mute.length} users for muting`);
        break;
    }
    return { stage_done: true };
  }
}

operations.registerHandler(Operation.BlockLikers.TypeName, BlockLikers);

class CollectUsers extends operations.CollectStage<UserHandle> {
  endpoint: string;

  constructor(state: CollectLoopState, endpoint: string) {
    super();
    this.endpoint = endpoint;
    this.state = state;
  }

  request(): Request {
    return { method: 'GET', endpoint: this.endpoint };
  }

  mapResponse(response: AxiosResponse<tt.GETTweetsIdLikingUsersResponse>): UserHandle[] {
    return response.data.data.map((u) => { return { username: u.username, id: u.id }; });
  }

  client(): TwitterProxyClient {
    return client;
  }

  storeItems(items: UserHandle[], new_state: CollectLoopState): void { }
}
