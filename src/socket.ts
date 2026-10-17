import { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import {
  clearInvoiceDraftInternal,
  getInvoiceDraftInternal,
  saveInvoiceDraftInternal,
} from "./controllers/invoiceDraft.controller";
import { CurrentUser, getUserFromToken } from "./utils/currentUser";
import { runWithTenant } from "./utils/tenantContext";
import { resolveSession } from "./auth/session";
import { canPerform } from "./auth/authorization";

const roomFor = (user: CurrentUser) =>
  `invoice-draft:${user.tenantId}:${user.userId}`;
const timestamp = (value: unknown) => {
  const parsed = new Date(String(value || "")).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

export const configureSocket = (server: HttpServer) => {
  const io = new SocketIOServer(server, {
    cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] },
  });
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== "string") throw new Error("INVALID_SESSION");
      socket.data.user = await resolveSession(token);
      if (!canPerform(socket.data.user, "draft.use"))
        throw new Error("ACTION_FORBIDDEN");
      socket.data.token = token;
      next();
    } catch {
      next(new Error("INVALID_SESSION"));
    }
  });

  io.on("connection", (socket) => {
    const user: CurrentUser = socket.data.user;
    const room = roomFor(user);
    socket.join(room);
    const expiry = getUserFromToken(socket.data.token)?.expiresAt || Date.now();
    const timeout = setTimeout(
      () => socket.disconnect(true),
      Math.max(0, Math.min(expiry - Date.now(), 2_147_483_647)),
    );
    timeout.unref();
    socket.on("disconnect", () => clearTimeout(timeout));

    socket.use(async (_packet, next) => {
      try {
        const current = await resolveSession(socket.data.token);
        if (!canPerform(current, "draft.use"))
          throw new Error("ACTION_FORBIDDEN");
        if (
          current.identityId !== user.identityId ||
          current.tenantId !== user.tenantId ||
          current.userId !== user.userId
        )
          throw new Error("INVALID_SESSION");
        next();
      } catch {
        socket.emit("invoice-draft:error", { message: "INVALID_SESSION" });
        socket.disconnect(true);
      }
    });

    // Recheck receivers too: revoked members must not keep receiving broadcasts.
    const broadcast = async (event: string, data: unknown) => {
      for (const peer of await io.in(room).fetchSockets()) {
        if (peer.id === socket.id) continue;
        try {
          const current = await resolveSession(peer.data.token);
          if (!canPerform(current, "draft.use"))
            throw new Error("ACTION_FORBIDDEN");
          if (roomFor(current) !== room) throw new Error("INVALID_SESSION");
          peer.emit(event, data);
        } catch {
          peer.disconnect(true);
        }
      }
    };

    socket.on("invoice-draft:join", () => socket.join(room));
    socket.on("invoice-draft:update", async (payload: any = {}) => {
      try {
        const draft = await runWithTenant(user.tenantId, async () => {
          const current = await getInvoiceDraftInternal(user.userId);
          if (payload.alreadySaved) return current; // Read the saved value; never broadcast a client assertion as server data.
          if (
            timestamp(current?.clearedAt) &&
            timestamp(payload.draft?.updatedAt) <= timestamp(current.clearedAt)
          )
            return current;
          return saveInvoiceDraftInternal(
            user.userId,
            payload.draft || payload,
            user.username,
          );
        });
        await broadcast("invoice-draft:changed", {
          clientId: payload.clientId,
          draft,
        });
      } catch {
        socket.emit("invoice-draft:error", {
          message: "DRAFT_SYNC_UNAVAILABLE",
        });
      }
    });
    socket.on("invoice-draft:clear", async (payload: any = {}) => {
      try {
        const draft = await runWithTenant(user.tenantId, () =>
          payload.alreadySaved
            ? getInvoiceDraftInternal(user.userId)
            : clearInvoiceDraftInternal(user.userId, user.username),
        );
        await broadcast("invoice-draft:cleared", {
          clientId: payload.clientId,
          draft,
        });
      } catch {
        socket.emit("invoice-draft:error", {
          message: "DRAFT_SYNC_UNAVAILABLE",
        });
      }
    });
  });
  return io;
};
