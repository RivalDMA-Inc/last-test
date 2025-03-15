

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

fastify.register(rateLimit, {
  max: 20, // Maximum of 5 requests per minute
  timeWindow: '1 minute'
});

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

  // Keep the connection open for 10 seconds (long polling)
  return new Promise((resolve) => {
    pendingConnections[localIP] = pendingConnections[localIP] || [];
    pendingConnections[localIP].push(resolve);

    setTimeout(() => {
      resolve({ status: "no data" });
      pendingConnections[localIP] = pendingConnections[localIP].filter(r => r !== resolve);
    }, 20000);
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

// Frontend long polling endpoint (for updating the frontend display)
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
    }, 5000);
  });
});

// Update frontend data (in-process)
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
    console.log("Received data from web menu for C++ client:", localIP);

    if (!localIP) {
      return reply.status(400).send({ status: "Error", message: "Missing localip" });
    }

    // Store data for the C++ client with timestamp
    pendingData[localIP] = { data: parsedData, timestamp: Date.now() };

    // Notify waiting C++ clients if any and clear the pending data so it isn't sent twice
    if (pendingConnections[localIP] && pendingConnections[localIP].length > 0) {
      console.log(`Sending data to waiting C++ clients: ${localIP}`);
      pendingConnections[localIP].forEach(resolve => resolve(parsedData));
      pendingConnections[localIP] = [];
      // Clear the pending data since it has already been delivered
      delete pendingData[localIP];
    }
    
    // Update frontend clients
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
}, 25000);

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