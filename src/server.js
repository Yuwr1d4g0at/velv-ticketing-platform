require("dotenv").config();
const path = require("path");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");

const { attachAgent } = require("./middleware/auth");
const { csrfToken } = require("./middleware/csrf");
const publicRoutes = require("./routes/public");
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const db = require("./db"); // ensures schema is created before the server starts
const SqliteSessionStore = require("./session-store");

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";

if (!process.env.SESSION_SECRET) {
  console.error("Missing SESSION_SECRET in the environment. Copy .env.example to .env and set one.");
  process.exit(1);
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.set("trust proxy", 1); // needed for correct secure-cookie behavior behind a reverse proxy

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
      },
    },
  })
);

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.use(
  session({
    store: new SqliteSessionStore(),
    name: "velv.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: COOKIE_SECURE,
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

app.use(attachAgent(db));
app.use(csrfToken);

app.use("/dashboard", dashboardRoutes);
app.use("/", authRoutes);
app.use("/", publicRoutes);

app.use((req, res) => {
  res.status(404).render("error", { title: "Not found", message: "That page does not exist." });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).render("error", { title: "Something went wrong", message: "An unexpected error occurred. Please try again." });
});

app.listen(PORT, () => {
  console.log(`Velv Ticketing Platform listening on http://localhost:${PORT}`);
});
