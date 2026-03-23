export class Logger {
    private origin: string;
    tag: string;

    constructor(origin: string = 'SERVER', tag: string = '') {
        this.origin = origin;
        this.tag = tag;
        this.log(`Logger initialized`);
    }

    log(msg: string, tag: string = '') {
        const now = `${new Date().toLocaleTimeString()}`;
        const tagStr = tag ? `[${this.tag}]` : '';
        console.log(`${now} - [${this.origin}]${tagStr} - ${msg}`);
    }

    jumpLineLog(msg: string) {
        console.log(`\n`);
        this.log(msg)
    }
}

export const server = new Logger("SERVER");
