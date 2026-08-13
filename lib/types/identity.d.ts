import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { GroupSessionScope } from './types.js';
export declare function originKey(message: Pick<NormalizedMessage, 'chatType' | 'chatId' | 'senderId' | 'messageId' | 'rootId'>, groupScope: GroupSessionScope, projectId?: string): string;
export declare function sessionPrefix(key: string): string;
export declare function freshSessionId(prefix: string, now?: number): SessionId;
export declare function latestSession(headers: readonly SessionHeader[], prefix: string): SessionHeader | undefined;
export declare function sessionsForPrefix(headers: readonly SessionHeader[], prefix: string): SessionHeader[];
