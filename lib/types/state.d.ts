export declare const DEFAULT_PAIRING_TTL_MS: number;
export declare const DEFAULT_PAIRING_ATTEMPTS = 8;
export interface PendingPairing {
    tokenHash: string;
    expiresAt: number;
    attemptsRemaining: number;
}
export interface BridgeState {
    version: 1;
    owners: string[];
    chatBindings: Record<string, string>;
    pendingWelcomeOwners: string[];
    pairing?: PendingPairing;
    cardVerifiedAt?: number;
}
export type ClaimResult = {
    status: 'claimed';
} | {
    status: 'already-owner';
} | {
    status: 'invalid';
    attemptsRemaining: number;
} | {
    status: 'expired' | 'unavailable';
};
/** Hash one setup token before it reaches durable state. */
export declare function hashPairingToken(token: string): string;
/** Generate a copy-friendly 40-bit one-time setup token. */
export declare function generatePairingToken(): string;
/** Owner-only, atomic persistent state for pairing and chat-to-project bindings. */
export declare class BridgeStateStore {
    readonly path: string;
    private state;
    private mutation;
    constructor(path: string);
    snapshot(): BridgeState;
    refresh(): Promise<BridgeState>;
    isOwner(openId: string): boolean;
    projectForChat(chatId: string): string | undefined;
    private write;
    private mutate;
    createPairing(options?: {
        token?: string;
        now?: number;
        ttlMs?: number;
        attempts?: number;
    }): Promise<{
        token: string;
        expiresAt: number;
    }>;
    addOwner(openId: string, options?: {
        welcome?: boolean;
    }): Promise<boolean>;
    markWelcomeSent(openId: string): Promise<void>;
    claim(token: string, openId: string, now?: number): Promise<ClaimResult>;
    bindChat(chatId: string, projectId: string): Promise<void>;
    unbindChat(chatId: string): Promise<boolean>;
    markCardVerified(now?: number): Promise<void>;
}
