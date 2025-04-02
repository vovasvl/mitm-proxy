const http = require('http');
const express = require('express');
const { URL } = require('url');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());

let requests = [];
let requestIdCounter = 1;

const CERT_DIR = path.join(__dirname, 'certs');

function generateCert(host) {
    const certPath = path.join(CERT_DIR, `${host}.crt`);
    const keyPath = path.join(__dirname, `ca.key`);

    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
        console.log(`Generating certificate for ${host}`);
        const lol = execSync(`bash gen_cert.sh ${host} ${Date.now()}`, { cwd: __dirname });
    }

    return {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
    };
}


const proxyServer = http.createServer((clientReq, clientRes) => {
    const parsedUrl = new URL(clientReq.url);
    const targetHost = parsedUrl.hostname;
    const targetPort = parsedUrl.port || 80;
    const path = parsedUrl.pathname + parsedUrl.search;

    const options = {
        hostname: targetHost,
        port: targetPort,
        path: path,
        method: clientReq.method,
        headers: clientReq.headers,
    };

    delete options.headers['proxy-connection'];

    const requestId = requestIdCounter++;
    const requestDetails = {
        id: requestId,
        method: clientReq.method,
        url: clientReq.url,
        headers: clientReq.headers,
    };
    requests.push(requestDetails);

    const proxyReq = http.request(options, (serverRes) => {
        clientRes.writeHead(serverRes.statusCode, serverRes.headers);
        serverRes.pipe(clientRes, { end: true });
    });

    proxyReq.on('error', (err) => {
        console.error('Proxy error:', err.message);
        clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
        clientRes.end('Proxy Error');
    });

    clientReq.pipe(proxyReq, { end: true });
});

proxyServer.on('connect', (req, clientSocket) => {
    const [host, port] = req.url.split(':');
    if (!host) {
        console.error('Invalid CONNECT request: missing host');
        clientSocket.end();
        return;
    }

    console.log(`Connecting to host: ${host}, port: ${port || 443}`);

    let cert, key;
    try {
        const { cert: generatedCert, key: generatedKey } = generateCert(host);
        cert = generatedCert;
        key = generatedKey;
    } catch (err) {
        console.error('Error generating certificate:', err.message);
        clientSocket.write('HTTP/1.0 500 Internal Server Error\r\n\r\n');
        clientSocket.end();
        return;
    }

    const serverSocket = net.connect(port || 443, host, () => {
        console.log('Connection established with target server');

        clientSocket.write('HTTP/1.0 200 Connection established\r\n\r\n');

        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (err) => {
        console.error('Server socket error:', err.message);
        clientSocket.write('HTTP/1.0 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
    });

    clientSocket.on('error', (err) => {
        console.error('Client socket error:', err.message);
        serverSocket.end();
    });
});
proxyServer.listen(8080, () => {
    console.log('Proxy server is running on port 8080');
});

app.get('/requests', (req, res) => {
    res.json(requests);
});

app.get('/requests/:id', (req, res) => {
    const requestId = parseInt(req.params.id);
    const request = requests.find((r) => r.id === requestId);
    if (request) {
        res.json(request);
    } else {
        res.status(404).json({ error: 'Request not found' });
    }
});

app.get('/repeat/:id', (req, res) => {
    const requestId = parseInt(req.params.id);
    const request = requests.find((r) => r.id === requestId);
    if (!request) {
        return res.status(404).json({ error: 'Request not found' });
    }

    const parsedUrl = new URL(request.url);
    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.pathname + parsedUrl.search,
        method: request.method,
        headers: request.headers,
    };

    const proxyReq = http.request(options, (serverRes) => {
        res.writeHead(serverRes.statusCode, serverRes.headers);
        serverRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
        console.error('Repeat error:', err.message);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Repeat Error');
    });

    proxyReq.end();
});

app.listen(8000, () => {
    console.log('Web API is running on port 8000');
});