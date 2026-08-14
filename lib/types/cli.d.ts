import { registerApp } from '@larksuiteoapi/node-sdk';
interface CliRuntime {
    registerApp: typeof registerApp;
    openUrl: (url: string) => Promise<void>;
}
export declare function main(argv?: string[], runtime?: CliRuntime): Promise<void>;
export {};
