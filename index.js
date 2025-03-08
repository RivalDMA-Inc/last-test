const http = require('https');
const url = require('url');

const hostname = '0.0.0.0'; // Lyssna på alla IP:n
const port = 3000;

let pendingData = {};  // { localIP: { data, timestamp } }
let pendingConnections = {}; // { localIP: [res1, res2, ...] }
const DATA_TTL = 30000; // 30 sekunders maxlivslängd för data

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // C++ klient långpollar för att få data
    if (req.method === 'GET' && parsedUrl.pathname === '/getData') {
        const localIP = parsedUrl.query.localip;
        console.log("Client polling for data with IP:", localIP);

        if (!localIP) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: "Error", message: "Missing localip" }));
            return;
        }

        // Skicka data direkt om det finns
        if (pendingData[localIP]) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(pendingData[localIP].data));
            delete pendingData[localIP]; // Rensa datan
        } else {
            // Håll anslutningen öppen i 10 sekunder (long polling)
            pendingConnections[localIP] = pendingConnections[localIP] || [];
            pendingConnections[localIP].push(res);

            const timeout = setTimeout(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: "no data" }));

                // Ta bort anslutningen
                pendingConnections[localIP] = pendingConnections[localIP].filter(r => r !== res);
            }, 10000); // 10 sekunder

            req.on('close', () => {
                clearTimeout(timeout);
                pendingConnections[localIP] = pendingConnections[localIP].filter(r => r !== res);
            });
        }
    }

    // Webmenyn skickar data till servern
    else if (req.method === 'POST' && parsedUrl.pathname === '/data') {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
            try {
                const parsedData = JSON.parse(data);
                const localIP = parsedData.localip;
                console.log("Received data from web menu for C++ client:", localIP);

                if (!localIP) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: "Error", message: "Missing localip" }));
                    return;
                }

                // Spara datan med en tidsstämpel
                pendingData[localIP] = { data: parsedData, timestamp: Date.now() };

                // Skicka data till väntande klienter om de finns
                if (pendingConnections[localIP] && pendingConnections[localIP].length > 0) {
                    console.log(`Sending data to waiting C++ clients: ${localIP}`);
                    pendingConnections[localIP].forEach(response => {
                        response.writeHead(200, { 'Content-Type': 'application/json' });
                        response.end(JSON.stringify(parsedData));
                    });
                    pendingConnections[localIP] = []; // Rensa anslutningarna
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: "OK" }));
            } catch (error) {
                console.error("Error parsing data:", error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: "Error", message: "Invalid data format" }));
            }
        });
    }

    // CORS hantering
    else if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// Rensa gammal data var 30:e sekund
setInterval(() => {
    const now = Date.now();
    Object.keys(pendingData).forEach(ip => {
        if (now - pendingData[ip].timestamp > DATA_TTL) {
            console.log(`Removing stale data for ${ip}`);
            delete pendingData[ip];
        }
    });
}, 30000);

server.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`);
});
