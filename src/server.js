import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { AlertEngine } from "./services/alertEngine.js";
import { AlertStateStore } from "./services/alertStateStore.js";
import { LiveService } from "./services/liveService.js";
import { Notifier } from "./services/notifier.js";
import { S3Service } from "./services/s3Service.js";
import { MessageStore } from "./store/messageStore.js";

const store = new MessageStore(env.limits.liveMessages);
const s3Service = new S3Service({ env, store });

// Load persisted alert rule / per-furnace limits / recipients before the
// engine and notifier read their initial state. The file is created on
// first write if absent.
const alertStateStore = new AlertStateStore();
alertStateStore.load();

const notifier = new Notifier({ env, store, stateStore: alertStateStore });

const server = http.createServer();
const io = new SocketIOServer(server, {
  cors: { origin: env.corsOrigin }
});

const alertEngine = new AlertEngine({
  env,
  store,
  io,
  notifier,
  stateStore: alertStateStore
});

// Flush pending writes on shutdown so an immediate restart doesn't lose
// edits that were still inside the debounce window.
const flushOnExit = () => alertStateStore.flushSync();
process.on("SIGINT", () => {
  flushOnExit();
  process.exit(0);
});
process.on("SIGTERM", () => {
  flushOnExit();
  process.exit(0);
});
process.on("beforeExit", flushOnExit);
const app = createApp({ env, store, s3Service, alertEngine, notifier });
server.on("request", app);

io.on("connection", (socket) => {
  socket.emit("initial_snapshot", {
    ...store.getSnapshot(),
    alerts: {
      active: alertEngine.getActiveAlerts(),
      history: alertEngine.getHistory(20),
      config: alertEngine.getConfig()
    }
  });
});

const liveService = new LiveService({ env, store, io, alertEngine });
liveService.start();

if (s3Service.isConfigured()) {
  s3Service.checkAvailability();
}

server.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`IoT testing backend running on http://localhost:${env.port}`);
  // eslint-disable-next-line no-console
  console.log(`Live source: ${env.live.url} (poll ${env.live.pollIntervalMs}ms)`);
});
