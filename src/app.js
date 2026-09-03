// The Express app itself, with no side effect of actually listening on a
// port - src/server.js does that. Split out so tests can require this
// directly and drive it with an in-process HTTP server on an ephemeral port,
// without going through the real startup script.
const path = require("path");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");

const { attachAgent } = require("./middleware/auth");
const { csrfToken } = require("./middleware/csrf");
const publicRoutes = require("./routes/public");
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const db = require("./db"); // ensures schema is created before the app is used
const SqliteSessionStore = require("./session-store");

if (!process.env.SESSION_SECRET) {
  // The friendly, exit(1)-with-a-message version of this check lives in
  // server.js, which is what a human actually runs. Anything requiring this
  // module directly (tests included) is expected to have set it already.
  throw new Error("Missing SESSION_SECRET in the environment.");
}

const app = express();
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";

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

module.exports = app;
