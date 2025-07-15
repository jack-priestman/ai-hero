import { db } from "./index";
import { chats, messages } from "./schema";
import { eq, and } from "drizzle-orm";
import type { Chat, Message, NewChat } from "./schema";

// Upsert a chat (insert if new, update title if exists)
export async function upsertChat(chat: NewChat): Promise<Chat | null> {
  const [result] = await db
    .insert(chats)
    .values(chat)
    .onConflictDoUpdate({
      target: chats.id,
      set: { title: chat.title },
    })
    .returning();
  return result ?? null;
}

// Get a single chat and its messages for a user
export async function getChat(
  chatId: string,
  userId: string,
): Promise<(Chat & { messages: Message[] }) | null> {
  const chat = await db.query.chats.findFirst({
    where: and(eq(chats.id, chatId), eq(chats.userId, userId)),
    with: { messages: { orderBy: (m, { asc }) => [asc(m.order)] } },
  });
  return chat ?? null;
}

// Get all chats for a user (without messages)
export async function getChats(userId: string): Promise<Chat[]> {
  return db
    .select()
    .from(chats)
    .where(eq(chats.userId, userId))
    .orderBy(chats.createdAt);
}
