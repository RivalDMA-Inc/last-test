const fastify = require('fastify')({
  logger: { level: "error" },
  trustProxy: true,
  bodyLimit: 2048576 // 2 MB in bytes
});
const cors = require('@fastify/cors');
const path = require('path');
const fastifyStatic = require('@fastify/static');
const rateLimit = require('@fastify/rate-limit');
const os = require('os');
const WebSocket = require('ws');

const wss = new WebSocket.Server({ noServer: true });
const PORT = process.env.PORT || 443;
const DATA_TTL = 17000; // Data expiration time

// Mapping to store WebSocket clients keyed by localIP
const wsClients = {};

// For storing pending data if a client is not connected
let pendingData = {};

// Enable CORS
fastify.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
});

// Serve static files from the "public" folder
fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/'
});

// Health check route
fastify.get('/health', async (req, reply) => {
  return { message: "Fastify server is running!" };
});
fastify.register(rateLimit, {
  max: 10,
  timeWindow: '1 minute'
});

// Remove or deprecate the long polling endpoint, since it’s replaced by WebSocket
// fastify.get('/getData', ...);

// Handle HTTP upgrade requests for WebSocket connections
fastify.server.on('upgrade', (request, socket, head) => {
  // Handle only if the URL is '/ws'
  if (request.url === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// WebSocket connection handling
wss.on('connection', (ws, request) => {
  console.log('WebSocket client connected');

  // Expect the client to send an initial JSON message with its localIP
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.localIP) {
        ws.localIP = data.localIP;
        wsClients[data.localIP] = ws;
        console.log(`Registered WebSocket client for localIP: ${data.localIP}`);

        // Optionally, if there is pending data for this localIP, send it now:
        if (pendingData[data.localIP]) {
          ws.send(JSON.stringify(pendingData[data.localIP]));
          delete pendingData[data.localIP];
        }
      } else {
        console.log('Received message:', message);
      }
    } catch (err) {
      console.error('Error parsing message:', err);
    }
  });

  ws.on('close', () => {
    if (ws.localIP) {
      delete wsClients[ws.localIP];
      console.log(`WebSocket client for localIP ${ws.localIP} disconnected`);
    }
  });
});

// Web menu sends data to server via POST /data
fastify.post('/data', async (req, reply) => {
  try {
    const parsedData = req.body;
    const localIP = parsedData.localip;
    console.log(`[${new Date().toLocaleString()}] Received data from web menu for localIP:`, localIP);

    if (!localIP) {
      return reply.status(400).send({ status: "Error", message: "Missing localip" });
    }

    // Check if there's an active WebSocket connection for this localIP
    const ws = wsClients[localIP];
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(parsedData));
      console.log(`Data sent to client with localIP ${localIP}`);
    } else {
      // Optionally, store the data as pending if the client is not connected
      pendingData[localIP] = { data: parsedData, timestamp: Date.now() };
      console.log(`No active client for ${localIP}. Data stored as pending.`);
    }

    // You may still update the frontend if needed
    // updateFrontend(parsedData); // if using a similar mechanism for frontend updates

    return { status: "OK" };
  } catch (error) {
    console.error("Error parsing data:", error);
    return reply.status(400).send({ status: "Error", message: "Invalid data format" });
  }
});

// Optional: Clean up stale pending data every 10 seconds
setInterval(() => {
  const now = Date.now();
  Object.keys(pendingData).forEach(ip => {
    if (now - pendingData[ip].timestamp > DATA_TTL) {
      console.log(`Removing stale pending data for ${ip}`);
      delete pendingData[ip];
    }
  });
}, 10000);

// Example endpoint for system stats
fastify.get('/systemStats', async (req, reply) => {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  cpus.forEach(cpu => {
    totalIdle += cpu.times.idle;
    totalTick += Object.values(cpu.times).reduce((acc, time) => acc + time, 0);
  });
  const cpuUsage = (100 - (totalIdle / totalTick) * 100).toFixed(2);
  const memoryUsage = ((1 - os.freemem() / os.totalmem()) * 100).toFixed(2);
  return reply.send({
    cpuUsage: cpuUsage + "%",
    memoryUsage: memoryUsage + "%",
    workers: cpus.length
  });
});

// Start Fastify server
const start = async () => {
  try {
    await fastify.listen({ host: '0.0.0.0', port: PORT });
    console.log(`Server listening on http://localhost:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
