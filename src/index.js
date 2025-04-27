const http = require("http");
const express = require("express");
const { URL } = require("url");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const sqlite3 = require("sqlite3").verbose();
const querystring = require("querystring");

const api = express();
api.use(express.json());

// Инициализация SQLite
const db = new sqlite3.Database(":memory:");
db.serialize(() => {
  db.run(`
        CREATE TABLE requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            method TEXT,
            url TEXT,
            headers TEXT,
            get_params TEXT,
            post_params TEXT,
            cookies TEXT,
            response_code INTEGER,
            response_headers TEXT,
            response_body TEXT
        )
    `);
});

const CERT_DIR = path.join(__dirname, "certs");

function generateCert(host) {
  const certPath = path.join(CERT_DIR, `${host}.crt`);
  const keyPath = path.join(__dirname, `ca.key`);

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.log(`Generating certificate for ${host}`);
    execSync(`bash gen_cert.sh ${host} ${Date.now()}`, { cwd: __dirname });
  }

  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
}

function parseRequest(req, body) {
  const parsedUrl = new URL(req.url);
  const headers = req.headers;
  const cookies = headers.cookie
    ? Object.fromEntries(
        headers.cookie
          .split(";")
          .map((cookie) => cookie.trim().split("=").map(decodeURIComponent))
      )
    : {};

  let postParams = {};
  if (
    headers["content-type"] &&
    headers["content-type"].includes("application/x-www-form-urlencoded")
  ) {
    postParams = Object.fromEntries(new URLSearchParams(body).entries());
  }

  return {
    method: req.method,
    path: parsedUrl.pathname,
    get_params: Object.fromEntries(parsedUrl.searchParams.entries()),
    headers: headers,
    cookies: cookies,
    post_params: postParams,
  };
}

function parseResponse(res, body) {
  return {
    code: res.statusCode,
    message: res.statusMessage,
    headers: res.headers,
    body: body.toString(),
  };
}

