declare module "rollbar" {
  interface Configuration {
    accessToken?: string;
    environment?: string;
    captureUncaught?: boolean;
    captureUnhandledRejections?: boolean;
    payload?: Record<string, unknown>;
    [key: string]: unknown;
  }

  type Callback = (error?: Error | null, response?: unknown) => void;

  class Rollbar {
    constructor(options: Configuration);
    error(error: Error | string, extra?: Record<string, unknown>, callback?: Callback): void;
    warn(error: Error | string, extra?: Record<string, unknown>, callback?: Callback): void;
    info(error: Error | string, extra?: Record<string, unknown>, callback?: Callback): void;
    debug(error: Error | string, extra?: Record<string, unknown>, callback?: Callback): void;
    log(error: Error | string, extra?: Record<string, unknown>, callback?: Callback): void;
    wait(callback: () => void): void;
  }

  export = Rollbar;
}
