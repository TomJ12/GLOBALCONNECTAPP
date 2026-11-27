/** A small SMTP server for tests, in this process: enough of the protocol for a real client to deliver a message, with faults to order. */
import { createServer, type Server, type Socket } from 'node:net';

export interface Received {
  from: string;
  to: string[];
  data: string;
  auth: string | null;
}

export class FakeSmtp {
  readonly received: Received[] = [];
  /** How many connections were made, and how many DATA commands were completed (accepted or not). */
  connections = 0;
  deliveries = 0;
  /** What happens to the NEXT messages: `reject` answers 451 after the data; `drop` cuts the connection after the data WITHOUT answering (but keeps the message); `refuse` refuses the connection's greeting. */
  fault: 'reject' | 'drop' | 'refuse' | null = null;
  credentials: { user: string; pass: string } | null = null;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;

  async start(): Promise<number> {
    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve) => (this.server as Server).listen(0, '127.0.0.1', resolve));
    this.port = ((this.server as Server).address() as { port: number }).port;
    return this.port;
  }
  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private handle(socket: Socket): void {
    this.connections += 1;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    if (this.fault === 'refuse') {
      socket.end('421 service not available\r\n');
      return;
    }
    let buffer = '';
    let inData = false;
    let current: Received = { from: '', to: [], data: '', auth: null };
    let auth: string | null = null;
    const say = (line: string) => socket.write(`${line}\r\n`);
    say('220 fake.test ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = buffer.slice(0, end).replace(/^\.\./gm, '.');
          buffer = buffer.slice(end + 5);
          inData = false;
          this.deliveries += 1;
          if (this.fault === 'reject') say('451 try again later');
          else if (this.fault === 'drop') {
            this.received.push({ ...current, auth });
            socket.destroy();
            return;
          } else {
            this.received.push({ ...current, auth });
            say('250 queued');
          }
          current = { from: '', to: [], data: '', auth: null };
          continue;
        }
        const at = buffer.indexOf('\r\n');
        if (at < 0) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const verb = line.split(' ')[0]?.toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-fake.test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
        else if (verb === 'AUTH') {
          const [, user = '', pass = ''] = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8').split('\0');
          if (this.credentials && (user !== this.credentials.user || pass !== this.credentials.pass)) say('535 authentication failed');
          else {
            auth = user;
            say('235 ok');
          }
        } else if (verb === 'MAIL') {
          if (this.credentials && auth === null) say('530 authentication required');
          else {
            current.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
            say('250 ok');
          }
        } else if (verb === 'RCPT') {
          current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          say('250 ok');
        } else if (verb === 'DATA') {
          inData = true;
          say('354 go on');
        } else if (verb === 'QUIT') {
          say('221 bye');
          socket.end();
        } else if (verb === 'RSET' || verb === 'NOOP') say('250 ok');
        else say('502 not implemented');
      }
    });
  }
}
