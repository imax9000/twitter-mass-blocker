import type { CollectLoopState } from 'twitter-proxy-client';

export interface UserHandle {
  id: string;
  username: string;
}

export namespace Operation {
  export interface State {
    type: string;
  }

  export interface StagedState extends State {
    stage?: string;
  }

  export namespace BlockLikers {
    export const TypeName = 'block_likers';

    export type Stage = 'follows' | 'followers' | 'likers' | 'schedule';

    export interface State extends Operation.State {
      type: 'block_likers';
      tweet_id: string;
      action: 'block' | 'mute';
      exclude_followers: boolean;
      exclude_follows: boolean;
      include_likers?: boolean;
      include_retweeters?: boolean;

      stage?: Stage;
      collect_state?: CollectLoopState;
      likers?: UserHandle[]; // deprecated
      users: UserHandle[];
      follows?: UserHandle[];
      followers?: UserHandle[];

      id: string;
    }
  }

  export namespace BlockQueue {
    export type QueueType = 'block_queue' | 'mute_queue';
    export const BlockQueueName = 'block_queue';
    export const MuteQueueName = 'mute_queue';

    export interface State extends Operation.State {
      type: QueueType;

      users: UserHandle[];
    }
  }

  export namespace UserList {
    export const BlockedListKey = 'blocked';
    export const MutedListKey = 'muted';

    export interface StoredList {
      users: UserHandle[];
    }

    export type OpType = 'collect_blocked' | 'collect_muted';
    export const BlockTypeName = 'collect_blocked';
    export const MuteTypeName = 'collect_muted';

    export interface State extends Operation.State {
      type: OpType;

      collect_state: CollectLoopState;
      users: UserHandle[];
      last_completion?: number;
    }
  }
}

export namespace Log {
  export type Severity = 'debug' | 'info' | 'warn' | 'error';

  export interface Entry {
    timestamp: number;
    severity: Severity;
    context?: {
      [index: string]: any;

      operation?: string;
    };
    text: string;
    data?: any;
  }

  export interface ErrorRecord {
    timestamp: number;
    context?: {
      operation?: string;
      user?: UserHandle;
    };
    error: any;
  }
}
