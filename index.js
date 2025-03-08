const fastify = require('fastify')({ logger: { level: "error" }, trustProxy: true });
const cors = require('@fastify/cors');

const PORT = process.env.PORT || 3000;
const DATA_TTL = 30000; // Data expiration time (30 seconds)

let pendingData = {};  // { localIP: { data, timestamp } }
let pendingConnections = {}; // { localIP: [res1, res2, ...] }

// Enable CORS
fastify.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
});

// C++ client long polling for data
fastify.get('/getData', async (req, reply) => {
  const localIP = req.query.localip;
  console.log("Client polling for data with IP:", localIP);

  if (!localIP) {
    return reply.status(400).send({ status: "Error", message: "Missing localip" });
  }

  if (pendingData[localIP]) {
    const data = pendingData[localIP].data;
    delete pendingData[localIP]; // Remove data after sending
    return reply.send(data);
  }

  // Keep connection open for 10 seconds (long polling)
  return new Promise((resolve) => {
    pendingConnections[localIP] = pendingConnections[localIP] || [];
    pendingConnections[localIP].push(resolve);

    setTimeout(() => {
      resolve({ status: "no data" });
      pendingConnections[localIP] = pendingConnections[localIP].filter(r => r !== resolve);
    }, 10000);
  });
});

// Web menu sends data to server
fastify.post('/data', async (req, reply) => {
  try {
    const parsedData = req.body;
    const localIP = parsedData.localip;
    console.log("Received data from web menu for C++ client:", localIP);

    if (!localIP) {
      return reply.status(400).send({ status: "Error", message: "Missing localip" });
    }

    // Store data with timestamp
    pendingData[localIP] = { data: parsedData, timestamp: Date.now() };

    // Send data to waiting clients if any
    if (pendingConnections[localIP] && pendingConnections[localIP].length > 0) {
      console.log(`Sending data to waiting C++ clients: ${localIP}`);
      pendingConnections[localIP].forEach(response => response(parsedData));
      pendingConnections[localIP] = [];
    }

    return { status: "OK" };
  } catch (error) {
    console.error("Error parsing data:", error);
    return reply.status(400).send({ status: "Error", message: "Invalid data format" });
  }
});

// Cleanup old data every 30 seconds
setInterval(() => {
  const now = Date.now();
  Object.keys(pendingData).forEach(ip => {
    if (now - pendingData[ip].timestamp > DATA_TTL) {
      console.log(`Removing stale data for ${ip}`);
      delete pendingData[ip];
    }
  });
}, 30000);

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
