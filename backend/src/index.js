require("dotenv").config();

const { ready, startServer } = require("../index");

ready
  .then(startServer)
  .catch(err => {
    console.error("Backend startup failed:", err.message);
    process.exit(1);
  });