const proxyServer = http.createServer(async (clientReq, clientRes) => {
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

  delete options.headers["proxy-connection"];

  const requestBodyChunks = [];
  clientReq.on("data", (chunk) => requestBodyChunks.push(chunk));
  clientReq.on("end", () => {
    const requestBody = Buffer.concat(requestBodyChunks).toString();
    const parsedRequest = parseRequest(clientReq, requestBody);

    const proxyReq = http.request(options, (serverRes) => {
      const responseBodyChunks = [];
      serverRes.on("data", (chunk) => responseBodyChunks.push(chunk));
      serverRes.on("end", () => {
        const responseBody = Buffer.concat(responseBodyChunks);
        const parsedResponse = parseResponse(serverRes, responseBody);

        db.run(
          `
                    INSERT INTO requests (
                        method, url, headers, get_params, post_params, cookies,
                        response_code, response_headers, response_body
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
          [
            parsedRequest.method,
            clientReq.url,
            JSON.stringify(parsedRequest.headers),
            JSON.stringify(parsedRequest.get_params),
            JSON.stringify(parsedRequest.post_params),
            JSON.stringify(parsedRequest.cookies),
            parsedResponse.code,
            JSON.stringify(parsedResponse.headers),
            parsedResponse.body,
          ]
        );

        clientRes.writeHead(serverRes.statusCode, serverRes.headers);
        clientRes.end(responseBody);
      });
    });

    proxyReq.on("error", (err) => {
      console.error("Proxy error:", err.message);
      clientRes.writeHead(500, { "Content-Type": "text/plain" });
      clientRes.end("Proxy Error");
    });

    proxyReq.end(requestBody);
  });
});

proxyServer.on("connect", (req, clientSocket) => {
  const [host, port] = req.url.split(":");
  if (!host) {
    console.error("Invalid CONNECT request: missing host");
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
    console.error("Error generating certificate:", err.message);
    clientSocket.write("HTTP 500 Internal Server Error\r\n\r\n");
    clientSocket.end();
    return;
  }

  const serverSocket = net.connect(port || 443, host, () => {
    console.log("Connection established with target server", host);

    clientSocket.write("HTTP 200 Connection established\r\n\r\n");

    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.on("error", (err) => {
    console.error("Server socket error:", err.message);
    clientSocket.write("HTTP 502 Bad Gateway\r\n\r\n");
    clientSocket.end();
  });

  clientSocket.on("error", (err) => {
    console.error("Client socket error:", err.message);
    serverSocket.end();
  });
});

proxyServer.listen(8080, () => {
  console.log("Proxy server is running on port 8080");
});

api.get("/requests", (req, res) => {
  db.all("SELECT * FROM requests", [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: "Database error" });
    } else {
      res.json(rows);
    }
  });
});

api.get("/requests/:id", (req, res) => {
  const requestId = parseInt(req.params.id);

  db.get("SELECT * FROM requests WHERE id = ?", [requestId], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: "Request not found" });
    } else {
      res.json(row);
    }
  });
});

api.get("/repeat/:id", (req, res) => {
  const requestId = parseInt(req.params.id);

  db.get("SELECT * FROM requests WHERE id = ?", [requestId], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: "Request not found" });
    }

    const parsedUrl = new URL(row.url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + parsedUrl.search,
      method: row.method,
      headers: JSON.parse(row.headers),
    };

    const proxyReq = http.request(options, (serverRes) => {
      const responseBodyChunks = [];
      serverRes.on("data", (chunk) => responseBodyChunks.push(chunk));
      serverRes.on("end", () => {
        const responseBody = Buffer.concat(responseBodyChunks).toString();
        res.writeHead(serverRes.statusCode, serverRes.headers);
        res.end(responseBody);
      });
    });

    proxyReq.on("error", (err) => {
      console.error("Repeat error:", err.message);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Repeat Error");
    });

    const postParamsString = JSON.stringify(JSON.parse(row.post_params));
    proxyReq.end(postParamsString);
  });
});

api.get("/scan/:id", async (req, res) => {
  const requestId = parseInt(req.params.id);

  db.get(
    "SELECT * FROM requests WHERE id = ?",
    [requestId],
    async (err, row) => {
      if (err || !row) {
        return res.status(404).json({ error: "Request not found" });
      }

      const originalRequest = {
        method: row.method,
        url: row.url,
        headers: JSON.parse(row.headers),
        get_params: JSON.parse(row.get_params),
        post_params: JSON.parse(row.post_params),
        cookies: JSON.parse(row.cookies),
      };

      const parsedUrl = new URL(originalRequest.url);
      const targetHost = parsedUrl.hostname;
      const targetPort = parsedUrl.port || 80;

      const originalResponse = await sendRequest(
        targetHost,
        targetPort,
        originalRequest.method,
        parsedUrl.pathname + parsedUrl.search,
        originalRequest.headers,
        originalRequest.post_params
      );

      const vulnerabilities = [];

      // Проверяем GET параметры
      for (const key in originalRequest.get_params) {
        const modifiedParams = { ...originalRequest.get_params };
        for (const payload of ["'", '"']) {
          modifiedParams[key] = payload;
          const modifiedUrl = `${parsedUrl.origin}${
            parsedUrl.pathname
          }?${querystring.stringify(modifiedParams)}`;
          const response = await sendRequest(
            targetHost,
            targetPort,
            originalRequest.method,
            modifiedUrl,
            originalRequest.headers,
            originalRequest.post_params
          );

          if (isVulnerable(originalResponse, response)) {
            vulnerabilities.push({
              type: "GET",
              parameter: key,
              payload: payload,
            });
          }
        }
      }

      // Проверяем POST параметры
      for (const key in originalRequest.post_params) {
        const modifiedParams = { ...originalRequest.post_params };
        for (const payload of ["'", '"']) {
          modifiedParams[key] = payload;
          const response = await sendRequest(
            targetHost,
            targetPort,
            originalRequest.method,
            parsedUrl.pathname + parsedUrl.search,
            originalRequest.headers,
            modifiedParams
          );

          if (isVulnerable(originalResponse, response)) {
            vulnerabilities.push({
              type: "POST",
              parameter: key,
              payload: payload,
            });
          }
        }
      }

      // Проверяем куки
      for (const key in originalRequest.cookies) {
        const modifiedCookies = { ...originalRequest.cookies };
        for (const payload of ["'", '"']) {
          modifiedCookies[key] = payload;
          const modifiedHeaders = { ...originalRequest.headers };
          modifiedHeaders.cookie = Object.entries(modifiedCookies)
            .map(
              ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
            )
            .join("; ");

          const response = await sendRequest(
            targetHost,
            targetPort,
            originalRequest.method,
            parsedUrl.pathname + parsedUrl.search,
            modifiedHeaders,
            originalRequest.post_params
          );

          if (isVulnerable(originalResponse, response)) {
            vulnerabilities.push({
              type: "Cookie",
              parameter: key,
              payload: payload,
            });
          }
        }
      }

      // Проверяем HTTP заголовки
      for (const key in originalRequest.headers) {
        const modifiedHeaders = { ...originalRequest.headers };
        for (const payload of ["'", '"']) {
          modifiedHeaders[key] = payload;

          const response = await sendRequest(
            targetHost,
            targetPort,
            originalRequest.method,
            parsedUrl.pathname + parsedUrl.search,
            modifiedHeaders,
            originalRequest.post_params
          );

          if (isVulnerable(originalResponse, response)) {
            vulnerabilities.push({
              type: "Header",
              parameter: key,
              payload: payload,
            });
          }
        }
      }

      res.json({ vulnerabilities });
    }
  );
});

async function sendRequest(host, port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      port: port,
      path: path,
      method: method,
      headers: headers,
    };

    const proxyReq = http.request(options, (serverRes) => {
      const responseBodyChunks = [];
      serverRes.on("data", (chunk) => responseBodyChunks.push(chunk));
      serverRes.on("end", () => {
        const responseBody = Buffer.concat(responseBodyChunks).toString();
        resolve({
          code: serverRes.statusCode,
          bodyLength: responseBody.length,
        });
      });
    });

    proxyReq.on("error", (err) => {
      reject(err);
    });

    proxyReq.end(body ? querystring.stringify(body) : null);
  });
}

function isVulnerable(originalResponse, modifiedResponse) {
  return (
    originalResponse.code !== modifiedResponse.code ||
    originalResponse.bodyLength !== modifiedResponse.bodyLength
  );
}

api.listen(8000, () => {
  console.log("Web API is running onn port 8000");
});
