const net = require('node:net');
const { createPlatform } = require('./platform/index.cjs');

function request(command, endpoint = createPlatform().locations.socket, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(endpoint);
    client.setEncoding('utf8');
    let received = '';
    const fail = (error) => { client.destroy(); reject(error); };
    client.setTimeout(timeout, () => fail(new Error('Vibez did not respond.')));
    client.on('error', fail);
    client.on('connect', () => client.write(`${JSON.stringify({ command })}\n`));
    client.on('data', (data) => {
      received += data;
      if (received.length > 16384) return fail(new Error('Invalid response.'));
      if (received.includes('\n')) {
        client.end();
        try { resolve(JSON.parse(received.split('\n')[0])); } catch (error) { fail(error); }
      }
    });
    client.on('end', () => { if (!received.includes('\n')) fail(new Error('Incomplete response.')); });
  });
}

function controlServer(platform, handler) {
  platform.prepareIPC();
  const server = net.createServer((client) => {
    let input = '';
    client.setEncoding('utf8');
    client.setTimeout(1500, () => client.destroy());
    client.on('error', () => {});
    client.on('data', (data) => {
      input += data;
      if (input.length > 1024) return client.destroy();
      if (!input.includes('\n')) return;
      client.removeAllListeners('data');
      Promise.resolve().then(() => handler(JSON.parse(input.split('\n')[0]).command))
        .then((result) => client.end(`${JSON.stringify(result)}\n`))
        .catch(() => client.end('{"error":"Invalid command"}\n'));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(platform.locations.socket, () => {
      try { platform.secureIPC(); resolve(server); }
      catch (error) { server.close(); reject(error); }
    });
  });
}

module.exports = { request, controlServer };
