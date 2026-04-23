import Rollbar from "rollbar";

const rollbar = new Rollbar({
    accessToken: process.env.ROLLBAR_ACCESS_TOKEN,
    environment: process.env.NODE_ENV || "development",
    captureUncaught: true,
    captureUnhandledRejections: true,
    payload: {
        server: {
            root: __dirname,
        },
    },
});

export class Logger {
    private origin: string;

    constructor(origin: string = 'SERVER', tag: string = '') {
        this.origin = origin;
        this.log(`Logger initialized`);
    }

    log(msg: string, tag: string = '') {
        const now = `${new Date().toLocaleTimeString()}`;
        const tagStr = Logger.tagger(tag);
        console.log(`${now} - [${this.origin}]${tagStr} - ${msg}`);
    }

    error(msg: string, tag: string = '', route: string = '', error: Error | string) {
        this.log(`[ERROR] ${msg}`, tag);
        rollbar.error(error, { company: this.origin, route });
    }

    jumpLineLog(msg: string, tag: string = '') {
        console.log(`\n`);
        this.log(msg, Logger.tagger(tag));
    }

    static tagger(tag: string) {
        return tag ? `[${tag}]` : '';
    }
}

export const server = new Logger("SERVER");
