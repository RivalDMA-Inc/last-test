const fastify = require('fastify')({
  logger: { level: "error" },
  trustProxy: true,
  bodyLimit: 2048576 // 1 MB in bytes
});
const cors = require('@fastify/cors');
const path = require('path');
const fastifyStatic = require('@fastify/static');
const rateLimit = require('@fastify/rate-limit');
const cluster = require('cluster');
const os = require('os');

const PORT = process.env.PORT || 3000;
const DATA_TTL = 30000; // Data expiration time (30 seconds)

let pendingData = {};  // { localIP: { data, timestamp } }
let pendingConnections = {}; // { localIP: [resolve1, resolve2, ...] }

let pendingFrontendData = null;
let frontendConnections = [];

// Enable CORS
fastify.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
});

// Register Rate Limiting
fastify.register(rateLimit, {
  max: 5, // Maximum of 5 requests
  timeWindow: '1 minute', // Per 1 minute window
  redis: null // Optional: use Redis to persist rate limits across instances
});

// Serve static files from the "public" folder
fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/', // Files will be served at the root URL (e.g., http://localhost:3000/index.html)
});

// Health check route
fastify.get('/health', async (req, reply) => {
  return { message: "Fastify server is running!" };
});

// C++ client long polling endpoint (with IP checking)
fastify.get('/getData', async (req, reply) => {
  const localIP = req.query.localip;
  console.log("C++ client polling for data with IP:", localIP);

  if (!localIP) {
    return reply.status(400).send({ status: "Error", message: "Missing localip" });
  }

  if (pendingData[localIP]) {
    const data = pendingData[localIP].data;
    delete pendingData[localIP]; // Remove data after sending
    return reply.send(data);
  }

  return new Promise((resolve) => {
    pendingConnections[localIP] = pendingConnections[localIP] || [];
    pendingConnections[localIP].push(resolve);

    setTimeout(() => {
      resolve({ status: "no data" });
      pendingConnections[localIP] = pendingConnections[localIP].filter(r => r !== resolve);
    }, 10000);
  });
});
const getCpuUsage = () => {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  cpus.forEach(cpu => {
    totalIdle += cpu.times.idle;
    totalTick += Object.values(cpu.times).reduce((acc, time) => acc + time, 0);
  });

  const idlePercentage = (totalIdle / totalTick) * 100;
  return (100 - idlePercentage).toFixed(2);  // CPU usage percentage
};
fastify.get('/systemStats', async (req, reply) => {
  const cpuUsage = await getCpuUsage();
  const memoryUsage = ((1 - os.freemem() / os.totalmem()) * 100).toFixed(2);
  return reply.send({
    cpuUsage: cpuUsage + "%",
    memoryUsage: memoryUsage + "%",
    workers: os.cpus().length
  });
});

// Frontend long polling endpoint (no IP check)
fastify.get('/getFrontendData', async (req, reply) => {
  if (pendingFrontendData) {
    const data = pendingFrontendData;
    pendingFrontendData = null; // Clear after sending
    return reply.send(data);
  }

  return new Promise((resolve) => {
    frontendConnections.push(resolve);
    setTimeout(() => {
      resolve({ status: "no data" });
      frontendConnections = frontendConnections.filter(r => r !== resolve);
    }, 10000);
  });
});

// Update frontend data
function updateFrontend(data) {
  pendingFrontendData = data;
  if (frontendConnections.length > 0) {
    frontendConnections.forEach(resolve => resolve(data));
    frontendConnections = [];
  }
}

// Web menu sends data to server via POST /data
fastify.post('/data', async (req, reply) => {
  try {
    const parsedData = req.body;
    const localIP = parsedData.localip;

    if (!localIP) {
      return reply.status(400).send({ status: "Error", message: "Missing localip" });
    }

    // Store data for the C++ client with timestamp
    pendingData[localIP] = { data: parsedData, timestamp: Date.now() };

    // Notify waiting C++ clients if any
    if (pendingConnections[localIP] && pendingConnections[localIP].length > 0) {
      console.log(`Sending data to waiting C++ clients: ${localIP}`);
      pendingConnections[localIP].forEach(resolve => resolve(parsedData));

      pendingConnections[localIP] = [];
    }

    // Update frontend clients (no IP check)
    updateFrontend(parsedData);

    return { status: "OK" };
  } catch (error) {
    console.error("Error parsing data:", error);
    return reply.status(400).send({ status: "Error", message: "Invalid data format" });
  }
});

// Cleanup stale data every 30 seconds
setInterval(() => {
  const now = Date.now();
  Object.keys(pendingData).forEach(ip => {
    if (now - pendingData[ip].timestamp > DATA_TTL) {
      console.log(`Removing stale data for ${ip}`);
      delete pendingData[ip];
    }
  });
}, 15000);

// Start Fastify server with clustering
const start = async () => {
  if (cluster.isMaster) {
    // Fork workers for each CPU core
    const numCores = os.cpus().length;
    console.log(`Master process: Forking ${numCores} workers.`);
    for (let i = 0; i < numCores; i++) {
      cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
      console.log(`Worker ${worker.process.pid} died`);
    });
  } else {
    // Worker process will handle the requests
    try {
      await fastify.listen({ host: '0.0.0.0', port: PORT });
      console.log(`Server listening on http://localhost:${PORT} (Worker: ${process.pid})`);
    } catch (err) {
      fastify.log.error(err);
      process.exit(1);
    }
  }
};

start();
