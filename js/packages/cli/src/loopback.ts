import net from 'node:net';

// localhost is ::1 on many computers, 127.0.0.1 on others: a server may listen on either.
export const LOOPBACKS = ['127.0.0.1', '::1'];

export function accepts(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
}

export async function anyAccepts(port: number): Promise<boolean> {
  for (const host of LOOPBACKS) {
    if (await accepts(port, host)) return true;
  }
  return false;
}
