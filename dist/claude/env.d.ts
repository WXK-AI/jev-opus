export interface ChildEnv {
    env: Record<string, string>;
    credential: string;
}
export declare function childEnv(base?: NodeJS.ProcessEnv): ChildEnv;
