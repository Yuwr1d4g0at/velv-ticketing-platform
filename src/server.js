require("dotenv").config();

if (!process.env.SESSION_SECRET) {
  console.error("Missing SESSION_SECRET in the environment. Copy .env.example to .env and set one.");
  process.exit(1);
}

const app = require("./app");
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Velv Ticketing Platform listening on http://localhost:${PORT}`);
});
