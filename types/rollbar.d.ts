declare module "rollbar" {
  interface Configuration {
    accessToken?: string;
    environment?: string;
    captureUncaught?: boolean;
    captureUnhandledRejections?: boolean;
    payload?: Record<string, unknown>;
    [key: string]: unknown;
  }

  class Rollbar {
    constructor(options: Configuration);
    error(error: Error | string, extra?: Record<string, unknown>): void;
    warn(error: Error | string, extra?: Record<string, unknown>): void;
    info(error: Error | string, extra?: Record<string, unknown>): void;
    debug(error: Error | string, extra?: Record<string, unknown>): void;
    log(error: Error | string, extra?: Record<string, unknown>): void;
  }

  export = Rollbar;
}
