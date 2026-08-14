import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import type { BridgeAction, CardPreset, TurnProgress } from './types.js';
export interface TurnCardInput {
    progress: TurnProgress;
    sessionId: string;
    cwd: string;
    model: string;
    project: string;
    preset: CardPreset;
    now?: number;
    outcome?: 'completed' | 'cancelled' | 'blocked' | 'error';
    outcomeDetail?: string;
    maxBodyChars: number;
}
/** Build the single mutable card used from turn start through terminal outcome. */
export declare function buildTurnCard(input: TurnCardInput): object;
export interface ApprovalCardInput {
    token: string;
    toolName: string;
    reason?: string;
    sessionId: string;
    settled?: 'allowed' | 'rejected' | 'cancelled' | 'unavailable';
}
export declare function buildApprovalCard(input: ApprovalCardInput): object;
export interface QuestionCardInput {
    token: string;
    question: AskUserQuestionItem;
    selected?: ReadonlySet<number>;
    settled?: string;
}
export declare function buildQuestionCard(input: QuestionCardInput): object;
export interface StatusCardInput {
    sessionId: string;
    status: 'idle' | 'running';
    cwd: string;
    provider: string;
    model: string;
    connected: boolean;
    pendingApprovals: number;
    pendingQuestions: number;
    project: string;
    preset: CardPreset;
}
export declare function buildStatusCard(input: StatusCardInput): object;
/** Build the first-run card; its optional button proves callbacks work. */
export declare function buildSetupCard(input: {
    verified?: boolean;
    project: string;
}): object;
export declare function parseBridgeAction(value: unknown): BridgeAction | undefined;
