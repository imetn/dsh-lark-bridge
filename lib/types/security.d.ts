import type { Readable } from 'node:stream';
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment';
export declare function redactSecrets(value: string): string;
export declare function bounded(value: string, max: number): string;
/** Encode Markdown without ever exceeding the outbound file budget. */
export declare function boundedUtf8Buffer(value: string, maxBytes: number): Buffer;
export declare function parseCsv(value: string | undefined): string[];
export declare function parseBooleanEnv(value: string | undefined): boolean;
/** Require both the bridge-wide policy and an optional project allowlist. */
export declare function isOpenIdAllowed(openId: string, allowAllUsers: boolean, allowedOpenIds: readonly string[], projectAllowedOpenIds?: readonly string[]): boolean;
export declare function safeFileName(value: string | undefined, fallback: string): string;
export declare function isInside(root: string, target: string): boolean;
/** Consume a download stream without buffering beyond the configured limit. */
export declare function readBufferWithLimit(stream: Readable, maxBytes: number): Promise<Buffer>;
export interface SafeOutboundFile {
    absolutePath: string;
    fileName: string;
    bytes: number;
}
/** Resolve symlinks and require an ordinary file inside the configured workspace. */
export declare function resolveOutboundFile(workspaceRoot: string, cwd: string, requested: string, maxBytes: number): Promise<SafeOutboundFile>;
export interface SavedInboundFile {
    absolutePath: string;
    fileName: string;
    bytes: number;
}
/** Persist one inbound object privately and exclusively under the bridge inbox. */
export declare function saveInboundFile(inboundRoot: string, sessionKey: string, rawName: string | undefined, data: Buffer, maxBytes: number): Promise<SavedInboundFile>;
export declare function imageMediaType(data: Uint8Array, fileName?: string): ImageMediaType | undefined;
export declare function isImageFileName(fileName: string): boolean;
