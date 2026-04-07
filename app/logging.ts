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

    jumpLineLog(msg: string, tag: string = '') {
        console.log(`\n`);
        this.log(msg, Logger.tagger(tag));
    }

    static tagger(tag: string) {
        return tag ? `[${tag}]` : '';
    }
}

export const server = new Logger("SERVER");
