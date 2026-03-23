export class Logger {
    private origin: string;
    tag: string;

    constructor(origin: string = 'SERVER', tag: string = '') {
        this.origin = origin;
        this.tag = tag;
        this.log(`Logger initialized`);
    }

    log(msg: string) {
        const now = `${new Date().toLocaleTimeString()}`;
        const tag = this.tag ? `[${this.tag}]` : '';
        console.log(`${now} - [${this.origin}]${tag} - ${msg}`);
    }

    tagLog(tag: string, msg: string) {
        const now = `${new Date().toLocaleTimeString()}`;
        console.log(`${now} - [${this.origin}][${tag}] - ${msg}`);
    }

    jumpLineLog(msg: string) {
        console.log(`\n`);
        this.log(msg)
    }
}

export const server = new Logger("SERVER");
