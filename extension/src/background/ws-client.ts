import { SERVER_BASE_URL } from '../shared/config.ts';
import type { Message, PresencePayload } from '../shared/messages.ts';

function wsURLForRoom(roomId: string, hostToken?: string): string {
  const url = new URL(SERVER_BASE_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `/rooms/${roomId}/connect`;
  if (hostToken) {
    url.searchParams.set('hostToken', hostToken);
  }
  return url.toString();
}

export interface RoomConnection {
  socket: WebSocket;
  close: () => void;
}

/**
 * Called for every parsed message the room's WebSocket receives. A single
 * catch-all rather than one callback per message type — the room-manager
 * built on top of this (US-2.6 onward) is what actually knows what to do
 * with each type; this layer's job stops at "parse it and hand it over."
 */
export type RoomMessageHandler = (msg: Message) => void;

// Given a roomId (and optional hostToken), opens a WebSocket to the room
// server. Always logs to console (useful for manual dev testing, per this
// story's own "testable against a room created via curl" scope);
// `onMessage`, if provided, is how anything built on top of this actually
// reacts to messages — added now rather than retrofitted once US-2.6
// needs it, since changing this function's signature after callers exist
// is exactly the kind of rework this project has tried to avoid throughout.
export function connectToRoom(
  roomId: string,
  hostToken?: string,
  onMessage?: RoomMessageHandler,
): RoomConnection {
  const socket = new WebSocket(wsURLForRoom(roomId, hostToken));

  socket.addEventListener('open', () => {
    console.log('[CoWatch] connected to room', roomId);
  });

  socket.addEventListener('message', (event) => {
    let msg: Message;
    try {
      msg = JSON.parse(event.data as string);
    } catch (err) {
      console.error('[CoWatch] malformed message from server:', event.data, err);
      return;
    }

    if (msg.type === 'presence') {
      const payload = msg.payload as PresencePayload;
      console.log('[CoWatch] presence update:', payload.connections);
    } else {
      console.log('[CoWatch] message:', msg.type, msg.payload);
    }

    onMessage?.(msg);
  });

  socket.addEventListener('close', (event) => {
    console.log('[CoWatch] disconnected from room', roomId, 'code:', event.code);
  });

  socket.addEventListener('error', (event) => {
    console.error('[CoWatch] WebSocket error for room', roomId, event);
  });

  return {
    socket,
    close: () => socket.close(),
  };
}
